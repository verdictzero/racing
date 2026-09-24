/**
 * Merge: add a file's charts and flows to the workspace as new tabs.
 *
 * index.html's `importJSON(file, true)` — how two people combine their work. The file's charts and
 * flows are appended under fresh ids, its deliverables are matched against the registry BY
 * IDENTITY, and nothing already in the workspace changes: not a row, not a label, not the roster.
 *
 * THE ONE STRUCTURAL DIFFERENCE FROM THE SOURCE
 * The legacy re-mints chart and flow ids but keeps every node and step id, because its rows live
 * inside their chart and its steps inside their flow — an id only has to be unique within its
 * parent. Here nodes, steps, handoffs and groups are keyed GLOBALLY (see doc.ts), so a kept id
 * would overwrite the record already stored under it; merging the same file twice would silently
 * replace the first copy's rows with the second's. So every one of them is re-minted too, and
 * every reference to one is carried across: a row's parent, a flow's anchor, a step's bind, its
 * group, a nested-flow box's reference and exposed ports, a handoff's ends and mating points.
 *
 * WHERE THE SOURCE'S CODE AND ITS INTENT DISAGREE, this follows the intent:
 *   - An anchor to a chart the file did not carry survives if it resolves against this workspace
 *     ("re-importing a previously exported case", says the comment beside the code). In index.html
 *     that branch never runs: its loader has already nulled every anchor that does not resolve
 *     within the FILE, before the merge code sees it.
 *   - A step bound to a chart in the file follows that chart to its new id. index.html re-mints the
 *     chart and leaves the bind on the old id, which dangles — or, merging a workspace into itself,
 *     quietly binds the copy's steps to the ORIGINAL chart's rows.
 *
 * WHAT A FILE CARRIED is decided before any defaults are filled in: `importLegacy` gives a file
 * with no chart a blank one, and merging that would add an empty tab nobody asked for. Pass
 * `legacySections(raw)` — or use `mergeLegacy`, which does both steps.
 */

import { keysBetween } from './fractional.js';
import { newId } from './ids.js';
import { importLegacy, type ImportReport } from './legacy.js';
import {
  Workspace,
  type Artifact,
  type Chart,
  type ChartNode,
  type Flow,
  type FlowEdge,
  type FlowGroup,
  type FlowStep,
} from './schema.js';
import { chartsInTabOrder, flowEdges, freeFormShape } from './export/document-text.js';

/** Which sections of a file are merged. A section the file did not carry is never merged. */
export interface MergeSections {
  readonly charts: boolean;
  readonly flows: boolean;
  readonly artifacts: boolean;
}

const ALL_SECTIONS: MergeSections = { charts: true, flows: true, artifacts: true };

/**
 * What a legacy file actually carries — index.html's `hadCharts` / `hadBiz` / `hadArts`, read off
 * the raw file BEFORE its loader backfills a blank chart or the demo's flows into the gaps.
 * A pre-multi-chart file (top-level `activities`, no `charts`) counts as carrying a chart.
 */
export function legacySections(raw: unknown): MergeSections {
  const file =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const nonEmpty = (v: unknown) => Array.isArray(v) && v.length > 0;
  return {
    charts: nonEmpty(file.charts) || Array.isArray(file.activities),
    flows: nonEmpty(file.bizCases),
    artifacts: nonEmpty(file.artifacts),
  };
}

export interface MergeSummary {
  readonly charts: number;
  readonly flows: number;
}

export interface MergeResult {
  /**
   * Everything the merge adds, shaped as a workspace so `loadWorkspace` writes it in one
   * transaction. Every id in it is new, so nothing already in the document is overwritten. It
   * carries the CURRENT workspace's labels and column map (a merge keeps them, and `loadWorkspace`
   * writes them back unchanged) and an empty roster (a merge never touches the org).
   */
  readonly additions: Workspace;
  readonly summary: MergeSummary;
  /** The first merged chart's new id — index.html brings it to the front. Null when none came in. */
  readonly activeChartId: string | null;
}

/** index.html's toast after a merge, word for word. */
export function mergeToast(summary: MergeSummary): string {
  return `Merged ${summary.charts} chart(s) and ${summary.flows} business case(s) into your workspace.`;
}

/** The registry key two deliverables are "the same" by: name, trimmed and case-folded, and type. */
const sameDeliverable = (a: Artifact, b: Artifact) =>
  (a.name || 'Untitled deliverable').trim().toLowerCase() ===
    (b.name || 'Untitled deliverable').trim().toLowerCase() && a.type === b.type;

/**
 * Merge `incoming` into `current`. Pure: neither argument is modified, and nothing is written —
 * apply `additions` with `loadWorkspace`.
 */
export function mergeWorkspace(
  current: Workspace,
  incoming: Workspace,
  sections: MergeSections = ALL_SECTIONS,
): MergeResult {
  const charts = sections.charts ? chartsInTabOrder(incoming) : [];
  const flows = sections.flows ? Object.values(incoming.flows) : [];

  // ---- deliverables, by identity ------------------------------------------------------------
  // An incoming deliverable with the same name and type as one already registered maps onto it,
  // so the registry stays deduplicated and a merged flow's handoffs connect to existing work. The
  // search includes deliverables added earlier in this same merge, so a file that names one thing
  // twice registers it once.
  const registry: Artifact[] = Object.values(current.artifacts);
  const artifacts: Record<string, Artifact> = {};
  const artifactIds = new Map<string, string>();
  if (sections.artifacts) {
    for (const a of Object.values(incoming.artifacts)) {
      const existing = registry.find((x) => sameDeliverable(x, a));
      if (existing) {
        artifactIds.set(a.id, existing.id);
        continue;
      }
      const copy: Artifact = {
        ...a,
        id: newId('artifact'),
        ownerRef: a.ownerRef ? { ...a.ownerRef } : null,
        doc: a.doc ? { ...a.doc } : null,
      };
      artifactIds.set(a.id, copy.id);
      registry.push(copy);
      artifacts[copy.id] = copy;
    }
  }
  const registered = new Set(registry.map((a) => a.id));
  // Remap, then drop whatever still points at nothing: after a merge, no reference outlives its
  // registry entry.
  const remapDeliverables = (ids: readonly string[]) =>
    ids.map((id) => artifactIds.get(id) ?? id).filter((id) => registered.has(id));

  // ---- fresh ids for everything that came in ------------------------------------------------
  // Minted up front, all of them, so a reference can be rewritten to its target's new id whatever
  // order the records arrive in — a nested-flow box can name a flow later in the file.
  const chartIds = new Map(charts.map((c) => [c.id, newId('chart')]));
  const nodeIds = new Map(
    charts.map((c) => [c.id, new Map(Object.keys(c.nodes).map((id) => [id, newId('node')]))]),
  );
  const flowIds = new Map(flows.map((f) => [f.id, newId('flow')]));
  const stepIds = new Map(
    flows.map((f) => [f.id, new Map(Object.keys(f.steps).map((id) => [id, newId('step')]))]),
  );

  /** A (chart, row) reference into the file's charts, followed to the new ids; null when not one. */
  const followRow = (ref: { chartId: string; nodeId: string }) => {
    const chartId = chartIds.get(ref.chartId);
    const nodeId = nodeIds.get(ref.chartId)?.get(ref.nodeId);
    return chartId ? { chartId, nodeId: nodeId ?? null } : null;
  };
  const resolvesHere = (ref: { chartId: string; nodeId: string }) =>
    !!current.charts[ref.chartId]?.nodes[ref.nodeId];

  /**
   * A flow's anchor: onto the copy of its chart when the file carried it (standalone if the row
   * is not in it), else onto this workspace's row when there is one, else standalone.
   */
  const followAnchor = (anchor: Flow['anchor']): Flow['anchor'] => {
    if (!anchor) return null;
    const followed = followRow(anchor);
    if (followed) {
      return followed.nodeId ? { chartId: followed.chartId, nodeId: followed.nodeId } : null;
    }
    return resolvesHere(anchor) ? { ...anchor } : null;
  };

  /**
   * A step's bind: onto the copy of its chart when the file carried it, otherwise as written. One
   * that resolves nowhere is kept regardless — it is where a linked step's responsibility line
   * comes from, so the legacy keeps it and shows a broken link rather than emptying the step.
   */
  const followBind = (bind: NonNullable<FlowStep['bind']>): FlowStep['bind'] => {
    const followed = followRow(bind);
    return followed
      ? { chartId: followed.chartId, nodeId: followed.nodeId ?? bind.nodeId }
      : { ...bind };
  };

  /** The chart a linked flow's row picker offers: an organization chart, followed or already here. */
  const followSourceChart = (chartId: string | null): string | null => {
    if (!chartId) return null;
    const fileChart = sections.charts ? incoming.charts[chartId] : undefined;
    if (fileChart) return freeFormShape(fileChart) ? null : (chartIds.get(chartId) ?? null);
    const here = current.charts[chartId];
    return here && !freeFormShape(here) ? chartId : null;
  };

  // ---- charts -------------------------------------------------------------------------------
  const addedCharts: Record<string, Chart> = {};
  const chartOrder: Record<string, string> = {};
  const lastTab = Object.values(current.chartOrder).sort().at(-1) ?? null;
  const tabKeys = keysBetween(lastTab, null, charts.length);
  charts.forEach((chart, i) => {
    const id = chartIds.get(chart.id)!;
    const ids = nodeIds.get(chart.id)!;
    const nodes: Record<string, ChartNode> = {};
    for (const node of Object.values(chart.nodes)) {
      const nodeId = ids.get(node.id)!;
      nodes[nodeId] = {
        ...node,
        id: nodeId,
        chartId: id,
        // A parent the file does not have (an orphan, which the nested format cannot even express)
        // comes in as a root rather than pointing into someone else's chart.
        parentId: node.parentId === null ? null : (ids.get(node.parentId) ?? null),
        raci: { ...node.raci },
        org: node.org ? { ...node.org } : null,
        documents: node.documents.map((d) => ({ ...d })),
        inputs: remapDeliverables(node.inputs),
        outputs: remapDeliverables(node.outputs),
      };
    }
    addedCharts[id] = {
      ...chart,
      id,
      meta: { ...chart.meta, tags: [...chart.meta.tags] },
      custom: chart.custom
        ? { cols: chart.custom.cols.map((c) => ({ ...c })), tiers: [...chart.custom.tiers] }
        : null,
      nodes,
    };
    chartOrder[id] = tabKeys[i]!;
  });

  // ---- flows --------------------------------------------------------------------------------
  const addedFlows: Record<string, Flow> = {};
  for (const flow of flows) {
    const id = flowIds.get(flow.id)!;
    const ids = stepIds.get(flow.id)!;
    const groupIds = new Map(Object.keys(flow.groups).map((g) => [g, newId('group')]));

    /** The file's flow a nested-flow box references, when the file carried it (and it is not itself). */
    const referencedFlow = (step: FlowStep | undefined) =>
      step?.kind === 'subflow' && step.refId && step.refId !== flow.id && flowIds.has(step.refId)
        ? step.refId
        : null;
    /** A step id inside the flow `refFlowId`, followed to its new id; null when it is not there. */
    const portIn = (refFlowId: string | null, port: string | null) =>
      refFlowId && port ? (stepIds.get(refFlowId)?.get(port) ?? null) : null;
    /**
     * A nested-flow box's reference. To a flow the file carried, it follows that flow to the copy.
     * To one the file did not carry, it is left alone: it may be the same flow already in this
     * workspace, and if not, the box survives as a visibly broken embed rather than losing its
     * wiring. A box naming its own flow is meaningless, and is cleared as the legacy loader clears it.
     */
    const followRef = (step: FlowStep): string | null => {
      if (step.kind !== 'subflow' || !step.refId || step.refId === flow.id) return null;
      return flowIds.get(step.refId) ?? step.refId;
    };

    const steps: Record<string, FlowStep> = {};
    for (const step of Object.values(flow.steps)) {
      const stepId = ids.get(step.id)!;
      const sub = step.kind === 'subflow';
      const ref = referencedFlow(step);
      steps[stepId] = {
        ...step,
        id: stepId,
        flowId: id,
        refId: followRef(step),
        // Exposed ports are step ids INSIDE the referenced flow. They survive only while that flow
        // came in the same file, where they follow its steps to their new ids.
        ports: ref
          ? {
              in: step.ports.in.map((p) => portIn(ref, p)).filter((p): p is string => p !== null),
              out: step.ports.out.map((p) => portIn(ref, p)).filter((p): p is string => p !== null),
            }
          : { in: [], out: [] },
        groupId: step.groupId ? (groupIds.get(step.groupId) ?? null) : null,
        raci: { ...step.raci },
        parties: Object.fromEntries(Object.entries(step.parties).map(([k, v]) => [k, { ...v }])),
        bind: sub || !step.bind ? null : followBind(step.bind),
      };
    }

    const edges: Record<string, FlowEdge> = {};
    for (const edge of flowEdges(flow)) {
      const edgeId = newId('edge');
      edges[edgeId] = {
        ...edge,
        id: edgeId,
        flowId: id,
        from: ids.get(edge.from)!,
        to: ids.get(edge.to)!,
        // A mating point names a step inside the flow a nested-flow END references; anywhere else
        // it means nothing and falls back to the box's default socket.
        fromPort: portIn(referencedFlow(flow.steps[edge.from]), edge.fromPort),
        toPort: portIn(referencedFlow(flow.steps[edge.to]), edge.toPort),
        artifactIds: remapDeliverables(edge.artifactIds),
        via: edge.via.map((p) => ({ ...p })),
      };
    }

    const groups: Record<string, FlowGroup> = {};
    for (const group of Object.values(flow.groups)) {
      const groupId = groupIds.get(group.id)!;
      groups[groupId] = { ...group, id: groupId, flowId: id };
    }

    addedFlows[id] = {
      ...flow,
      id,
      meta: { ...flow.meta, tags: [...flow.meta.tags] },
      anchor: followAnchor(flow.anchor),
      sourceChartId: followSourceChart(flow.sourceChartId),
      steps,
      edges,
      groups,
    };
  }

  const additions = Workspace.parse({
    schemaVersion: current.schemaVersion,
    charts: addedCharts,
    chartOrder,
    flows: addedFlows,
    artifacts,
    entities: {},
    roster: {},
    actorLabels: current.actorLabels,
    columnLabels: current.columnLabels,
    columnShort: current.columnShort,
    columnActor: current.columnActor,
  });

  return {
    additions,
    summary: { charts: charts.length, flows: flows.length },
    activeChartId: charts.length > 0 ? chartIds.get(charts[0]!.id)! : null,
  };
}

/**
 * Merge a legacy workspace file: read it, work out which sections it actually carried, merge.
 * Throws what `importLegacy` throws for a file that is not a workspace at all.
 */
export function mergeLegacy(
  current: Workspace,
  raw: unknown,
): MergeResult & { report: ImportReport } {
  const { workspace, report } = importLegacy(raw);
  return { ...mergeWorkspace(current, workspace, legacySections(raw)), report };
}
