import { describe, it, expect } from 'vitest';
import demo from '../../core/src/__fixtures__/demo-workspace.json' with { type: 'json' };
import { chartsInTabOrder, flowsInOrder, importLegacy, type Chart } from '@raci/core';
import { docFromWorkspace, readWorkspace } from './doc.js';
import { LOCAL_ORIGIN, addFlow, deleteChart, deleteNode, detachStrandedAnchors, setStepField } from './mutations.js';
import { createUndoManager } from './undo.js';

const { workspace } = importLegacy(demo);
const chart = chartsInTabOrder(workspace).find((c) => !c.custom && Object.keys(c.nodes).length > 2)!;

/** A row with a child, and another row outside its subtree. */
function rows(c: Chart) {
  const nodes = Object.values(c.nodes);
  const parent = nodes.find((n) => nodes.some((k) => k.parentId === n.id))!;
  const child = nodes.find((n) => n.parentId === parent.id)!;
  const inside = new Set<string>([parent.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) if (n.parentId && inside.has(n.parentId) && !inside.has(n.id)) { inside.add(n.id); grew = true; }
  }
  const other = nodes.find((n) => !inside.has(n.id))!;
  return { parent, child, other };
}

describe('detachStrandedAnchors', () => {
  it('makes a flow standalone when its row goes with a delete, and leaves the others anchored', () => {
    const doc = docFromWorkspace(workspace);
    const { parent, child, other } = rows(chart);
    const underChild = addFlow(doc, 'Under the child', { anchor: { chartId: chart.id, nodeId: child.id } });
    const underOther = addFlow(doc, 'Under another row', { anchor: { chartId: chart.id, nodeId: other.id } });
    let detached = 0;
    doc.transact(() => {
      deleteNode(doc, chart.id, parent.id);
      detached = detachStrandedAnchors(doc, chart.id);
    }, LOCAL_ORIGIN);
    const after = readWorkspace(doc);
    expect(detached).toBe(1);
    expect(after.flows[underChild]!.anchor).toBeNull();
    expect(after.flows[underOther]!.anchor).toEqual({ chartId: chart.id, nodeId: other.id });
  });

  it('comes back with the row in one undo', () => {
    const doc = docFromWorkspace(workspace);
    const { parent, child } = rows(chart);
    const flow = addFlow(doc, 'Anchored', { anchor: { chartId: chart.id, nodeId: child.id } });
    const undo = createUndoManager(doc, { captureTimeout: 0 });
    doc.transact(() => {
      deleteNode(doc, chart.id, parent.id);
      detachStrandedAnchors(doc, chart.id);
    }, LOCAL_ORIGIN);
    undo.undo();
    const after = readWorkspace(doc);
    expect(after.charts[chart.id]!.nodes[child.id]).toBeDefined();
    expect(after.flows[flow]!.anchor).toEqual({ chartId: chart.id, nodeId: child.id });
  });
});

describe('deleteChart', () => {
  it('detaches the flows anchored to it and says how many', () => {
    const doc = docFromWorkspace(workspace);
    const { other } = rows(chart);
    const flow = addFlow(doc, 'Anchored', { anchor: { chartId: chart.id, nodeId: other.id } });
    expect(deleteChart(doc, chart.id)).toBe(1);
    expect(readWorkspace(doc).flows[flow]!.anchor).toBeNull();
  });

  it('keeps a bound step’s bind, as index.html never drops one silently', () => {
    const doc = docFromWorkspace(workspace);
    const { other } = rows(chart);
    const step = Object.values(flowsInOrder(workspace)[0]!.steps).find((t) => t.kind !== 'subflow')!;
    setStepField(doc, step.id, 'bind', { chartId: chart.id, nodeId: other.id });
    deleteChart(doc, chart.id);
    const flowId = flowsInOrder(workspace)[0]!.id;
    expect(readWorkspace(doc).flows[flowId]!.steps[step.id]!.bind).toEqual({ chartId: chart.id, nodeId: other.id });
  });
});
