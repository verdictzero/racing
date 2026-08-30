/**
 * The Yjs document: how a workspace is laid out for concurrent editing.
 *
 * THE SHAPE
 *
 *   Y.Doc
 *   ├── meta          Y.Map   schemaVersion, workspace-level labels
 *   ├── charts        Y.Map<chartId, Y.Map>      chart header fields
 *   ├── chartOrder    Y.Map<chartId, string>     order key per chart tab
 *   ├── nodes         Y.Map<nodeId,  Y.Map>      EVERY chart's rows, flat, in one map
 *   ├── flows         Y.Map<flowId,  Y.Map>
 *   ├── steps         Y.Map<stepId,  Y.Map>      every flow's steps, flat
 *   ├── edges         Y.Map<edgeId,  Y.Map>
 *   ├── groups        Y.Map<groupId, Y.Map>
 *   ├── artifacts     Y.Map<artifactId, Y.Map>
 *   ├── entities      Y.Map<entityId,   Y.Map>
 *   └── roster        Y.Map            the org tree, kept as plain JSON (see below)
 *
 * WHY THE COLLECTIONS ARE FLAT AND GLOBAL
 * Nodes live in ONE map keyed by node id, not nested under their chart, and each node carries its
 * own chartId. Two people editing different rows then touch two different Y.Map entries, and Yjs
 * merges them without either edit knowing about the other. Nesting a per-chart map inside a chart
 * entry would work too, but it makes moving a row between charts a delete-and-recreate — the same
 * trap that made the legacy nested array unusable here.
 *
 * WHY EACH RECORD IS A Y.MAP AND NOT A PLAIN OBJECT
 * A plain object stored in a Y.Map is one opaque value: last writer wins for the WHOLE record. Two
 * people editing a row's name and its RACI cell at the same moment would lose one of the two
 * edits. As a Y.Map, each field merges independently and both survive.
 *
 * WHERE THAT RULE IS DELIBERATELY BROKEN
 *   - `raci` and `parties` are nested Y.Maps, because per-cell merging is exactly what a
 *     responsibility matrix needs: two people assigning different columns of one row is the
 *     normal case, not a conflict.
 *   - `documents`, `inputs`, `outputs`, `artifactIds`, `via`, `ports` are plain arrays. They are
 *     short, they are edited as a unit ("attach this deliverable"), and last-writer-wins on a
 *     five-element list is a cost worth paying to avoid a Y.Array per field on every row.
 *   - `roster` is one plain JSON value. It is written by the directory sync as a whole tree, not
 *     hand-edited row by row, so per-field merging would buy nothing. Hand edits to it go through
 *     the same replace-the-subtree path.
 *
 * TEXT FIELDS ARE PLAIN STRINGS, NOT Y.TEXT. Y.Text would give character-level merging inside a
 * description, which sounds better than it is: it costs a Y.Text object per field on every record
 * (~810 rows × 2 fields on the demo workspace alone), and the fields here are short labels typed
 * by one person at a time. If someone later wants true collaborative prose in the description
 * field, that field alone can become a Y.Text without disturbing anything else.
 */

import * as Y from 'yjs';
import {
  Artifact,
  Chart,
  ChartNode,
  Entity,
  Flow,
  FlowEdge,
  FlowGroup,
  FlowStep,
  Workspace,
  type Roster,
} from '@raci/core';

export const TOP = {
  meta: 'meta',
  charts: 'charts',
  chartOrder: 'chartOrder',
  nodes: 'nodes',
  flows: 'flows',
  steps: 'steps',
  edges: 'edges',
  groups: 'groups',
  artifacts: 'artifacts',
  entities: 'entities',
  roster: 'roster',
} as const;

/** Fields kept as a nested Y.Map so two people can write different keys concurrently. */
const NESTED_MAP_FIELDS = new Set(['raci', 'parties']);

export interface DocMaps {
  readonly meta: Y.Map<unknown>;
  readonly charts: Y.Map<Y.Map<unknown>>;
  readonly chartOrder: Y.Map<string>;
  readonly nodes: Y.Map<Y.Map<unknown>>;
  readonly flows: Y.Map<Y.Map<unknown>>;
  readonly steps: Y.Map<Y.Map<unknown>>;
  readonly edges: Y.Map<Y.Map<unknown>>;
  readonly groups: Y.Map<Y.Map<unknown>>;
  readonly artifacts: Y.Map<Y.Map<unknown>>;
  readonly entities: Y.Map<Y.Map<unknown>>;
  readonly roster: Y.Map<unknown>;
}

export function maps(doc: Y.Doc): DocMaps {
  return {
    meta: doc.getMap(TOP.meta),
    charts: doc.getMap(TOP.charts),
    chartOrder: doc.getMap(TOP.chartOrder),
    nodes: doc.getMap(TOP.nodes),
    flows: doc.getMap(TOP.flows),
    steps: doc.getMap(TOP.steps),
    edges: doc.getMap(TOP.edges),
    groups: doc.getMap(TOP.groups),
    artifacts: doc.getMap(TOP.artifacts),
    entities: doc.getMap(TOP.entities),
    roster: doc.getMap(TOP.roster),
  };
}

// ---- record <-> Y.Map ------------------------------------------------------------------------

/** Turn a plain domain record into a Y.Map, nesting the fields that need per-key merging. */
export function toYMap(record: Record<string, unknown>): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(record)) {
    if (NESTED_MAP_FIELDS.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      const inner = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) inner.set(k, v);
      m.set(key, inner);
    } else {
      m.set(key, value);
    }
  }
  return m;
}

/** Read a Y.Map back out as a plain object, flattening any nested Y.Maps. */
export function fromYMap(m: Y.Map<unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of m.entries()) {
    out[key] = value instanceof Y.Map ? Object.fromEntries(value.entries()) : value;
  }
  return out;
}

/**
 * Write one field of a record.
 *
 * `raci`/`parties` take a column key so the write lands on the inner map's entry rather than
 * replacing the whole cell set — which is what keeps two people assigning different columns of
 * one row from clobbering each other.
 */
export function setField(
  container: Y.Map<Y.Map<unknown>>,
  id: string,
  field: string,
  value: unknown,
  subKey?: string,
): void {
  const record = container.get(id);
  if (!record) throw new Error(`no such record: ${id}`);
  if (subKey !== undefined) {
    let inner = record.get(field);
    if (!(inner instanceof Y.Map)) {
      inner = new Y.Map<unknown>();
      record.set(field, inner);
    }
    if (value === undefined || value === '') (inner as Y.Map<unknown>).delete(subKey);
    else (inner as Y.Map<unknown>).set(subKey, value);
    return;
  }
  record.set(field, value);
}

// ---- workspace <-> doc ------------------------------------------------------------------------

/**
 * Load a workspace into a document.
 *
 * Runs in a single transaction so remote peers see one coherent update rather than a storm of
 * per-record ones, and tags the origin `'load'` so an observer can tell a bulk load from a user's
 * keystroke (the undo manager uses exactly this to avoid making an import undoable).
 */
export function loadWorkspace(doc: Y.Doc, ws: Workspace): void {
  const m = maps(doc);
  doc.transact(() => {
    m.meta.set('schemaVersion', ws.schemaVersion);
    m.meta.set('actorLabels', ws.actorLabels);
    m.meta.set('columnLabels', ws.columnLabels);
    m.meta.set('columnShort', ws.columnShort);
    m.meta.set('columnActor', ws.columnActor);

    for (const [id, chart] of Object.entries(ws.charts)) {
      const { nodes, ...header } = chart;
      m.charts.set(id, toYMap(header));
      for (const [nodeId, node] of Object.entries(nodes)) m.nodes.set(nodeId, toYMap(node));
    }
    for (const [id, order] of Object.entries(ws.chartOrder)) m.chartOrder.set(id, order);

    for (const [id, flow] of Object.entries(ws.flows)) {
      const { steps, edges, groups, ...header } = flow;
      m.flows.set(id, toYMap(header));
      for (const [sid, step] of Object.entries(steps)) m.steps.set(sid, toYMap(step));
      for (const [eid, edge] of Object.entries(edges)) m.edges.set(eid, toYMap(edge));
      for (const [gid, group] of Object.entries(groups)) m.groups.set(gid, toYMap(group));
    }

    for (const [id, a] of Object.entries(ws.artifacts)) m.artifacts.set(id, toYMap(a));
    for (const [id, e] of Object.entries(ws.entities)) m.entities.set(id, toYMap(e));
    for (const [actor, d] of Object.entries(ws.roster)) m.roster.set(actor, d);
  }, 'load');
}

/**
 * Read the whole workspace back out, validated.
 *
 * Every record goes through its Zod schema on the way out rather than being cast. A Yjs document
 * is shared mutable state that any peer can write to; a client on an older build, or one with a
 * bug, can put a value in it that this build does not expect. Parsing here means a bad record is
 * a loud, located error instead of a mystery further downstream.
 */
export function readWorkspace(doc: Y.Doc): Workspace {
  const m = maps(doc);

  const nodesByChart = new Map<string, Record<string, ChartNode>>();
  for (const [id, raw] of m.nodes.entries()) {
    const node = ChartNode.parse({ ...fromYMap(raw), id });
    const bucket = nodesByChart.get(node.chartId);
    if (bucket) bucket[id] = node;
    else nodesByChart.set(node.chartId, { [id]: node });
  }

  const charts: Record<string, Chart> = {};
  for (const [id, raw] of m.charts.entries()) {
    charts[id] = Chart.parse({ ...fromYMap(raw), id, nodes: nodesByChart.get(id) ?? {} });
  }

  const stepsByFlow = new Map<string, Record<string, FlowStep>>();
  for (const [id, raw] of m.steps.entries()) {
    const step = FlowStep.parse({ ...fromYMap(raw), id });
    const bucket = stepsByFlow.get(step.flowId);
    if (bucket) bucket[id] = step;
    else stepsByFlow.set(step.flowId, { [id]: step });
  }
  const edgesByFlow = new Map<string, Record<string, FlowEdge>>();
  for (const [id, raw] of m.edges.entries()) {
    const edge = FlowEdge.parse({ ...fromYMap(raw), id });
    const bucket = edgesByFlow.get(edge.flowId);
    if (bucket) bucket[id] = edge;
    else edgesByFlow.set(edge.flowId, { [id]: edge });
  }
  const groupsByFlow = new Map<string, Record<string, FlowGroup>>();
  for (const [id, raw] of m.groups.entries()) {
    const group = FlowGroup.parse({ ...fromYMap(raw), id });
    const bucket = groupsByFlow.get(group.flowId);
    if (bucket) bucket[id] = group;
    else groupsByFlow.set(group.flowId, { [id]: group });
  }

  const flows: Record<string, Flow> = {};
  for (const [id, raw] of m.flows.entries()) {
    flows[id] = Flow.parse({
      ...fromYMap(raw),
      id,
      steps: stepsByFlow.get(id) ?? {},
      edges: edgesByFlow.get(id) ?? {},
      groups: groupsByFlow.get(id) ?? {},
    });
  }

  const artifacts: Record<string, Artifact> = {};
  for (const [id, raw] of m.artifacts.entries()) {
    artifacts[id] = Artifact.parse({ ...fromYMap(raw), id });
  }
  const entities: Record<string, Entity> = {};
  for (const [id, raw] of m.entities.entries()) {
    entities[id] = Entity.parse({ ...fromYMap(raw), id });
  }

  const roster: Record<string, unknown> = {};
  for (const [actor, d] of m.roster.entries()) roster[actor] = d;

  return Workspace.parse({
    schemaVersion: m.meta.get('schemaVersion') ?? 1,
    charts,
    chartOrder: Object.fromEntries(m.chartOrder.entries()),
    flows,
    artifacts,
    entities,
    roster: roster as Roster,
    actorLabels: m.meta.get('actorLabels') ?? {},
    columnLabels: m.meta.get('columnLabels') ?? {},
    columnShort: m.meta.get('columnShort') ?? {},
    columnActor: m.meta.get('columnActor') ?? {},
  });
}

/** Just one chart, for the common case where a screen only needs the chart it is showing. */
export function readChart(doc: Y.Doc, chartId: string): Chart | null {
  const m = maps(doc);
  const raw = m.charts.get(chartId);
  if (!raw) return null;
  const nodes: Record<string, ChartNode> = {};
  for (const [id, rawNode] of m.nodes.entries()) {
    const node = ChartNode.parse({ ...fromYMap(rawNode), id });
    if (node.chartId === chartId) nodes[id] = node;
  }
  return Chart.parse({ ...fromYMap(raw), id: chartId, nodes });
}

/** A fresh document holding `ws`. */
export function docFromWorkspace(ws: Workspace): Y.Doc {
  const doc = new Y.Doc();
  loadWorkspace(doc, ws);
  return doc;
}
