import { describe, it, expect } from 'vitest';
import demo from '../../core/src/__fixtures__/demo-workspace.json' with { type: 'json' };
import { clearedWorkspace, importLegacy } from '@raci/core';
import { docFromWorkspace, maps, readWorkspace } from './doc.js';
import { addRosterUnit, LOCAL_ORIGIN, setRosterUnitField } from './mutations.js';
import { replaceWorkspace } from './replace.js';
import { createUndoManager } from './undo.js';

const { workspace } = importLegacy(demo);

/** A directorate the demo roster holds, to edit under. */
function aDirectorate(doc: ReturnType<typeof docFromWorkspace>): string {
  for (const [id, raw] of maps(doc).rosterUnits.entries()) {
    if (raw.get('kind') === 'directorate') return id;
  }
  throw new Error('the demo has no directorate');
}

describe('createUndoManager', () => {
  // index.html's undo is a whole-state snapshot, so a roster edit is as undoable as a chart edit.
  it('undoes a roster edit', () => {
    const doc = docFromWorkspace(workspace);
    const undo = createUndoManager(doc, { captureTimeout: 0 });
    const dir = aDirectorate(doc);
    const id = addRosterUnit(doc, dir, 'New division')!;
    setRosterUnitField(doc, id, 'name', 'Renamed');
    expect(maps(doc).rosterUnits.get(id)?.get('name')).toBe('Renamed');
    undo.undo();
    expect(maps(doc).rosterUnits.get(id)?.get('name')).toBe('New division');
    undo.undo();
    expect(maps(doc).rosterUnits.has(id)).toBe(false);
  });

  // Load, Demo and Clear are one step on index.html's undo stack; a replace made under the local
  // origin is one step here, roster included.
  it('undoes a whole-workspace replace in one step, roster and all', () => {
    const doc = docFromWorkspace(workspace);
    const before = readWorkspace(doc);
    const undo = createUndoManager(doc, { captureTimeout: 0 });
    replaceWorkspace(doc, clearedWorkspace(before), LOCAL_ORIGIN);
    expect(Object.keys(readWorkspace(doc).charts)).toHaveLength(1);
    expect(undo.undoStack).toHaveLength(1);
    undo.undo();
    const after = readWorkspace(doc);
    expect(Object.keys(after.charts).sort()).toEqual(Object.keys(before.charts).sort());
    expect(Object.keys(after.nodes ?? {}).length).toBe(Object.keys(before.nodes ?? {}).length);
    expect(after.roster).toEqual(before.roster);
  });
});
