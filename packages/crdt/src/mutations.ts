/**
 * Every write the UI is allowed to make.
 *
 * The UI never touches a Y.Map directly. It calls one of these, and that buys three things:
 *
 *   1. Each is a single transaction, so a peer sees "a row was added", never a half-built row.
 *   2. Each carries an origin tag, so the undo manager can scope undo to THIS user's edits — the
 *      thing that separates a collaborative editor from one where Ctrl+Z rips out a colleague's
 *      work.
 *   3. There is one list of everything that can change the document, which is what a server-side
 *      permission check and an audit trail can both be written against.
 *
 * Guards here are best-effort by design. `moveNode` refuses a move it can see would make a cycle,
 * which handles every single-client case exactly; the concurrent case that no guard can catch is
 * repaired afterwards by the deterministic pass in @raci/core (see `repair.ts`).
 */

import * as Y from 'yjs';
import {
  ChartNode,
  Flow,
  FlowEdge,
  FlowGroup,
  FlowStep,
  chartColumns,
  chartMaxDepth,
  isAncestorOf,
  keyBetween,
  newId,
  orderForAppend,
  planMove,
  subtreeDepth,
  type Chart,
  type NodeMap,
  type OrgRef,
} from '@raci/core';
import { fromYMap, maps, setField, toYMap } from './doc.js';

/** Tags every local mutation so undo can be scoped to one user's own edits. */
export const LOCAL_ORIGIN = 'local';

export class MutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MutationError';
  }
}

function currentNodes(doc: Y.Doc, chartId: string): NodeMap {
  const m = maps(doc);
  const out: Record<string, ChartNode> = {};
  for (const [id, raw] of m.nodes.entries()) {
    const parsed = ChartNode.safeParse({ ...fromYMap(raw), id });
    if (parsed.success && parsed.data.chartId === chartId) out[id] = parsed.data;
  }
  return out;
}

function chartHeader(doc: Y.Doc, chartId: string): Pick<Chart, 'custom' | 'framework'> {
  const raw = maps(doc).charts.get(chartId);
  if (!raw) throw new MutationError(`no such chart: ${chartId}`);
  const plain = fromYMap(raw);
  return {
    custom: (plain.custom ?? null) as Chart['custom'],
    framework: (plain.framework ?? 'raci') as Chart['framework'],
  };
}

// ---- chart rows -----------------------------------------------------------------------------

export interface AddNodeOptions {
  readonly chartId: string;
  readonly parentId?: string | null;
  readonly name?: string;
  /** Insert directly after this sibling; appended to the end when omitted. */
  readonly afterId?: string;
}

/** Add a row. Returns its id, minted client-side so the caller can select it immediately. */
export function addNode(doc: Y.Doc, opts: AddNodeOptions): string {
  const { chartId, parentId = null, name = '' } = opts;
  const m = maps(doc);
  if (!m.charts.has(chartId)) throw new MutationError(`no such chart: ${chartId}`);

  const nodes = currentNodes(doc, chartId);
  if (parentId !== null && !nodes[parentId]) throw new MutationError(`no such parent: ${parentId}`);

  let order: string;
  if (opts.afterId) {
    const sibling = nodes[opts.afterId];
    if (!sibling) throw new MutationError(`no such sibling: ${opts.afterId}`);
    const siblings = Object.values(nodes)
      .filter((n) => n.parentId === sibling.parentId)
      .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
    const at = siblings.findIndex((n) => n.id === opts.afterId);
    const next = at >= 0 && at + 1 < siblings.length ? siblings[at + 1]!.order : null;
    order = keyBetween(sibling.order, next);
  } else {
    order = orderForAppend(nodes, parentId);
  }

  const id = newId('node');
  const node = ChartNode.parse({ id, chartId, parentId, order, name });
  doc.transact(() => {
    maps(doc).nodes.set(id, toYMap(node));
  }, LOCAL_ORIGIN);
  return id;
}

export function renameNode(doc: Y.Doc, nodeId: string, name: string): void {
  doc.transact(() => setField(maps(doc).nodes, nodeId, 'name', name), LOCAL_ORIGIN);
}

/** Set one column's letters on one row. Writes the inner map entry, so columns merge per-cell. */
export function setNodeRaci(doc: Y.Doc, nodeId: string, column: string, letters: string): void {
  doc.transact(() => setField(maps(doc).nodes, nodeId, 'raci', letters, column), LOCAL_ORIGIN);
}

export function setNodeField(
  doc: Y.Doc,
  nodeId: string,
  field: 'description' | 'primaryR' | 'org' | 'inputs' | 'outputs',
  value: unknown,
): void {
  doc.transact(() => setField(maps(doc).nodes, nodeId, field, value), LOCAL_ORIGIN);
}

/**
 * Reparent and/or reorder a row.
 *
 * Two field writes, and that is the whole point: under the legacy nested array this was a splice
 * out of one array and a splice into another, which is exactly the shape that cannot merge.
 */
export function moveNode(
  doc: Y.Doc,
  chartId: string,
  nodeId: string,
  parentId: string | null,
  index: number,
): void {
  const nodes = currentNodes(doc, chartId);
  const chart = chartHeader(doc, chartId);
  const node = nodes[nodeId];
  if (!node) throw new MutationError(`no such node: ${nodeId}`);

  // An org chart stops at Task. Moving a subtree deeper than that would produce rows the chart
  // has no tier for, so it is refused with the reason rather than silently truncated.
  const maxDepth = chartMaxDepth(chart);
  if (Number.isFinite(maxDepth)) {
    const targetDepth = parentId === null ? 0 : depthOfIn(nodes, parentId) + 1;
    const height = subtreeDepth(nodes, nodeId);
    if (targetDepth + height > maxDepth) {
      throw new MutationError(
        `moving this row there would nest ${targetDepth + height + 1} levels deep; this chart stops at ${maxDepth + 1}`,
      );
    }
  }
  if (parentId !== null && isAncestorOf(nodes, nodeId, parentId)) {
    throw new MutationError('a row cannot be moved inside itself');
  }

  const plan = planMove(nodes, nodeId, parentId, index);
  doc.transact(() => {
    const m = maps(doc);
    setField(m.nodes, nodeId, 'parentId', plan.parentId);
    setField(m.nodes, nodeId, 'order', plan.order);
  }, LOCAL_ORIGIN);
}

function depthOfIn(nodes: NodeMap, id: string): number {
  let depth = 0;
  let cur = nodes[id];
  const seen = new Set([id]);
  while (cur && cur.parentId !== null && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    cur = nodes[cur.parentId];
    if (!cur) break;
    depth++;
  }
  return depth;
}

/**
 * Delete a row and everything under it.
 *
 * Collected first, deleted in one transaction. A concurrent add under a row being deleted still
 * loses its parent — that is the orphan case `repair.ts` re-roots rather than drops, so the other
 * person's work survives visibly instead of vanishing.
 */
export function deleteNode(doc: Y.Doc, chartId: string, nodeId: string): string[] {
  const nodes = currentNodes(doc, chartId);
  if (!nodes[nodeId]) return [];
  const doomed: string[] = [];
  const walk = (id: string) => {
    doomed.push(id);
    for (const n of Object.values(nodes)) if (n.parentId === id) walk(n.id);
  };
  walk(nodeId);
  doc.transact(() => {
    const m = maps(doc);
    for (const id of doomed) m.nodes.delete(id);
  }, LOCAL_ORIGIN);
  return doomed;
}

/** Duplicate a row and its subtree under fresh ids, landing directly after the original. */
export function duplicateNode(doc: Y.Doc, chartId: string, nodeId: string): string | null {
  const nodes = currentNodes(doc, chartId);
  const source = nodes[nodeId];
  if (!source) return null;

  const idMap = new Map<string, string>();
  const copies: ChartNode[] = [];
  const clone = (id: string, parentId: string | null, order: string) => {
    const original = nodes[id]!;
    const freshId = newId('node');
    idMap.set(id, freshId);
    copies.push({ ...original, id: freshId, parentId, order });
    const children = Object.values(nodes)
      .filter((n) => n.parentId === id)
      .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
    let prev: string | null = null;
    for (const child of children) {
      const childOrder = keyBetween(prev, null);
      prev = childOrder;
      clone(child.id, freshId, childOrder);
    }
  };

  const siblings = Object.values(nodes)
    .filter((n) => n.parentId === source.parentId)
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  const at = siblings.findIndex((n) => n.id === nodeId);
  const next = at >= 0 && at + 1 < siblings.length ? siblings[at + 1]!.order : null;
  clone(nodeId, source.parentId, keyBetween(source.order, next));

  doc.transact(() => {
    const m = maps(doc);
    for (const copy of copies) m.nodes.set(copy.id, toYMap(copy));
  }, LOCAL_ORIGIN);
  return idMap.get(nodeId) ?? null;
}

// ---- charts ------------------------------------------------------------------------------------

export function addChart(doc: Y.Doc, title = 'Untitled chart', custom: Chart['custom'] = null): string {
  const m = maps(doc);
  const id = newId('chart');
  const orders = [...m.chartOrder.values()].sort();
  const order = keyBetween(orders.length > 0 ? orders[orders.length - 1]! : null, null);
  doc.transact(() => {
    m.charts.set(
      id,
      toYMap({
        id,
        title,
        framework: 'raci',
        status: 'draft',
        finalizedAt: null,
        meta: { description: '', customer: '', priority: '', budget: '', tags: [] },
        custom,
      }),
    );
    m.chartOrder.set(id, order);
  }, LOCAL_ORIGIN);
  return id;
}

export function setChartField(
  doc: Y.Doc,
  chartId: string,
  field: 'title' | 'framework' | 'status' | 'finalizedAt' | 'meta' | 'custom',
  value: unknown,
): void {
  doc.transact(() => setField(maps(doc).charts, chartId, field, value), LOCAL_ORIGIN);
}

/** Delete a chart, its rows, and any flow anchor that pointed into it. */
export function deleteChart(doc: Y.Doc, chartId: string): void {
  doc.transact(() => {
    const m = maps(doc);
    m.charts.delete(chartId);
    m.chartOrder.delete(chartId);
    for (const [id, raw] of [...m.nodes.entries()]) {
      if (raw.get('chartId') === chartId) m.nodes.delete(id);
    }
    // A flow whose anchor row is gone becomes standalone rather than being deleted with the
    // chart — the flow is a document in its own right and outlives what it hung under.
    for (const [, raw] of m.flows.entries()) {
      const anchor = raw.get('anchor') as { chartId?: string } | null;
      if (anchor && anchor.chartId === chartId) raw.set('anchor', null);
    }
    for (const [, raw] of m.steps.entries()) {
      const bind = raw.get('bind') as { chartId?: string } | null;
      if (bind && bind.chartId === chartId) raw.set('bind', null);
    }
  }, LOCAL_ORIGIN);
}

// ---- flows --------------------------------------------------------------------------------------

export function addFlow(doc: Y.Doc, name = 'Untitled business case'): string {
  const id = newId('flow');
  const flow = Flow.parse({ id, name });
  const { steps: _s, edges: _e, groups: _g, ...header } = flow;
  doc.transact(() => maps(doc).flows.set(id, toYMap(header)), LOCAL_ORIGIN);
  return id;
}

export function addStep(
  doc: Y.Doc,
  flowId: string,
  fields: Partial<Omit<FlowStep, 'id' | 'flowId'>> = {},
): string {
  const id = newId('step');
  const step = FlowStep.parse({ id, flowId, ...fields });
  doc.transact(() => maps(doc).steps.set(id, toYMap(step)), LOCAL_ORIGIN);
  return id;
}

/** Move a step on the canvas. x and y are separate fields, so two drags never fight over a pair. */
export function moveStep(doc: Y.Doc, stepId: string, x: number, y: number): void {
  doc.transact(() => {
    const m = maps(doc);
    setField(m.steps, stepId, 'x', Math.round(x));
    setField(m.steps, stepId, 'y', Math.round(y));
  }, LOCAL_ORIGIN);
}

export function setStepField(
  doc: Y.Doc,
  stepId: string,
  field: 'name' | 'description' | 'entry' | 'exit' | 'groupId' | 'bind' | 'ports' | 'refId',
  value: unknown,
): void {
  doc.transact(() => setField(maps(doc).steps, stepId, field, value), LOCAL_ORIGIN);
}

export function setStepRaci(doc: Y.Doc, stepId: string, column: string, letters: string): void {
  doc.transact(() => setField(maps(doc).steps, stepId, 'raci', letters, column), LOCAL_ORIGIN);
}

export function setStepParty(doc: Y.Doc, stepId: string, column: string, ref: OrgRef | null): void {
  doc.transact(
    () => setField(maps(doc).steps, stepId, 'parties', ref ?? undefined, column),
    LOCAL_ORIGIN,
  );
}

/** Delete a step and every handoff touching it. */
export function deleteStep(doc: Y.Doc, stepId: string): void {
  doc.transact(() => {
    const m = maps(doc);
    m.steps.delete(stepId);
    for (const [id, raw] of [...m.edges.entries()]) {
      if (raw.get('from') === stepId || raw.get('to') === stepId) m.edges.delete(id);
    }
  }, LOCAL_ORIGIN);
}

export function addEdge(
  doc: Y.Doc,
  flowId: string,
  from: string,
  to: string,
  fields: Partial<Omit<FlowEdge, 'id' | 'flowId' | 'from' | 'to'>> = {},
): string {
  const id = newId('edge');
  const edge = FlowEdge.parse({ id, flowId, from, to, ...fields });
  doc.transact(() => maps(doc).edges.set(id, toYMap(edge)), LOCAL_ORIGIN);
  return id;
}

export function setEdgeField(
  doc: Y.Doc,
  edgeId: string,
  field: 'label' | 'artifactIds' | 'via' | 'fromPort' | 'toPort',
  value: unknown,
): void {
  doc.transact(() => setField(maps(doc).edges, edgeId, field, value), LOCAL_ORIGIN);
}

export function deleteEdge(doc: Y.Doc, edgeId: string): void {
  doc.transact(() => maps(doc).edges.delete(edgeId), LOCAL_ORIGIN);
}

export function addGroup(doc: Y.Doc, flowId: string, name = '', memberIds: string[] = []): string {
  const id = newId('group');
  const group = FlowGroup.parse({ id, flowId, name });
  doc.transact(() => {
    const m = maps(doc);
    m.groups.set(id, toYMap(group));
    for (const stepId of memberIds) {
      const step = m.steps.get(stepId);
      if (step) step.set('groupId', id);
    }
  }, LOCAL_ORIGIN);
  return id;
}

/** Delete the frame; its steps stay on the canvas. */
export function deleteGroup(doc: Y.Doc, groupId: string): void {
  doc.transact(() => {
    const m = maps(doc);
    m.groups.delete(groupId);
    for (const [, raw] of m.steps.entries()) {
      if (raw.get('groupId') === groupId) raw.set('groupId', null);
    }
  }, LOCAL_ORIGIN);
}

// ---- registries -----------------------------------------------------------------------------------

export function addArtifact(doc: Y.Doc, name: string, type = 'other'): string {
  const id = newId('artifact');
  doc.transact(
    () =>
      maps(doc).artifacts.set(
        id,
        toYMap({ id, name, type, ownerRef: null, description: '', doc: null }),
      ),
    LOCAL_ORIGIN,
  );
  return id;
}

/**
 * Edit one field of a deliverable.
 *
 * Per-field rather than per-record, like every other setter here, and for the same reason: two
 * people in the gallery — one fixing a name, one filling in the description — must not overwrite
 * each other. Writing the whole record would make the registry the one place in the document where
 * they do.
 */
export function setArtifactField(
  doc: Y.Doc,
  artifactId: string,
  field: 'name' | 'type' | 'description' | 'ownerRef' | 'doc',
  value: unknown,
): void {
  doc.transact(() => setField(maps(doc).artifacts, artifactId, field, value), LOCAL_ORIGIN);
}

/**
 * Delete a deliverable, refusing while anything still points at it.
 *
 * The check is a read of the current document, so it is a best-effort guard: a peer can attach the
 * deliverable in the same instant the delete lands. The invariant is restored on read instead —
 * `readWorkspace` drops references with no registry entry, exactly as the legacy loader does.
 */
export function deleteArtifact(doc: Y.Doc, artifactId: string): { deleted: boolean; uses: number } {
  const m = maps(doc);
  let uses = 0;
  for (const [, raw] of m.edges.entries()) {
    const ids = raw.get('artifactIds');
    if (Array.isArray(ids) && ids.includes(artifactId)) uses++;
  }
  for (const [, raw] of m.nodes.entries()) {
    for (const field of ['inputs', 'outputs'] as const) {
      const ids = raw.get(field);
      if (Array.isArray(ids) && ids.includes(artifactId)) uses++;
    }
  }
  if (uses > 0) return { deleted: false, uses };
  doc.transact(() => m.artifacts.delete(artifactId), LOCAL_ORIGIN);
  return { deleted: true, uses: 0 };
}

export function addEntity(doc: Y.Doc, name: string, kind = 'other'): string {
  const id = newId('entity');
  doc.transact(
    () =>
      maps(doc).entities.set(
        id,
        toYMap({ id, name, kind, short: '', description: '', lead: null }),
      ),
    LOCAL_ORIGIN,
  );
  return id;
}

export function setEntityField(
  doc: Y.Doc,
  entityId: string,
  field: 'name' | 'kind' | 'short' | 'description' | 'lead',
  value: unknown,
): void {
  doc.transact(() => setField(maps(doc).entities, entityId, field, value), LOCAL_ORIGIN);
}

/**
 * An entity CAN be deleted while in use, unlike a deliverable. Anything still naming it reads
 * "(missing entity)" until it is re-pointed — the legacy app's behaviour, kept deliberately: an
 * entity that no longer exists is a fact about the org, and blocking the delete would not change it.
 */
export function deleteEntity(doc: Y.Doc, entityId: string): void {
  doc.transact(() => maps(doc).entities.delete(entityId), LOCAL_ORIGIN);
}

// ---- roster ---------------------------------------------------------------------------------------

/** Replace one directorate's subtree. This is the write the directory sync makes. */
export function setDirectorate(doc: Y.Doc, actor: string, value: unknown, origin = LOCAL_ORIGIN): void {
  doc.transact(() => maps(doc).roster.set(actor, value), origin);
}

/** Columns a chart uses — re-exported so callers do not need @raci/core for the common case. */
export { chartColumns };
