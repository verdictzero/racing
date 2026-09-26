/**
 * The writes the flow screen's chrome makes — its toolbar, strips, gallery, table, party panel and
 * popovers — that mutations.ts has no single call for: a flow's header fields, a whole flow deleted
 * or duplicated, and a bound step's taken-back columns.
 *
 * Each is one transaction tagged LOCAL_ORIGIN, as every mutation is: a peer sees the whole change
 * at once, and one Ctrl+Z takes it back.
 */

import type * as Y from 'yjs';
import { isOrderKey, keyBetween, newId, type Flow, type FlowStep } from '@raci/core';
import { fromYMap, maps, setField, toYMap } from './doc.js';
import { LOCAL_ORIGIN } from './mutations.js';

/** The header fields of a flow the chrome writes. */
export type FlowHeaderField = keyof Pick<Flow, 'name' | 'mode' | 'sourceChartId' | 'status' | 'finalizedAt' | 'anchor'>;

/** One header field of a flow — its name, mode, source chart, status, anchor. */
export function setFlowField<K extends FlowHeaderField>(doc: Y.Doc, flowId: string, field: K, value: Flow[K]): void {
  doc.transact(() => setField(maps(doc).flows, flowId, field, value), LOCAL_ORIGIN);
}

/**
 * A bound step's taken-back columns (index.html's `bindOverrides`): a column listed reads the step's
 * own letters, one not listed reads its chart row's.
 */
export function setStepOverrides(doc: Y.Doc, stepId: string, columns: readonly string[]): void {
  doc.transact(
    () => setField(maps(doc).steps, stepId, 'bindOverrides', [...new Set(columns)] satisfies FlowStep['bindOverrides']),
    LOCAL_ORIGIN,
  );
}

/**
 * index.html's bizDeleteCase: the flow, and every step, handoff and frame in it. Nested-flow boxes in
 * OTHER flows that point at it are left pointing at nothing, exactly as the source leaves them — the
 * confirmation said so before the delete.
 */
export function deleteFlow(doc: Y.Doc, flowId: string): void {
  doc.transact(() => {
    const m = maps(doc);
    m.flows.delete(flowId);
    for (const records of [m.steps, m.edges, m.groups]) {
      for (const [id, raw] of [...records.entries()]) {
        if (raw.get('flowId') === flowId) records.delete(id);
      }
    }
  }, LOCAL_ORIGIN);
}

/** After every flow's key, so a new one lists last — where index.html's push puts it. */
function nextFlowOrder(flows: Y.Map<Y.Map<unknown>>): string {
  let last: string | null = null;
  for (const raw of flows.values()) {
    const key = raw.get('order');
    if (typeof key === 'string' && isOrderKey(key) && (last === null || key > last)) last = key;
  }
  return keyBetween(last, null);
}

/** A deep copy of a plain value read out of the document, so the copy shares nothing with it. */
const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

/**
 * index.html's duplicateFlow: the whole flow under fresh ids, named `name`, a Draft whatever the
 * original was, last among the flows. Every step and frame is re-minted and the handoffs rewired
 * through the new ids, so the copy is wired exactly like the original and shares nothing with it.
 * A nested-flow box keeps pointing at the SAME flow — the box is a reference, and copying the host
 * never meant copying what it refers to; its exposed mating points name steps over THERE, so they
 * survive the re-mint untouched. Returns the copy's id, or null when there is no such flow.
 */
export function duplicateFlow(doc: Y.Doc, flowId: string, name: string): string | null {
  const m = maps(doc);
  const src = m.flows.get(flowId);
  if (!src) return null;
  const id = newId('flow');
  doc.transact(() => {
    const header = clone(fromYMap(src));
    m.flows.set(id, toYMap({ ...header, id, name, status: 'draft', finalizedAt: null, order: nextFlowOrder(m.flows) }));
    const groupIds = new Map<string, string>();
    const stepIds = new Map<string, string>();
    for (const [gid, raw] of m.groups.entries()) if (raw.get('flowId') === flowId) groupIds.set(gid, newId('group'));
    for (const [sid, raw] of m.steps.entries()) if (raw.get('flowId') === flowId) stepIds.set(sid, newId('step'));
    for (const [gid, nid] of groupIds) {
      m.groups.set(nid, toYMap({ ...clone(fromYMap(m.groups.get(gid)!)), id: nid, flowId: id }));
    }
    for (const [sid, nid] of stepIds) {
      const step = clone(fromYMap(m.steps.get(sid)!));
      const groupId = typeof step.groupId === 'string' ? groupIds.get(step.groupId) ?? null : null;
      m.steps.set(nid, toYMap({ ...step, id: nid, flowId: id, groupId }));
    }
    const remap = (x: unknown) => (typeof x === 'string' ? stepIds.get(x) ?? x : x);
    for (const [, raw] of [...m.edges.entries()]) {
      if (raw.get('flowId') !== flowId) continue;
      const edge = clone(fromYMap(raw));
      const eid = newId('edge');
      m.edges.set(eid, toYMap({
        ...edge,
        id: eid,
        flowId: id,
        from: remap(edge.from),
        to: remap(edge.to),
        fromPort: remap(edge.fromPort ?? null),
        toPort: remap(edge.toPort ?? null),
      }));
    }
  }, LOCAL_ORIGIN);
  return id;
}
