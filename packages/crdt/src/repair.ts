/**
 * Post-merge repair.
 *
 * A CRDT guarantees that every replica converges on the same STATE. It does not guarantee that
 * the state is meaningful: convergence is about bytes, not invariants. Two concurrent moves that
 * each look legal locally can merge into a parent cycle, and a delete racing an insert can leave
 * a row whose parent is gone. Both are inherent to editing a tree without a lock.
 *
 * So the invariants are restored after the fact, by a pass that is:
 *
 *   - DETERMINISTIC — the same merged document produces the same repair on every client, so each
 *     one can run it independently and still agree, with no extra round trip;
 *   - IDEMPOTENT — running it on an already-healthy document does nothing at all, so it is safe
 *     to attach to every update;
 *   - NON-DESTRUCTIVE — it never deletes. A broken row is re-rooted where a person can see it and
 *     put it back, which is the difference between "your colleague's row moved" and "your
 *     colleague's row is gone".
 *
 * Attach it with `attachAutoRepair`. Guarding on "did anything actually change" is what stops two
 * clients from repairing each other's repairs forever.
 */

import * as Y from 'yjs';
import { ChartNode, planRepair, type NodeMap, type RepairPlan } from '@raci/core';
import { fromYMap, maps } from './doc.js';

/** Origin tag for repair writes, so they can be told apart from a person's edits and never undone. */
export const REPAIR_ORIGIN = 'repair';

/** Every chart id that currently has rows. */
function chartIdsWithNodes(doc: Y.Doc): Set<string> {
  const out = new Set<string>();
  for (const [, raw] of maps(doc).nodes.entries()) {
    const chartId = raw.get('chartId');
    if (typeof chartId === 'string') out.add(chartId);
  }
  return out;
}

function nodesOfChart(doc: Y.Doc, chartId: string): NodeMap {
  const out: Record<string, ChartNode> = {};
  for (const [id, raw] of maps(doc).nodes.entries()) {
    const parsed = ChartNode.safeParse({ ...fromYMap(raw), id });
    if (parsed.success && parsed.data.chartId === chartId) out[id] = parsed.data;
  }
  return out;
}

export interface RepairResult {
  readonly chartId: string;
  readonly plan: RepairPlan;
}

/**
 * Repair every chart in the document. Returns only the charts that actually needed something,
 * so an empty array means the document was already well-formed.
 */
export function repairDocument(doc: Y.Doc): RepairResult[] {
  const results: RepairResult[] = [];
  for (const chartId of chartIdsWithNodes(doc)) {
    const plan = planRepair(nodesOfChart(doc, chartId));
    if (plan.reparent.length === 0) continue;
    doc.transact(() => {
      const m = maps(doc);
      for (const move of plan.reparent) {
        const record = m.nodes.get(move.id);
        if (!record) continue;
        record.set('parentId', move.parentId);
        record.set('order', move.order);
      }
    }, REPAIR_ORIGIN);
    results.push({ chartId, plan });
  }
  return results;
}

/**
 * Run the repair after every update that could have broken something.
 *
 * Only parentage can produce these faults, so the pass is skipped unless a `parentId` was written
 * — which makes it free on the overwhelming majority of updates (a keystroke, a drag, a cell).
 * Repair writes are ignored to avoid recursion, and `onRepair` lets the UI tell someone that a
 * row was moved out from under them rather than leaving them to notice.
 */
export function attachAutoRepair(
  doc: Y.Doc,
  onRepair?: (results: RepairResult[]) => void,
): () => void {
  let running = false;

  const handler = (_update: Uint8Array, origin: unknown) => {
    if (running || origin === REPAIR_ORIGIN) return;
    running = true;
    try {
      const results = repairDocument(doc);
      if (results.length > 0 && onRepair) onRepair(results);
    } finally {
      running = false;
    }
  };

  doc.on('update', handler);
  return () => doc.off('update', handler);
}

/**
 * A cheaper trigger for the hot path: only look when a parentId was actually touched.
 * Use in place of `attachAutoRepair` where updates are frequent (a live canvas drag).
 */
export function attachAutoRepairOnParentChange(
  doc: Y.Doc,
  onRepair?: (results: RepairResult[]) => void,
): () => void {
  let running = false;
  const nodes = maps(doc).nodes;

  // Derived from Yjs's own signature rather than written out: observeDeep is typed with `any`
  // internally, and restating that here would be the one place `any` leaked into this package.
  type DeepObserver = Parameters<Y.Map<unknown>['observeDeep']>[0];

  const handler: DeepObserver = (events, transaction) => {
    if (running || transaction.origin === REPAIR_ORIGIN) return;
    const touchedParent = events.some(
      (e) => e.target !== nodes && e.changes.keys.has('parentId'),
    );
    // A brand-new row can arrive naming a parent that a concurrent delete removed, so an add has
    // to be checked too, not only an explicit reparent.
    const added = events.some((e) => e.target === nodes && e.changes.keys.size > 0);
    if (!touchedParent && !added) return;

    running = true;
    try {
      const results = repairDocument(doc);
      if (results.length > 0 && onRepair) onRepair(results);
    } finally {
      running = false;
    }
  };

  nodes.observeDeep(handler);
  return () => nodes.unobserveDeep(handler);
}
