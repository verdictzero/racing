import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import demo from '../../core/src/__fixtures__/demo-workspace.json' with { type: 'json' };
import { ACTORS, importLegacy } from '@raci/core';
import { docFromWorkspace, maps, readWorkspace } from './doc.js';
import { addRosterUnit, setRosterLead } from './mutations.js';
import { ensureDirectorateUnit, setActorLabel } from './roster-edits.js';
import { createUndoManager } from './undo.js';

const { workspace } = importLegacy(demo);

describe('setActorLabel', () => {
  it('renames one directorate and leaves the other five alone', () => {
    const doc = docFromWorkspace(workspace);
    setActorLabel(doc, 'cyber', 'Cyber & EW');
    const labels = readWorkspace(doc).actorLabels;
    expect(labels.cyber).toBe('Cyber & EW');
    for (const actor of ACTORS) {
      if (actor !== 'cyber') expect(labels[actor]).toBe(workspace.actorLabels[actor]);
    }
  });

  it('works on a document that has no labels yet', () => {
    const doc = new Y.Doc();
    setActorLabel(doc, 'ocio', 'Office of the CIO');
    expect(readWorkspace(doc).actorLabels).toEqual({ ocio: 'Office of the CIO' });
  });

  it('is one undoable step', () => {
    const doc = docFromWorkspace(workspace);
    const undo = createUndoManager(doc);
    setActorLabel(doc, 'sw', 'Software');
    undo.undo();
    expect(readWorkspace(doc).actorLabels.sw).toBe(workspace.actorLabels.sw);
  });
});

describe('undo reaches the roster', () => {
  it('takes back an added division, a lead, and a rename, one step at a time', () => {
    const doc = docFromWorkspace(workspace);
    const undo = createUndoManager(doc, { captureTimeout: 0 });
    const before = readWorkspace(doc).roster;
    const divisionId = addRosterUnit(doc, 'mission', 'Division 5')!;
    setRosterLead(doc, divisionId, { id: 'p_x', name: 'Kim' });
    expect(readWorkspace(doc).roster.mission!.divisions.at(-1)!.chief).toEqual({ id: 'p_x', name: 'Kim' });
    undo.undo();
    expect(readWorkspace(doc).roster.mission!.divisions.at(-1)!.chief).toBeNull();
    undo.undo();
    expect(readWorkspace(doc).roster).toEqual(before);
  });
});

describe('ensureDirectorateUnit', () => {
  it('lets a workspace that started empty take a division and a lead', () => {
    const doc = new Y.Doc();
    // Nothing to hang a division on yet.
    expect(addRosterUnit(doc, 'infra', 'Division 1')).toBeNull();
    ensureDirectorateUnit(doc, 'infra');
    const divisionId = addRosterUnit(doc, 'infra', 'Division 1');
    expect(divisionId).toMatch(/^dv_/);
    setRosterLead(doc, 'infra', { id: 'p_lead', name: 'Pat' });
    const roster = readWorkspace(doc).roster;
    expect(roster.infra!.divisions.map((d) => d.name)).toEqual(['Division 1']);
    expect(roster.infra!.lead).toEqual({ id: 'p_lead', name: 'Pat' });
  });

  it('is a no-op, and writes nothing, when the directorate exists', () => {
    const doc = docFromWorkspace(workspace);
    let updates = 0;
    doc.on('update', () => updates++);
    ensureDirectorateUnit(doc, 'cyber');
    expect(updates).toBe(0);
    expect(readWorkspace(doc).roster).toEqual(workspace.roster);
  });

  it('migrates a pre-flattening document forward instead of hiding its other directorates', () => {
    const doc = new Y.Doc();
    const { cyber: _dropped, ...rest } = workspace.roster;
    doc.transact(() => {
      for (const [actor, directorate] of Object.entries(rest)) maps(doc).roster.set(actor, directorate);
    }, 'load');
    ensureDirectorateUnit(doc, 'cyber');
    const roster = readWorkspace(doc).roster;
    for (const [actor, directorate] of Object.entries(rest)) expect(roster[actor as keyof typeof roster]).toEqual(directorate);
    expect(roster.cyber).toEqual({ lead: null, externalId: null, divisions: [] });
  });
});
