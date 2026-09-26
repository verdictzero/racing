import { describe, it, expect } from 'vitest';
import demo from '../../core/src/__fixtures__/demo-workspace.json' with { type: 'json' };
import { importLegacy } from '@raci/core';
import { docFromWorkspace, readWorkspace } from './doc.js';
import { addGroupFrame, moveSteps, setGroupField } from './flow-canvas.js';
import { createUndoManager } from './undo.js';

const { workspace } = importLegacy(demo);
const tabletop = Object.values(workspace.flows).find((f) => f.name.startsWith('Cyber Incident'))!;
const frameId = Object.keys(tabletop.groups)[0]!;
const [first, second] = Object.values(tabletop.steps);

describe('setGroupField', () => {
  it('writes one field of one frame and leaves the rest alone', () => {
    const doc = docFromWorkspace(workspace);
    setGroupField(doc, frameId, 'collapsed', true);
    setGroupField(doc, frameId, 'color', 'c');
    const g = readWorkspace(doc).flows[tabletop.id]!.groups[frameId]!;
    expect(g.collapsed).toBe(true);
    expect(g.color).toBe('c');
    expect(g.name).toBe(tabletop.groups[frameId]!.name);
  });

  it('is one undoable step per call', () => {
    const doc = docFromWorkspace(workspace);
    const undo = createUndoManager(doc, { captureTimeout: 0 });
    setGroupField(doc, frameId, 'name', 'Contain and recover');
    undo.undo();
    expect(readWorkspace(doc).flows[tabletop.id]!.groups[frameId]!.name).toBe(tabletop.groups[frameId]!.name);
  });
});

describe('addGroupFrame', () => {
  it('makes the frame and moves the steps into it, one transaction, one undo step', () => {
    const doc = docFromWorkspace(workspace);
    const undo = createUndoManager(doc, { captureTimeout: 0 });
    const id = addGroupFrame(doc, tabletop.id, { name: 'Group 2', color: 'p', x: 41.6, y: 36.2 }, [first!.id, second!.id]);
    const flow = readWorkspace(doc).flows[tabletop.id]!;
    expect(flow.groups[id]).toMatchObject({ name: 'Group 2', color: 'p', collapsed: false, x: 42, y: 36 });
    expect(flow.steps[first!.id]!.groupId).toBe(id);
    expect(flow.steps[second!.id]!.groupId).toBe(id);
    undo.undo();
    const back = readWorkspace(doc).flows[tabletop.id]!;
    expect(back.groups[id]).toBeUndefined();
    expect(back.steps[first!.id]!.groupId).toBe(first!.groupId);
  });

  it('refuses a flow that is not there', () => {
    const doc = docFromWorkspace(workspace);
    expect(() => addGroupFrame(doc, 'nope', { name: 'G', color: 'p', x: 0, y: 0 }, [])).toThrow(/no such flow/);
  });
});

describe('moveSteps', () => {
  it('puts every box down, rounded, as one undo step', () => {
    const doc = docFromWorkspace(workspace);
    const undo = createUndoManager(doc, { captureTimeout: 0 });
    moveSteps(doc, [{ id: first!.id, x: 100.4, y: 200.6 }, { id: second!.id, x: 300, y: 400 }, { id: 'gone', x: 1, y: 1 }]);
    let steps = readWorkspace(doc).flows[tabletop.id]!.steps;
    expect([steps[first!.id]!.x, steps[first!.id]!.y]).toEqual([100, 201]);
    expect([steps[second!.id]!.x, steps[second!.id]!.y]).toEqual([300, 400]);
    undo.undo();
    steps = readWorkspace(doc).flows[tabletop.id]!.steps;
    expect([steps[first!.id]!.x, steps[second!.id]!.x]).toEqual([first!.x, second!.x]);
  });
});
