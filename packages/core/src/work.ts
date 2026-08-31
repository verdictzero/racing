/**
 * The work lens: what does my unit actually own?
 *
 * The question a RACI chart exists to answer, and the one the chart itself is worst at — the answer
 * is scattered across 800 rows in one document and a dozen flow steps in another. This walks both
 * and returns one list, scoped to a unit.
 *
 * TWO KINDS OF LANDING, and keeping them apart is the whole design. Work assigned to your unit or
 * to a team inside it is DIRECT: someone chose you. Work assigned to a parent org with no deeper
 * unit named is INHERITED: it lands on everyone underneath, including you, because nobody was more
 * specific. Merging them would produce a list that reads as "yours" and is not, which is the exact
 * failure mode that makes people stop trusting the tool.
 *
 * NOT YET PORTED, and stated rather than silently wrong: a Chart-Linked flow (`mode: 'linked'`)
 * gives each step a `bind` to a chart row and cascades that row's letters onto the step, subject to
 * `bindOverrides` and a letter translation when the two documents use different frameworks. That
 * binding subsystem lives with the flow canvas — PORTING.md slice 3 — and until it comes across, a
 * linked step contributes through its own `raci`/`parties` and through its flow's anchor, exactly
 * as a free-form step does. It under-reports for a linked flow; it never mis-reports.
 */


import { effectiveRaci } from './raci.js';
import { computeArtifactUses } from './registry.js';
import { inheritedOrg, orgLabel, scopeRelation } from './org.js';
import { childIndex, pathTo, walkInOrder } from './tree.js';
import { tierLabel } from './legacy.js';
import { chartColumns, type Flow, type FlowStep, type OrgRef, type Workspace } from './schema.js';

/** One responsibility this unit holds on one item. */
export interface WorkRole {
  readonly column: string;
  readonly letters: string;
  /** The letters cascaded from an ancestor row, or the party from the flow's anchor. */
  readonly inherited: boolean;
  /** The unit that holds it — this scope, or something inside it. */
  readonly unit: string;
}

/** A deliverable crossing the boundary of this item, and what is on the other side. */
export interface WorkIo {
  readonly artifactId: string;
  readonly name: string;
  /** Who produces an input / who takes an output. Empty when nothing does. */
  readonly counterparts: string[];
}

export interface WorkItem {
  readonly kind: 'chartRow' | 'flowStep';
  /** Whether the unit was named, or picked it up from an ancestor org. */
  readonly relation: 'direct' | 'inherited';
  readonly name: string;
  /** The breadcrumb line: which document and where in it. */
  readonly where: string;
  /** The org badge — the unit this landed on. */
  readonly unit: string;
  readonly roles: WorkRole[];
  readonly description: string;
  readonly entry: string;
  readonly exit: string;
  readonly inputs: WorkIo[];
  readonly outputs: WorkIo[];
  /** Enough to navigate there. */
  readonly chartId?: string;
  readonly nodeId?: string;
  readonly flowId?: string;
  readonly stepId?: string;
}

const named = (name: string, fallback: string) => name || fallback;

/**
 * The org a flow step's column falls to when the step names nobody.
 *
 * The flow's anchor row — the chart task the whole flow implements. A step that states no party for
 * a column still belongs to whoever owns the row the flow hangs under, and omitting that would make
 * every anchored flow look unassigned.
 */
function anchorOrg(ws: Workspace, flow: Flow): OrgRef | null {
  if (!flow.anchor) return null;
  const chart = ws.charts[flow.anchor.chartId];
  if (!chart) return null;
  return inheritedOrg(chart.nodes, flow.anchor.nodeId).ref;
}

function stepIoFor(
  ws: Workspace,
  flow: Flow,
  step: FlowStep,
): { inputs: WorkIo[]; outputs: WorkIo[] } {
  const inputs: WorkIo[] = [];
  const outputs: WorkIo[] = [];
  const label = (id: string) => ws.artifacts[id]?.name ?? '(missing deliverable)';

  for (const edge of Object.values(flow.edges)) {
    if (edge.artifactIds.length === 0) continue;
    if (edge.to === step.id) {
      const from = flow.steps[edge.from];
      const counterparts = from ? [named(from.name, '(untitled step)')] : [];
      for (const id of edge.artifactIds) inputs.push({ artifactId: id, name: label(id), counterparts });
    }
    if (edge.from === step.id) {
      const to = flow.steps[edge.to];
      const counterparts = to ? [named(to.name, '(untitled step)')] : [];
      for (const id of edge.artifactIds) outputs.push({ artifactId: id, name: label(id), counterparts });
    }
  }
  return { inputs, outputs };
}

/**
 * Everything that lands on `scope`, across every chart and every flow.
 *
 * Returns direct work first, then inherited, each in document order — so the list reads the way the
 * charts do rather than in whatever order the object keys happened to fall.
 */
export function collectWork(ws: Workspace, scope: OrgRef | null | undefined): WorkItem[] {
  if (!scope) return [];
  const items: WorkItem[] = [];
  const artifactUses = computeArtifactUses(ws);
  const unitOf = (ref: OrgRef | null) => (ref ? orgLabel(ws, ref)?.short ?? '' : '');

  // ---- chart rows ------------------------------------------------------------------------------
  for (const chart of Object.values(ws.charts)) {
    const columns = chartColumns(chart);
    const index = childIndex(chart.nodes);

    for (const node of walkInOrder(chart.nodes, index)) {
      const org = inheritedOrg(chart.nodes, node.id);
      const relation = scopeRelation(scope, org.ref);
      if (!relation) continue;

      const effective = effectiveRaci(chart, chart.nodes, node.id);
      const roles: WorkRole[] = [];
      for (const column of columns) {
        const cell = effective[column];
        if (!cell?.letters) continue;
        roles.push({
          column,
          letters: cell.letters,
          inherited: cell.source === 'inherited',
          unit: unitOf(org.ref),
        });
      }

      const ancestors = pathTo(chart.nodes, node.id)
        .slice(0, -1)
        .map((n) => named(n.name, '(untitled)'));
      const depth = ancestors.length;

      // The producers and consumers of a row's own declared IO. The row is excluded from its own
      // counterparts: "produced by this very row" is not useful provenance.
      const io = (ids: readonly string[], side: 'producers' | 'consumers'): WorkIo[] =>
        ids.map((id) => ({
          artifactId: id,
          name: ws.artifacts[id]?.name ?? '(missing deliverable)',
          counterparts: (artifactUses.get(id)?.[side] ?? [])
            .filter((u) => u.nodeId !== node.id)
            .map((u) => u.name),
        }));

      items.push({
        kind: 'chartRow',
        relation,
        name: named(node.name, '(untitled)'),
        where: `${tierLabel(chart, depth)} · ${chart.title}${ancestors.length ? ` › ${ancestors.join(' › ')}` : ''}`,
        unit: unitOf(org.ref),
        roles,
        description: node.description,
        entry: '',
        exit: '',
        inputs: io(node.inputs, 'producers'),
        outputs: io(node.outputs, 'consumers'),
        chartId: chart.id,
        nodeId: node.id,
      });
    }
  }

  // ---- flow steps ------------------------------------------------------------------------------
  for (const flow of Object.values(ws.flows)) {
    const fallback = anchorOrg(ws, flow);
    const anchorCrumb = flow.anchor
      ? ` ⚓ ${ws.charts[flow.anchor.chartId]?.title ?? ''} › ${
          ws.charts[flow.anchor.chartId]?.nodes[flow.anchor.nodeId]?.name ?? '(untitled)'
        }`
      : '';

    for (const step of Object.values(flow.steps)) {
      // A subflow box holds no responsibility of its own — the roles live in the flow it references
      // and are collected when THAT flow is walked. Counting it here would double the work.
      if (step.kind === 'subflow') continue;

      const roles: WorkRole[] = [];
      let best: 'direct' | 'inherited' | null = null;

      for (const column of Object.keys(step.raci)) {
        const letters = step.raci[column];
        if (!letters) continue;
        const explicit = step.parties[column] ?? null;
        const ref = explicit ?? fallback;
        const relation = scopeRelation(scope, ref);
        if (!relation) continue;
        roles.push({ column, letters, inherited: !explicit, unit: unitOf(ref) });
        if (relation === 'direct') best = 'direct';
        else best ??= relation;
      }
      if (!best) continue;

      const { inputs, outputs } = stepIoFor(ws, flow, step);
      items.push({
        kind: 'flowStep',
        relation: best,
        name: named(step.name, '(untitled step)'),
        where: `Flow step · ${flow.name}${anchorCrumb}`,
        unit: '',
        roles,
        description: step.description,
        entry: step.entry,
        exit: step.exit,
        inputs,
        outputs,
        flowId: flow.id,
        stepId: step.id,
      });
    }
  }

  // Direct first: it is what the reader came for, and an inherited list can be long.
  return items.sort((a, b) => (a.relation === b.relation ? 0 : a.relation === 'direct' ? -1 : 1));
}

export interface WorkSummary {
  readonly total: number;
  readonly direct: number;
  readonly inherited: number;
  /** How many items carry each role letter — "you are Accountable for 12 things". */
  readonly byLetter: Record<string, number>;
}

/** The counts a unit's run book leads with. */
export function summarizeWork(items: readonly WorkItem[]): WorkSummary {
  const byLetter: Record<string, number> = {};
  for (const item of items) {
    // Per ITEM, not per cell: holding A in two columns of one row is still one thing you own.
    const letters = new Set<string>();
    for (const role of item.roles) for (const letter of role.letters) letters.add(letter);
    for (const letter of letters) byLetter[letter] = (byLetter[letter] ?? 0) + 1;
  }
  return {
    total: items.length,
    direct: items.filter((i) => i.relation === 'direct').length,
    inherited: items.filter((i) => i.relation === 'inherited').length,
    byLetter,
  };
}
