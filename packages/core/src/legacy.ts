/**
 * The legacy bridge: v0.39 workspace JSON in, flat Workspace out, and back again.
 *
 * This module is the whole reason the migration can be incremental. While it holds, both apps
 * read and write the same files, the single-file app keeps shipping, and a user can move between
 * them without noticing. When it stops holding, the strangler is broken — so `roundTrip` is
 * exercised against the real demo workspace in the tests, not against a fixture written to pass.
 *
 * WHAT IS DELIBERATELY NOT PRESERVED
 * Camera and furniture: drillPath, chartZoom, chartPos, chartSize, view pan/zoom, showTable,
 * bizGallery, rosterMode, viewMode, activeChartId. They are per-person view state, not the
 * document — the legacy app already excludes them from its undo signature for the same reason,
 * and in a shared document they would mean one person's scroll position yanking everyone else's.
 * They move to per-user client state. Everything that is CONTENT survives byte-for-byte.
 */

import { z } from 'zod';
import { ACTORS, COLS, TIER_LABELS } from './constants.js';
import { keysBetween } from './fractional.js';
import { keepOrMint, newId } from './ids.js';
import {
  Artifact,
  Chart,
  chartColumns,
  ChartNode,
  Entity,
  Flow,
  FlowEdge,
  FlowGroup,
  FlowStep,
  Meta,
  OrgRef,
  Workspace,
  type Roster,
} from './schema.js';

// ---- the legacy shape ---------------------------------------------------------------------------
// Loose on purpose. These files come from browsers going back many versions, and the legacy
// migrateState() is itself forgiving — anything it repaired rather than rejected has to arrive
// here and be repaired the same way, not thrown out.

const LegacyUnknownRecord = z.record(z.string(), z.unknown());

export const LegacyWorkspace = z
  .object({
    charts: z.array(LegacyUnknownRecord).optional(),
    bizCases: z.array(LegacyUnknownRecord).optional(),
    artifacts: z.array(LegacyUnknownRecord).optional(),
    entities: z.array(LegacyUnknownRecord).optional(),
    directorates: LegacyUnknownRecord.optional(),
    actorLabels: z.record(z.string(), z.string()).optional(),
    columnLabels: z.record(z.string(), z.string()).optional(),
    columnShort: z.record(z.string(), z.string()).optional(),
    columnActor: z.record(z.string(), z.unknown()).optional(),
    // Pre-multi-chart files carried one chart's fields at the top level.
    title: z.string().optional(),
    activities: z.array(LegacyUnknownRecord).optional(),
  })
  .passthrough();

export type LegacyWorkspace = z.infer<typeof LegacyWorkspace>;

export interface ImportReport {
  readonly charts: number;
  readonly nodes: number;
  readonly flows: number;
  readonly steps: number;
  readonly artifacts: number;
  readonly entities: number;
  /** Things that were repaired rather than rejected. Surfaced to the user after an import. */
  readonly warnings: string[];
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const bool = (v: unknown, fallback = false): boolean => (typeof v === 'boolean' ? v : fallback);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function parseMeta(v: unknown): Meta {
  const m = rec(v);
  return Meta.parse({
    description: str(m.description),
    customer: str(m.customer).trim(),
    priority: str(m.priority),
    budget: str(m.budget).trim(),
    tags: arr(m.tags).filter((t): t is string => typeof t === 'string' && t.length > 0),
  });
}

function parseOrgRef(v: unknown): OrgRef | null {
  const r = rec(v);
  if (typeof r.entityId === 'string' && r.entityId) return { entityId: r.entityId };
  if (typeof r.actor !== 'string' || !(ACTORS as readonly string[]).includes(r.actor)) return null;
  const parsed = OrgRef.safeParse({
    actor: r.actor,
    divisionId: typeof r.divisionId === 'string' && r.divisionId ? r.divisionId : undefined,
    branchId: typeof r.branchId === 'string' && r.branchId ? r.branchId : undefined,
    teamId: typeof r.teamId === 'string' && r.teamId ? r.teamId : undefined,
  });
  return parsed.success ? parsed.data : null;
}

function parseLead(v: unknown): { id: string; name: string } | null {
  const l = rec(v);
  if (typeof l.name !== 'string') return null;
  return { id: keepOrMint('person', l.id), name: l.name };
}

function parseDocs(v: unknown): { id: string; name: string; type: string; size: number }[] {
  return arr(v)
    .map(rec)
    .filter((d) => typeof d.id === 'string' && d.id)
    .map((d) => ({
      id: d.id as string,
      name: str(d.name),
      type: str(d.type),
      size: num(d.size),
    }));
}

// ---- import: legacy JSON -> Workspace --------------------------------------------------------------

/**
 * Flatten one legacy chart's nested `activities` into the node map.
 *
 * Order keys are minted by bisection per sibling group, so an 800-row chart gets short keys and
 * the array order it arrived in is preserved exactly.
 */
function flattenActivities(
  chartId: string,
  activities: unknown[],
  columns: readonly string[],
  warnings: string[],
): Record<string, ChartNode> {
  const nodes: Record<string, ChartNode> = {};
  const seen = new Set<string>();

  const walk = (list: unknown[], parentId: string | null, depth: number) => {
    const items = list.map(rec);
    const orders = keysBetween(null, null, items.length);
    items.forEach((raw, i) => {
      let id = keepOrMint('node', raw.id);
      if (seen.has(id)) {
        // Two rows sharing an id would silently merge into one. Mint a new one for the later
        // arrival and say so, rather than dropping a row on the floor.
        const fresh = newId('node');
        warnings.push(`duplicate node id ${id} — the second row was re-minted as ${fresh}`);
        id = fresh;
      }
      seen.add(id);

      const raciIn = rec(raw.raci);
      const raci: Record<string, string> = {};
      for (const key of Object.keys(raciIn)) {
        const cell = str(raciIn[key]);
        if (cell) raci[key] = cell;
      }
      // A free-form chart owns its column set outright, so letters left behind by a deleted
      // column are dropped. An org chart keeps everything: its columns are fixed, and an unknown
      // key means a file from a future version, which is not ours to discard.
      if (columns !== COLS) {
        for (const key of Object.keys(raci)) {
          if (!columns.includes(key)) delete raci[key];
        }
      }

      const node = ChartNode.parse({
        id,
        chartId,
        parentId,
        order: orders[i]!,
        name: str(raw.name),
        raci,
        primaryR: typeof raw.primaryR === 'string' && raw.primaryR ? raw.primaryR : null,
        org: parseOrgRef(raw.org),
        description: str(raw.description),
        documents: parseDocs(raw.documents),
        inputs: arr(raw.inputs).filter((x): x is string => typeof x === 'string'),
        outputs: arr(raw.outputs).filter((x): x is string => typeof x === 'string'),
      });
      nodes[id] = node;

      const children = arr(raw.children);
      if (children.length > 0) walk(children, id, depth + 1);
    });
  };

  walk(activities, null, 0);
  return nodes;
}

function importChart(raw: Record<string, unknown>, warnings: string[]): Chart {
  const id = keepOrMint('chart', raw.id);
  const customIn = rec(raw.custom);
  const custom =
    raw.custom && typeof raw.custom === 'object'
      ? {
          cols: arr(customIn.cols)
            .map(rec)
            .filter((c) => typeof c.key === 'string' && c.key)
            .map((c) => ({ key: c.key as string, label: str(c.label, 'Party'), short: str(c.short) })),
          tiers: arr(customIn.tiers).map((t) => str(t)),
        }
      : null;

  const columns = custom ? custom.cols.map((c) => c.key) : COLS;
  const framework = str(raw.framework) === 'rasci' ? 'rasci' : 'raci';

  return Chart.parse({
    id,
    title: str(raw.title, 'Untitled chart'),
    framework,
    status: str(raw.status) === 'final' ? 'final' : 'draft',
    finalizedAt: typeof raw.finalizedAt === 'string' ? raw.finalizedAt : null,
    meta: parseMeta(raw.meta),
    custom,
    nodes: flattenActivities(id, arr(raw.activities), columns, warnings),
  });
}

function importFlow(raw: Record<string, unknown>, warnings: string[]): Flow {
  const id = keepOrMint('flow', raw.id);

  const steps: Record<string, FlowStep> = {};
  for (const t of arr(raw.tasks).map(rec)) {
    const stepId = keepOrMint('step', t.id);
    const isSub = str(t.kind) === 'subflow';
    const partiesIn = rec(t.parties);
    const parties: Record<string, OrgRef> = {};
    for (const key of Object.keys(partiesIn)) {
      const ref = parseOrgRef(partiesIn[key]);
      if (ref) parties[key] = ref;
    }
    const raciIn = rec(t.raci);
    const raci: Record<string, string> = {};
    for (const key of Object.keys(raciIn)) {
      const cell = str(raciIn[key]);
      if (cell) raci[key] = cell;
    }
    const bindIn = rec(t.bind);
    const portsIn = rec(t.ports);

    steps[stepId] = FlowStep.parse({
      id: stepId,
      flowId: id,
      kind: isSub ? 'subflow' : 'step',
      refId: typeof t.refId === 'string' && t.refId ? t.refId : null,
      name: str(t.name),
      description: str(t.description),
      entry: str(t.entry),
      exit: str(t.exit),
      x: num(t.x),
      y: num(t.y),
      groupId: typeof t.groupId === 'string' && t.groupId ? t.groupId : null,
      raci,
      parties,
      bind:
        typeof bindIn.chartId === 'string' && typeof bindIn.nodeId === 'string'
          ? { chartId: bindIn.chartId, nodeId: bindIn.nodeId }
          : null,
      ports: {
        in: arr(portsIn.in).filter((p): p is string => typeof p === 'string'),
        out: arr(portsIn.out).filter((p): p is string => typeof p === 'string'),
      },
    });
  }

  const edges: Record<string, FlowEdge> = {};
  for (const e of arr(raw.edges).map(rec)) {
    const from = str(e.from);
    const to = str(e.to);
    if (!steps[from] || !steps[to]) {
      // The legacy app drops these on load too — an edge to a step that is gone cannot be drawn.
      warnings.push(`handoff in "${str(raw.name, 'Untitled')}" pointed at a missing step; dropped`);
      continue;
    }
    const edgeId = keepOrMint('edge', e.id);
    edges[edgeId] = FlowEdge.parse({
      id: edgeId,
      flowId: id,
      from,
      to,
      fromPort: typeof e.fromPort === 'string' && e.fromPort ? e.fromPort : null,
      toPort: typeof e.toPort === 'string' && e.toPort ? e.toPort : null,
      label: str(e.label),
      artifactIds: arr(e.artifactIds).filter((x): x is string => typeof x === 'string'),
      via: arr(e.via)
        .map(rec)
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
        .slice(0, 24)
        .map((p) => ({ x: Math.round(p.x as number), y: Math.round(p.y as number) })),
    });
  }

  const groups: Record<string, FlowGroup> = {};
  for (const g of arr(raw.groups).map(rec)) {
    const groupId = keepOrMint('group', g.id);
    groups[groupId] = FlowGroup.parse({
      id: groupId,
      flowId: id,
      name: str(g.name),
      color: str(g.color, 'p'),
      collapsed: bool(g.collapsed),
      x: num(g.x),
      y: num(g.y),
    });
  }

  const anchorIn = rec(raw.anchor);
  return Flow.parse({
    id,
    name: str(raw.name, 'Untitled business case'),
    meta: parseMeta(raw.meta),
    framework: 'raci', // v0.34: a file naming DACI or RAPID loads as RACI
    mode: str(raw.mode) === 'linked' ? 'linked' : 'free',
    sourceChartId: typeof raw.sourceChartId === 'string' && raw.sourceChartId ? raw.sourceChartId : null,
    status: str(raw.status) === 'final' ? 'final' : 'draft',
    finalizedAt: typeof raw.finalizedAt === 'string' ? raw.finalizedAt : null,
    anchor:
      typeof anchorIn.chartId === 'string' && typeof anchorIn.nodeId === 'string'
        ? { chartId: anchorIn.chartId, nodeId: anchorIn.nodeId }
        : null,
    steps,
    edges,
    groups,
  });
}

function importRoster(raw: unknown): Roster {
  const src = rec(raw);
  const roster: Record<string, unknown> = {};
  for (const actor of ACTORS) {
    const d = rec(src[actor]);
    roster[actor] = {
      lead: parseLead(d.lead),
      externalId: null,
      divisions: arr(d.divisions)
        .map(rec)
        .map((dv) => ({
          id: keepOrMint('division', dv.id),
          name: str(dv.name),
          chief: parseLead(dv.chief),
          externalId: null,
          branches: arr(dv.branches)
            .map(rec)
            .map((br) => ({
              id: keepOrMint('branch', br.id),
              name: str(br.name),
              chief: parseLead(br.chief),
              externalId: null,
              teams: arr(br.teams)
                .map(rec)
                .map((tm) => ({
                  id: keepOrMint('team', tm.id),
                  name: str(tm.name),
                  chief: parseLead(tm.chief),
                  externalId: null,
                  people: arr(tm.people)
                    .map(rec)
                    .map((p) => ({
                      id: keepOrMint('person', p.id),
                      name: str(p.name),
                      title: str(p.title),
                      externalId: null,
                      email: null,
                    })),
                })),
            })),
        })),
    };
  }
  return roster as Roster;
}

/** Read a legacy workspace file into the flat model. */
export function importLegacy(input: unknown): { workspace: Workspace; report: ImportReport } {
  const warnings: string[] = [];
  const parsed = LegacyWorkspace.safeParse(input);
  if (!parsed.success) {
    throw new Error(`not a recognizable workspace file: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }
  const raw = parsed.data;

  // Pre-multi-chart files carried a single chart's fields at the top level.
  const legacyCharts =
    raw.charts && raw.charts.length > 0
      ? raw.charts
      : [{ title: raw.title ?? 'Untitled chart', activities: raw.activities ?? [] }];

  const charts: Record<string, Chart> = {};
  for (const c of legacyCharts) {
    const chart = importChart(c as Record<string, unknown>, warnings);
    charts[chart.id] = chart;
  }

  const chartOrder: Record<string, string> = {};
  const orderKeys = keysBetween(null, null, Object.keys(charts).length);
  Object.keys(charts).forEach((id, i) => {
    chartOrder[id] = orderKeys[i]!;
  });

  const flows: Record<string, Flow> = {};
  for (const f of raw.bizCases ?? []) {
    const flow = importFlow(f as Record<string, unknown>, warnings);
    flows[flow.id] = flow;
  }

  const artifacts: Record<string, Artifact> = {};
  for (const a of (raw.artifacts ?? []).map(rec)) {
    const id = keepOrMint('artifact', a.id);
    const docIn = rec(a.doc);
    artifacts[id] = Artifact.parse({
      id,
      name: str(a.name, 'Untitled deliverable'),
      type: str(a.type, 'other'),
      ownerRef: parseOrgRef(a.ownerRef),
      description: str(a.description),
      doc:
        typeof docIn.id === 'string' && docIn.id
          ? { id: docIn.id, name: str(docIn.name), type: str(docIn.type), size: num(docIn.size) }
          : null,
    });
  }

  const entities: Record<string, Entity> = {};
  for (const e of (raw.entities ?? []).map(rec)) {
    const id = keepOrMint('entity', e.id);
    entities[id] = Entity.parse({
      id,
      name: str(e.name),
      kind: str(e.kind, 'other'),
      short: str(e.short),
      description: str(e.description),
      lead: parseLead(e.lead),
    });
  }

  // Deliverable refs that point at nothing are dropped, matching the legacy loader: the invariant
  // is that no reference outlives its registry entry.
  const artifactIds = new Set(Object.keys(artifacts));
  const keepRefs = (ids: string[]) => ids.filter((x) => artifactIds.has(x));
  let droppedRefs = 0;
  for (const chart of Object.values(charts)) {
    for (const node of Object.values(chart.nodes)) {
      const before = node.inputs.length + node.outputs.length;
      node.inputs = keepRefs(node.inputs);
      node.outputs = keepRefs(node.outputs);
      droppedRefs += before - (node.inputs.length + node.outputs.length);
    }
  }
  for (const flow of Object.values(flows)) {
    for (const edge of Object.values(flow.edges)) {
      const before = edge.artifactIds.length;
      edge.artifactIds = keepRefs(edge.artifactIds);
      droppedRefs += before - edge.artifactIds.length;
    }
  }
  if (droppedRefs > 0) {
    warnings.push(`${droppedRefs} deliverable reference(s) pointed at nothing and were dropped`);
  }

  const columnActor: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec(raw.columnActor))) {
    if (typeof v === 'string') columnActor[k] = v;
  }

  const workspace = Workspace.parse({
    schemaVersion: 1,
    charts,
    chartOrder,
    flows,
    artifacts,
    entities,
    roster: importRoster(raw.directorates),
    actorLabels: raw.actorLabels ?? {},
    columnLabels: raw.columnLabels ?? {},
    columnShort: raw.columnShort ?? {},
    columnActor,
  });

  const nodeCount = Object.values(charts).reduce((n, c) => n + Object.keys(c.nodes).length, 0);
  const stepCount = Object.values(flows).reduce((n, f) => n + Object.keys(f.steps).length, 0);

  return {
    workspace,
    report: {
      charts: Object.keys(charts).length,
      nodes: nodeCount,
      flows: Object.keys(flows).length,
      steps: stepCount,
      artifacts: Object.keys(artifacts).length,
      entities: Object.keys(entities).length,
      warnings,
    },
  };
}

// ---- export: Workspace -> legacy JSON ---------------------------------------------------------------

/**
 * Rebuild one chart's nested `activities` array from the flat node map.
 *
 * The legacy app materializes EVERY column on every row, empty cells included, because its
 * renderer indexes `node.raci[col]` directly. We store cells sparsely — seven empty strings per
 * row across 810 rows is a lot of nothing to put in a CRDT, and a missing cell and an empty cell
 * mean the same thing — so the full set is filled back in here, at the boundary that has to match.
 */
function nestNodes(chart: Chart): unknown[] {
  const columns = chartColumns(chart);
  const byParent = new Map<string | null, ChartNode[]>();
  for (const node of Object.values(chart.nodes)) {
    const list = byParent.get(node.parentId);
    if (list) list.push(node);
    else byParent.set(node.parentId, [node]);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => (a.order === b.order ? a.id.localeCompare(b.id) : a.order < b.order ? -1 : 1));
  }

  const seen = new Set<string>();
  const build = (parentId: string | null): unknown[] =>
    (byParent.get(parentId) ?? [])
      .filter((n) => !seen.has(n.id) && seen.add(n.id))
      .map((n) => {
        const raci: Record<string, string> = {};
        for (const col of columns) raci[col] = n.raci[col] ?? '';
        // A letter parked under a column this chart no longer has (an RASCI cell after a column
        // was deleted, a key from a newer version) rides along rather than being dropped here —
        // discarding data on the way OUT of the system would be the worst place to do it.
        for (const key of Object.keys(n.raci)) {
          if (!(key in raci)) raci[key] = n.raci[key]!;
        }
        const out: Record<string, unknown> = {
          id: n.id,
          name: n.name,
          raci,
          description: n.description,
          documents: n.documents.map((d) => ({ ...d })),
          inputs: [...n.inputs],
          outputs: [...n.outputs],
          children: build(n.id),
        };
        if (n.primaryR) out.primaryR = n.primaryR;
        if (n.org) out.org = { ...n.org };
        return out;
      });

  return build(null);
}

/**
 * Write the workspace back out in the shape the single-file app reads.
 *
 * This is what keeps the two apps interoperable during the migration: whatever the Nuxt app has
 * been editing can be handed back to index.html and opened.
 */
export function exportLegacy(ws: Workspace): Record<string, unknown> {
  const chartIds = Object.keys(ws.charts).sort((a, b) => {
    const oa = ws.chartOrder[a] ?? '';
    const ob = ws.chartOrder[b] ?? '';
    return oa === ob ? a.localeCompare(b) : oa < ob ? -1 : 1;
  });

  const charts = chartIds.map((id) => {
    const c = ws.charts[id]!;
    const out: Record<string, unknown> = {
      id: c.id,
      title: c.title,
      framework: c.framework,
      status: c.status,
      finalizedAt: c.finalizedAt,
      meta: { ...c.meta, tags: [...c.meta.tags] },
      custom: c.custom ? { cols: c.custom.cols.map((x) => ({ ...x })), tiers: [...c.custom.tiers] } : null,
      activities: nestNodes(c),
      // Camera state is per-person and is not carried in the shared document; the legacy app
      // repairs these to defaults on load.
      drillPath: [],
      chartSize: null,
      chartZoom: 1,
      chartPos: {},
    };
    return out;
  });

  const bizCases = Object.values(ws.flows).map((f) => ({
    id: f.id,
    name: f.name,
    meta: { ...f.meta, tags: [...f.meta.tags] },
    framework: f.framework,
    mode: f.mode,
    sourceChartId: f.sourceChartId,
    status: f.status,
    finalizedAt: f.finalizedAt,
    anchor: f.anchor ? { ...f.anchor } : null,
    tasks: Object.values(f.steps).map((s) => {
      const out: Record<string, unknown> = {
        id: s.id,
        name: s.name,
        description: s.description,
        entry: s.entry,
        exit: s.exit,
        x: s.x,
        y: s.y,
        groupId: s.groupId,
        raci: { ...s.raci },
        parties: Object.fromEntries(Object.entries(s.parties).map(([k, v]) => [k, { ...v }])),
        bind: s.bind ? { ...s.bind } : null,
      };
      if (s.kind === 'subflow') {
        out.kind = 'subflow';
        out.refId = s.refId;
        out.ports = { in: [...s.ports.in], out: [...s.ports.out] };
      }
      return out;
    }),
    edges: Object.values(f.edges).map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      fromPort: e.fromPort,
      toPort: e.toPort,
      label: e.label,
      artifactIds: [...e.artifactIds],
      via: e.via.map((v) => ({ ...v })),
    })),
    groups: Object.values(f.groups).map((g) => ({
      id: g.id,
      name: g.name,
      color: g.color,
      collapsed: g.collapsed,
      x: g.x,
      y: g.y,
    })),
    view: { panX: 0, panY: 0, zoom: 1 },
    showTable: false,
  }));

  const directorates: Record<string, unknown> = {};
  for (const actor of ACTORS) {
    const d = ws.roster[actor];
    directorates[actor] = {
      lead: d?.lead ?? null,
      divisions: (d?.divisions ?? []).map((dv) => ({
        id: dv.id,
        name: dv.name,
        chief: dv.chief,
        branches: dv.branches.map((br) => ({
          id: br.id,
          name: br.name,
          chief: br.chief,
          teams: br.teams.map((tm) => ({
            id: tm.id,
            name: tm.name,
            chief: tm.chief,
            people: tm.people.map((p) => ({ id: p.id, name: p.name, title: p.title })),
          })),
        })),
      })),
    };
  }

  return {
    charts,
    activeChartId: chartIds[0] ?? null,
    bizCases,
    activeBizCaseId: bizCases[0]?.id ?? null,
    artifacts: Object.values(ws.artifacts).map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      ownerRef: a.ownerRef ? { ...a.ownerRef } : null,
      description: a.description,
      doc: a.doc ? { ...a.doc } : null,
    })),
    entities: Object.values(ws.entities).map((e) => ({
      id: e.id,
      name: e.name,
      kind: e.kind,
      short: e.short,
      description: e.description,
      lead: e.lead,
    })),
    directorates,
    actorLabels: { ...ws.actorLabels },
    columnLabels: { ...ws.columnLabels },
    columnShort: { ...ws.columnShort },
    columnActor: { ...ws.columnActor },
    collapsedDirectorates: {},
    workScope: null,
    bizGallery: true,
    rosterMode: 'explore',
    viewMode: 'chart',
    showLegend: false,
  };
}

/** Tier label for a chart at `depth`, org or free-form. */
export function tierLabel(chart: Pick<Chart, 'custom'>, depth: number): string {
  if (!chart.custom) return TIER_LABELS[Math.min(depth, TIER_LABELS.length - 1)]!;
  return chart.custom.tiers[depth] || `Level ${depth + 1}`;
}
