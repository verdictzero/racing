/**
 * The document as index.html's rule pass sees it.
 *
 * The violation rules are a port, not a redesign: chart-rules.ts is `recomputeViolations` and
 * flow-rules.ts is `lintFlow`, rule for rule, message for message, and a parity test pins both to
 * the legacy app's own output (violations.test.ts). What makes a straight port harder than it looks
 * is that the legacy rules never see a file as it was saved. They see it after `migrateState` has
 * repaired it on load, and they read it through a dozen small helpers — `chartCols`,
 * `chartColLabel`, `inheritedOwnerColIn`, `bizAnchorCtx`, `bizBindCtx`, `bizStepRaci` and the rest —
 * each of which has an opinion. This module is those helpers, and those repairs.
 *
 * WHY THE REPAIRS ARE APPLIED HERE, AND NOT ONLY ON IMPORT
 * A workspace here is not only ever an imported file. It is a live CRDT document that two people can
 * edit into shapes the legacy loader would never let stand — a handoff duplicated by two concurrent
 * drags, an anchor left dangling by a delete on the far side of a merge. index.html cannot hold
 * those shapes at all, so its rules never meet them. Reading through the same repairs here makes the
 * rules give the answer index.html would give the moment it loaded this document, whatever route the
 * document took to its current shape:
 *
 *   - a cell is normalized before it is read (`ar` reads as `RA`), and only the chart's own columns
 *     are read;
 *   - a free-form chart's columns are de-duplicated and their labels trimmed, and a column list with
 *     nothing usable in it makes the chart an organization chart;
 *   - an organization chart ends at its fourth tier: anything below it is not in the tree;
 *   - a flow anchor that does not resolve is no anchor, and a source chart that is missing or
 *     free-form is no source chart;
 *   - a nested-flow box that nests its own flow points at nothing;
 *   - a handoff to a missing step, a self-loop, and the second of two identical connections do not
 *     exist;
 *   - a bound step's column overrides are the org columns it lists, each once.
 *
 * ONE QUIRK, REPRODUCED ON PURPOSE
 * The legacy `primaryRColumn` reads the ACTIVE chart's columns, whichever chart it is resolving a
 * cascade in. So what a flow anchored in one chart inherits depends on which chart tab is in front:
 * with a free-form chart in front, an organization chart's rows have no column the helper can see,
 * and the cascade into the flow is empty. It is almost certainly an accident. It is kept anyway,
 * because the point of this code is that both apps say the same thing about the same document — so
 * the flow rules take the active chart as an input (`createLintContext`), exactly as the source does.
 */

import {
  ACTORS,
  COLS,
  COL_LABELS_DEFAULT,
  MAX_TIER,
  TIER_LABELS,
  framework,
  type Actor,
  type ColKey,
  type Framework,
} from './constants.js';
import { normalizeRaci } from './raci.js';
import { childIndex, childrenIn } from './tree.js';
import type { Chart, ChartNode, Flow, FlowEdge, FlowStep, Workspace } from './schema.js';

const isOrgColumn = (key: string): key is ColKey => (COLS as readonly string[]).includes(key);
const isActor = (key: string): key is Actor => (ACTORS as readonly string[]).includes(key);

/**
 * An own entry of a record, never something off Object.prototype. Ids and column keys are user data
 * as far as this code knows, and `record['constructor']` is not a chart.
 */
export function ownEntry<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** A cell the way the legacy rules read it: normalized, and empty when there is no such cell. */
export function cellLetters(raci: Readonly<Record<string, string>>, column: string): string {
  return normalizeRaci(ownEntry(raci, column));
}

// ---- charts ---------------------------------------------------------------------------------------

/** A chart's shape as the legacy loader leaves it (`normalizeChartCustom`, `chartCols`). */
export interface LegacyChartShape {
  /** A free-form chart. False for an org chart, and for a free-form one with no usable column. */
  readonly free: boolean;
  /** Its party columns: its own, first occurrence of each key, or the seven org columns. */
  readonly columns: readonly string[];
  /** The deepest tier a row can sit at. The loader drops anything below it. */
  readonly maxTier: number;
}

export function legacyChartShape(chart: Pick<Chart, 'custom'>): LegacyChartShape {
  if (chart.custom) {
    const columns = [...new Set(chart.custom.cols.map((c) => c.key).filter((k) => k.length > 0))];
    if (columns.length > 0) return { free: true, columns, maxTier: Number.POSITIVE_INFINITY };
  }
  return { free: false, columns: COLS, maxTier: MAX_TIER };
}

/**
 * `COL_LABELS[key]`: an org column's label, the workspace's own unless it is blank. Undefined for
 * anything that is not an org column — which the flow rules print, verbatim, as "undefined" (see
 * `flowOwnerOverride`), because index.html does.
 */
export function orgColumnLabel(
  labels: Readonly<Record<string, string>>,
  column: string,
): string | undefined {
  if (!isOrgColumn(column)) return undefined;
  const own = ownEntry(labels, column);
  return own && own.trim() ? own : COL_LABELS_DEFAULT[column];
}

/**
 * `chartColLabel(key, chart)`: a free-form chart's own label for its column, else the org label,
 * else the key itself — so a primary R naming a column the chart does not have still prints.
 */
export function chartColumnLabel(
  chart: Pick<Chart, 'custom'>,
  labels: Readonly<Record<string, string>>,
  column: string,
): string {
  if (legacyChartShape(chart).free) {
    const own = chart.custom?.cols.find((c) => c.key === column);
    if (own) return own.label.trim() || 'Party';
  }
  return orgColumnLabel(labels, column) ?? column;
}

/**
 * `chartTierLabel(tier, chart)`. Not `tierLabel` from legacy.ts: the two disagree past the last
 * named level and on untrimmed names, and the rules have to print what index.html prints.
 */
export function chartTierLabel(chart: Pick<Chart, 'custom'>, tier: number): string {
  if (legacyChartShape(chart).free) {
    // The loader keeps the first 64 level names and drops the rest.
    const name = tier < 64 ? chart.custom?.tiers[tier] : undefined;
    return name && name.trim() ? name.trim() : `Level ${tier + 1}`;
  }
  return TIER_LABELS[tier] ?? `Level ${tier}`;
}

/** One row of a chart, where the legacy tree has it. */
export interface TreeRow {
  readonly node: ChartNode;
  /** 0 for a top-tier row. */
  readonly depth: number;
  readonly parent: TreeRow | null;
  /** No children in the legacy tree — which a row at an org chart's last tier never has. */
  readonly leaf: boolean;
}

export interface LegacyTree {
  /** Every row the legacy tree holds, depth-first in display order: `activities` walked. */
  readonly rows: readonly TreeRow[];
  readonly byId: ReadonlyMap<string, TreeRow>;
}

/**
 * The chart's nested tree, rebuilt from the flat node map as the legacy loader would hold it.
 *
 * Only rows reachable from the top are in it, in sibling order, and an org chart stops at Task: a
 * deeper row is dropped by `normalizeNodes`, which also makes its Task parent a leaf.
 */
export function legacyTree(chart: Chart): LegacyTree {
  const { maxTier } = legacyChartShape(chart);
  const index = childIndex(chart.nodes);
  const rows: TreeRow[] = [];
  const byId = new Map<string, TreeRow>();
  const walk = (parentId: string | null, parent: TreeRow | null, depth: number): void => {
    for (const node of childrenIn(index, parentId)) {
      if (byId.has(node.id)) continue; // a merge can loop a parent chain; never walk it twice
      const children = depth >= maxTier ? [] : childrenIn(index, node.id);
      const row: TreeRow = { node, depth, parent, leaf: children.length === 0 };
      rows.push(row);
      byId.set(node.id, row);
      if (children.length > 0) walk(node.id, row, depth + 1);
    }
  };
  walk(null, null, 0);
  return { rows, byId };
}

/**
 * `primaryRColumn`: the one R column that cascades down to become the children's owner — the only
 * one there is, or the designated primary when there are several. Null when there is none, or when
 * several have no valid primary: the cascade then passes through from the nearest ancestor.
 *
 * The letter is R, not the framework's doer: the legacy helper hard-codes it (every chart framework
 * uses R for the doer, so they agree).
 */
export function primaryRColumn(node: ChartNode, columns: readonly string[]): string | null {
  const doers = columns.filter((k) => cellLetters(node.raci, k).includes('R'));
  if (doers.length === 0) return null;
  if (doers.length === 1) return doers[0]!;
  return node.primaryR && doers.includes(node.primaryR) ? node.primaryR : null;
}

/** The chart tabs in order. What the legacy file's `charts` array is (see `exportLegacy`). */
export function chartsInOrder(ws: Pick<Workspace, 'charts' | 'chartOrder'>): Chart[] {
  return Object.values(ws.charts).sort((a, b) => {
    const oa = ownEntry(ws.chartOrder, a.id) ?? '';
    const ob = ownEntry(ws.chartOrder, b.id) ?? '';
    return oa === ob ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : oa < ob ? -1 : 1;
  });
}

/** `ac()`: the chart asked for, or — when there is no such chart — the first tab. */
export function resolveActiveChart(
  ws: Pick<Workspace, 'charts' | 'chartOrder'>,
  chartId?: string | null,
): Chart | null {
  const asked = chartId ? ownEntry(ws.charts, chartId) : undefined;
  return asked ?? chartsInOrder(ws)[0] ?? null;
}

/** `abc()`: the flow asked for, or — when there is no such flow — the first one. */
export function resolveActiveFlow(
  ws: Pick<Workspace, 'flows'>,
  flowId?: string | null,
): Flow | null {
  const asked = flowId ? ownEntry(ws.flows, flowId) : undefined;
  return asked ?? Object.values(ws.flows)[0] ?? null;
}

// ---- flows ----------------------------------------------------------------------------------------

/**
 * The flow a nested-flow box points at, as the loader leaves the reference: a box nesting its own
 * flow is cleared to point at nothing, since the embed is meaningless and the editor refuses it.
 */
export function subflowRefId(flow: Pick<Flow, 'id'>, step: Pick<FlowStep, 'refId'>): string {
  return step.refId && step.refId !== flow.id ? step.refId : '';
}

/**
 * `bizTaskLabel`: the name a step carries everywhere. A nested-flow box falls back to the name of
 * the flow it points at, and to "Untitled" when that is gone too.
 */
export function stepLabel(ws: Pick<Workspace, 'flows'>, flow: Flow, step: FlowStep): string {
  if (step.kind === 'subflow') {
    const refId = subflowRefId(flow, step);
    const ref = refId ? ownEntry(ws.flows, refId) : undefined;
    return step.name || ref?.name || 'Untitled';
  }
  return step.name || 'Untitled task';
}

/**
 * A flow's handoffs as the legacy loader keeps them: both ends present, not a self-loop, and one
 * connection per pair of mating points — the first one wins, as it does there.
 */
export function legacyEdges(flow: Flow): FlowEdge[] {
  const seen = new Set<string>();
  const out: FlowEdge[] = [];
  for (const edge of Object.values(flow.edges)) {
    if (!ownEntry(flow.steps, edge.from) || !ownEntry(flow.steps, edge.to)) continue;
    if (edge.from === edge.to) continue;
    const key = `${edge.from}:${edge.fromPort || ''}>${edge.to}:${edge.toPort || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out;
}

/** The columns a bound step has taken back from its row: org columns only, each once. */
export function stepBindOverrides(
  step: Pick<FlowStep, 'bind' | 'bindOverrides' | 'kind'>,
): ColKey[] {
  if (!step.bind || step.kind === 'subflow') return [];
  return [...new Set(step.bindOverrides.filter(isOrgColumn))];
}

/**
 * `translateLetters`: a chart row's letters, carried into the flow's framework. Owner maps to owner
 * and doer to doer; any other letter crosses only if the flow's framework has it — so an RASCI row's
 * S drops on its way into a RACI flow rather than becoming some other role.
 */
export function translateLetters(letters: string, from: Framework, to: Framework): string {
  if (from.key === to.key) return normalizeRaci(letters);
  const out = new Set<string>();
  for (const letter of normalizeRaci(letters)) {
    if (letter === from.owner) out.add(to.owner);
    else if (letter === from.doer) out.add(to.doer);
    else if (to.roles.includes(letter)) out.add(letter);
  }
  return normalizeRaci([...out].join(''));
}

/**
 * `columnActorKey`: the directorate behind an org column. A column with no entry takes the default
 * — a column keyed like a directorate maps to it — and an entry naming no directorate (the empty
 * string of a deliberately unmapped column) maps to nothing.
 */
export function columnDirectorate(
  ws: Pick<Workspace, 'columnActor'>,
  column: string,
): Actor | null {
  if (!isOrgColumn(column)) return null;
  const stored = Object.hasOwn(ws.columnActor, column) ? ws.columnActor[column] : column;
  return stored && isActor(stored) ? stored : null;
}

// ---- the per-pass context ---------------------------------------------------------------------------

/** `bizAnchorCtx`: what an anchored flow takes from the chart row it hangs under. */
export interface AnchorContext {
  readonly chart: Chart;
  readonly node: ChartNode;
  /**
   * The column the flow's steps inherit as owner: exactly what `cascadeDown` would hand the anchor's
   * children — its own primary R column, else the one it inherits. Null when the cascade is empty.
   */
  readonly ownerColumn: string | null;
}

/** `bizBindCtx`: what a Chart-Linked step takes from the org-chart row it implements. */
export interface BindContext {
  readonly chart: Chart;
  readonly node: ChartNode;
  /** The chart's framework: the alphabet `raci` is written in. */
  readonly framework: Framework;
  /** The row's effective line over the org columns: its own letters plus the owner it inherits. */
  readonly raci: Readonly<Record<ColKey, string>>;
}

/** One column of a step, after mode and binding: `bizStepRaci`. */
export interface StepCell {
  readonly letters: string;
  /** 'chart' when the bound row supplies it; 'own' when the step authors it. */
  readonly from: 'own' | 'chart';
}

export type StepRaci = Readonly<Record<ColKey, StepCell>>;

/**
 * Everything one rule pass reads more than once, computed once.
 *
 * Built per pass and thrown away: the document changes under the caller, and a context kept across
 * edits would answer about a document that no longer exists.
 */
export interface LintContext {
  readonly ws: Workspace;
  /** `ac()`: the chart in front. Null only for a workspace with no chart at all. */
  readonly activeChart: Chart | null;
  /** The columns every cascade in this pass reads — the active chart's (see the header). */
  readonly cascadeColumns: readonly string[];
  tree(chart: Chart): LegacyTree;
  /** `inheritedOwnerColIn`: the owner column the cascade hands `nodeId`, if any. */
  inheritedOwner(chart: Chart, nodeId: string): string | null;
  edges(flow: Flow): readonly FlowEdge[];
  /**
   * True when something produces `artifactId` other than the chart row `consumerNodeId` itself: a
   * row declaring it an output anywhere, or a handoff carrying it anywhere.
   */
  hasProducer(artifactId: string, consumerNodeId: string): boolean;
  anchor(flow: Pick<Flow, 'anchor'>): AnchorContext | null;
  bind(step: FlowStep): BindContext | null;
  /** `bizStepRaci`: what a step says, per org column, once its flow's mode and its bind apply. */
  stepRaci(flow: Pick<Flow, 'mode' | 'framework'>, step: FlowStep): StepRaci;
}

/**
 * The parts of a context that do not depend on which chart is in front. `workspaceViolations` lints
 * every chart as if it were the active one, and shares these across all of those passes.
 */
export interface LintCache {
  readonly trees: Map<string, LegacyTree>;
  readonly edges: Map<string, FlowEdge[]>;
  producers: Map<string, Array<{ readonly chartNode: boolean; readonly id: string }>> | null;
}

export function createLintCache(): LintCache {
  return { trees: new Map(), edges: new Map(), producers: null };
}

export function createLintContext(
  ws: Workspace,
  activeChartId?: string | null,
  cache: LintCache = createLintCache(),
): LintContext {
  const activeChart = resolveActiveChart(ws, activeChartId);
  // The legacy app always has a chart in front — `ac()` makes one when there is none — and a new
  // chart is an org chart, so the org columns are what an empty workspace cascades with.
  const cascadeColumns = activeChart ? legacyChartShape(activeChart).columns : COLS;
  const inherited = new Map<string, Map<string, string | null>>();
  const binds = new Map<string, BindContext | null>();

  const tree = (chart: Chart): LegacyTree => {
    let found = cache.trees.get(chart.id);
    if (!found) {
      found = legacyTree(chart);
      cache.trees.set(chart.id, found);
    }
    return found;
  };

  const inheritedOwner = (chart: Chart, nodeId: string): string | null => {
    let byNode = inherited.get(chart.id);
    if (!byNode) {
      byNode = new Map();
      // Rows come parent-first, so each parent's answer is already known when its children ask.
      for (const row of tree(chart).rows) {
        const parent = row.parent;
        byNode.set(
          row.node.id,
          parent
            ? (primaryRColumn(parent.node, cascadeColumns) ?? byNode.get(parent.node.id) ?? null)
            : null,
        );
      }
      inherited.set(chart.id, byNode);
    }
    return byNode.get(nodeId) ?? null;
  };

  const edges = (flow: Flow): readonly FlowEdge[] => {
    let found = cache.edges.get(flow.id);
    if (!found) {
      found = legacyEdges(flow);
      cache.edges.set(flow.id, found);
    }
    return found;
  };

  const hasProducer = (artifactId: string, consumerNodeId: string): boolean => {
    if (!cache.producers) {
      // `computeArtifactUses`, over what the legacy app would hold: the rows in each chart's tree,
      // and the handoffs its loader keeps. Only the producing side is needed here.
      const index = new Map<string, Array<{ chartNode: boolean; id: string }>>();
      const add = (id: string, use: { chartNode: boolean; id: string }) => {
        const list = index.get(id);
        if (list) list.push(use);
        else index.set(id, [use]);
      };
      for (const chart of chartsInOrder(ws)) {
        for (const row of tree(chart).rows) {
          for (const id of row.node.outputs) add(id, { chartNode: true, id: row.node.id });
        }
      }
      for (const flow of Object.values(ws.flows)) {
        for (const edge of edges(flow)) {
          for (const id of edge.artifactIds) add(id, { chartNode: false, id: edge.from });
        }
      }
      cache.producers = index;
    }
    // A row is never its own producer. The legacy check compares the row id alone, not the chart.
    return (cache.producers.get(artifactId) ?? []).some(
      (use) => !(use.chartNode && use.id === consumerNodeId),
    );
  };

  const anchor = (flow: Pick<Flow, 'anchor'>): AnchorContext | null => {
    if (!flow.anchor) return null;
    const chart = ownEntry(ws.charts, flow.anchor.chartId);
    const row = chart ? tree(chart).byId.get(flow.anchor.nodeId) : undefined;
    if (!chart || !row) return null;
    return {
      chart,
      node: row.node,
      ownerColumn: primaryRColumn(row.node, cascadeColumns) ?? inheritedOwner(chart, row.node.id),
    };
  };

  const bind = (step: FlowStep): BindContext | null => {
    if (step.kind === 'subflow' || !step.bind) return null;
    const key = `${step.bind.chartId}|${step.bind.nodeId}`;
    const cached = binds.get(key);
    if (cached !== undefined) return cached;
    const chart = ownEntry(ws.charts, step.bind.chartId);
    // Only organization charts can be bound to: a free-form chart's columns have nothing to do with
    // the seven a step is keyed by, so there is nothing sound to copy across.
    const bindable = chart && !legacyChartShape(chart).free ? chart : undefined;
    const row = bindable ? tree(bindable).byId.get(step.bind.nodeId) : undefined;
    let found: BindContext | null = null;
    if (bindable && row) {
      // The row's own letters, plus the owner the cascade hands it on the column it lands on —
      // unless the row names an owner of its own. In the CHART's alphabet; `stepRaci` translates.
      const fw = framework(bindable.framework);
      const inheritedCol = inheritedOwner(bindable, row.node.id);
      const ownCol = COLS.find((k) => cellLetters(row.node.raci, k).includes(fw.owner)) ?? null;
      const raci = {} as Record<ColKey, string>;
      for (const k of COLS) {
        const own = cellLetters(row.node.raci, k);
        raci[k] = !ownCol && k === inheritedCol ? normalizeRaci(own + fw.owner) : own;
      }
      found = { chart: bindable, node: row.node, framework: fw, raci };
    }
    binds.set(key, found);
    return found;
  };

  const stepRaci = (flow: Pick<Flow, 'mode' | 'framework'>, step: FlowStep): StepRaci => {
    const bound = flow.mode === 'linked' && step.kind !== 'subflow' ? bind(step) : null;
    const to = framework(flow.framework);
    const overridden = new Set(bound ? stepBindOverrides(step) : []);
    const out = {} as Record<ColKey, StepCell>;
    for (const k of COLS) {
      out[k] =
        bound && !overridden.has(k)
          ? { letters: translateLetters(bound.raci[k], bound.framework, to), from: 'chart' }
          : { letters: cellLetters(step.raci, k), from: 'own' };
    }
    return out;
  };

  return {
    ws,
    activeChart,
    cascadeColumns,
    tree,
    inheritedOwner,
    edges,
    hasProducer,
    anchor,
    bind,
    stepRaci,
  };
}

/**
 * The anchor a flow has in the legacy app's eyes: its own, when it still resolves to a row in the
 * chart's tree. The loader drops one that does not, and a row delete clears the anchors under it.
 */
export function liveAnchor(
  ws: Pick<Workspace, 'charts'>,
  flow: Pick<Flow, 'anchor'>,
  cache: LintCache = createLintCache(),
): { chartId: string; nodeId: string } | null {
  const a = flow.anchor;
  if (!a) return null;
  const chart = ownEntry(ws.charts, a.chartId);
  if (!chart) return null;
  let tree = cache.trees.get(chart.id);
  if (!tree) {
    tree = legacyTree(chart);
    cache.trees.set(chart.id, tree);
  }
  return tree.byId.has(a.nodeId) ? a : null;
}
