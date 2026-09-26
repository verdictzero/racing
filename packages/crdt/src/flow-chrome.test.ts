import { describe, it, expect } from 'vitest';
import demo from '../../core/src/__fixtures__/demo-workspace.json' with { type: 'json' };
import { flowsInOrder, importLegacy } from '@raci/core';
import { docFromWorkspace, readWorkspace } from './doc.js';
import { addFlow } from './mutations.js';
import { deleteFlow, duplicateFlow, setFlowField, setStepOverrides } from './flow-chrome.js';
import { createUndoManager } from './undo.js';

const { workspace } = importLegacy(demo);
const firstFlow = () => flowsInOrder(workspace)[0]!;

describe('setFlowField', () => {
  it('writes one header field and leaves the steps alone', () => {
    const doc = docFromWorkspace(workspace);
    const f = firstFlow();
    setFlowField(doc, f.id, 'mode', 'linked');
    setFlowField(doc, f.id, 'status', 'final');
    const after = readWorkspace(doc).flows[f.id]!;
    expect(after.mode).toBe('linked');
    expect(after.status).toBe('final');
    expect(after.steps).toEqual(f.steps);
  });

  it('is undoable', () => {
    const doc = docFromWorkspace(workspace);
    const undo = createUndoManager(doc, { captureTimeout: 0 });
    const f = firstFlow();
    setFlowField(doc, f.id, 'name', 'Renamed');
    undo.undo();
    expect(readWorkspace(doc).flows[f.id]!.name).toBe(f.name);
  });
});

describe('setStepOverrides', () => {
  it('stores each column once', () => {
    const doc = docFromWorkspace(workspace);
    const step = Object.values(firstFlow().steps)[0]!;
    setStepOverrides(doc, step.id, ['hq', 'cyber', 'hq']);
    expect(readWorkspace(doc).flows[firstFlow().id]!.steps[step.id]!.bindOverrides).toEqual(['hq', 'cyber']);
  });
});

describe('deleteFlow', () => {
  it('removes the flow with every step, handoff and frame in it, and nothing else', () => {
    const doc = docFromWorkspace(workspace);
    const [a, b] = flowsInOrder(workspace);
    deleteFlow(doc, a!.id);
    const after = readWorkspace(doc);
    expect(after.flows[a!.id]).toBeUndefined();
    expect(after.flows[b!.id]).toEqual(workspace.flows[b!.id]);
  });

  it('is one undoable step', () => {
    const doc = docFromWorkspace(workspace);
    const undo = createUndoManager(doc, { captureTimeout: 0 });
    deleteFlow(doc, firstFlow().id);
    undo.undo();
    expect(readWorkspace(doc).flows[firstFlow().id]).toEqual(workspace.flows[firstFlow().id]);
  });
});

describe('duplicateFlow', () => {
  it('copies the flow under fresh ids, rewired, as a Draft, last in order', () => {
    const doc = docFromWorkspace(workspace);
    const src = firstFlow();
    setFlowField(doc, src.id, 'status', 'final');
    const id = duplicateFlow(doc, src.id, 'Copy of it')!;
    const after = readWorkspace(doc);
    const copy = after.flows[id]!;
    expect(copy.name).toBe('Copy of it');
    expect(copy.status).toBe('draft');
    expect(copy.finalizedAt).toBeNull();
    expect(flowsInOrder(after).at(-1)!.id).toBe(id);
    expect(Object.keys(copy.steps)).toHaveLength(Object.keys(src.steps).length);
    expect(Object.keys(copy.edges)).toHaveLength(Object.keys(src.edges).length);
    expect(Object.keys(copy.groups)).toHaveLength(Object.keys(src.groups).length);
    // Nothing shared: every id is new, and every handoff joins two of the copy's own steps.
    for (const sid of Object.keys(copy.steps)) expect(src.steps[sid]).toBeUndefined();
    for (const e of Object.values(copy.edges)) {
      expect(copy.steps[e.from]).toBeDefined();
      expect(copy.steps[e.to]).toBeDefined();
    }
    for (const s of Object.values(copy.steps)) if (s.groupId) expect(copy.groups[s.groupId]).toBeDefined();
    // The original is untouched.
    expect(after.flows[src.id]!.steps).toEqual(src.steps);
  });

  it('keeps a nested box pointing at the same flow', () => {
    const doc = docFromWorkspace(workspace);
    const host = flowsInOrder(workspace).find((f) => Object.values(f.steps).some((s) => s.kind === 'subflow'))!;
    const id = duplicateFlow(doc, host.id, 'Copy')!;
    const refs = (steps: Record<string, { kind: string; refId: string | null }>) =>
      Object.values(steps).filter((s) => s.kind === 'subflow').map((s) => s.refId);
    expect(refs(readWorkspace(doc).flows[id]!.steps)).toEqual(refs(host.steps));
  });

  it('answers null for a flow that is not there', () => {
    const doc = docFromWorkspace(workspace);
    expect(duplicateFlow(doc, 'b_missing', 'x')).toBeNull();
    expect(addFlow(doc, 'fresh')).toMatch(/^b_/);
  });
});
