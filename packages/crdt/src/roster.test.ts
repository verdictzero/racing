import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import demo from '../../core/src/__fixtures__/demo-workspace.json' with { type: 'json' };
import { ACTORS, importLegacy } from '@raci/core';
import { docFromWorkspace, loadWorkspace, maps, readWorkspace } from './doc.js';
import { flattenRoster, nestRoster, childKindOf } from './roster.js';
import {
  addRosterUnit,
  deleteRosterUnit,
  moveRosterUnit,
  rosterChildren,
  setDirectorate,
  setRosterLead,
  setRosterUnitField,
} from './mutations.js';

const { workspace } = importLegacy(demo);
const roster = workspace.roster;
const firstDivision = roster.cyber!.divisions[0]!;
const firstBranch = firstDivision.branches[0]!;
const firstTeam = firstBranch.teams[0]!;

describe('flatten and nest', () => {
  it('round-trips the real 694-unit demo roster byte for byte', () => {
    // The strangler contract: index.html keeps shipping and reads the same JSON. A roster that
    // came back reordered or reshaped would be a silent fork between the two apps.
    expect(nestRoster(flattenRoster(roster))).toEqual(roster);
  });

  it('flattens every tier, including people', () => {
    const flat = flattenRoster(roster);
    const counts: Record<string, number> = {};
    for (const unit of Object.values(flat)) counts[unit.kind] = (counts[unit.kind] ?? 0) + 1;
    expect(counts.directorate).toBe(Object.keys(roster).length);
    expect(counts.division).toBe(21);
    expect(counts.branch).toBe(53);
    expect(counts.team).toBe(112);
    expect(counts.person).toBe(502);
  });

  it('keys a directorate by its actor, which is the id the org refs already use', () => {
    const flat = flattenRoster(roster);
    for (const actor of ACTORS) {
      if (!roster[actor]) continue;
      expect(flat[actor]!.kind).toBe('directorate');
      expect(flat[actor]!.parentId).toBeNull();
    }
  });

  it('preserves sibling order through the round trip', () => {
    const names = roster.cyber!.divisions.map((d) => d.name);
    expect(nestRoster(flattenRoster(roster)).cyber!.divisions.map((d) => d.name)).toEqual(names);
  });

  it('preserves externalId, which is what makes a re-sync stable', () => {
    const flat = flattenRoster(roster);
    expect(flat[firstDivision.id]!.externalId).toBe(firstDivision.externalId);
    const back = nestRoster(flat);
    expect(back.cyber!.divisions[0]!.externalId).toBe(firstDivision.externalId);
  });

  it('drops a unit whose parent is gone rather than throwing', () => {
    // A shared document can contain anything a peer wrote. Failing to parse would take the whole
    // workspace down over one orphaned record.
    const flat = { ...flattenRoster(roster) };
    delete flat[firstDivision.id];
    expect(() => nestRoster(flat)).not.toThrow();
    const back = nestRoster(flat);
    expect(back.cyber!.divisions.map((d) => d.id)).not.toContain(firstDivision.id);
  });

  it('drops a unit whose kind does not belong under its parent', () => {
    const flat = { ...flattenRoster(roster) };
    flat[firstTeam.id] = { ...flat[firstTeam.id]!, parentId: 'cyber' };
    const back = nestRoster(flat);
    expect(back.cyber!.divisions.some((d) => d.id === firstTeam.id)).toBe(false);
  });

  it('knows what goes inside what, and that nothing goes inside a person', () => {
    expect(childKindOf('directorate')).toBe('division');
    expect(childKindOf('division')).toBe('branch');
    expect(childKindOf('branch')).toBe('team');
    expect(childKindOf('team')).toBe('person');
    expect(childKindOf('person')).toBeNull();
  });
});

describe('the roster inside a document', () => {
  const load = () => docFromWorkspace(workspace);

  it('survives a load and read unchanged', () => {
    expect(readWorkspace(load()).roster).toEqual(roster);
  });

  it('reads a document written before the flattening', () => {
    // Persisted documents exist that hold one plain value per directorate. Coming back empty would
    // look exactly like a workspace whose roster was never filled in.
    const doc = new Y.Doc();
    doc.transact(() => {
      for (const [actor, directorate] of Object.entries(roster)) {
        maps(doc).roster.set(actor, directorate);
      }
    }, 'load');
    expect(readWorkspace(doc).roster).toEqual(roster);
  });

  it('prefers the flat units once anything has written them', () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      maps(doc).roster.set('cyber', { lead: null, externalId: null, divisions: [] });
    }, 'load');
    loadWorkspace(doc, workspace);
    expect(readWorkspace(doc).roster.cyber!.divisions.length).toBeGreaterThan(0);
  });
});

describe('roster mutations', () => {
  it('adds a unit of the kind its parent takes, and never one it does not', () => {
    const doc = docFromWorkspace(workspace);
    const divisionId = addRosterUnit(doc, 'cyber', 'New Division')!;
    expect(divisionId).toMatch(/^dv_/);
    const branchId = addRosterUnit(doc, divisionId, 'New Branch')!;
    expect(branchId).toMatch(/^br_/);
    const teamId = addRosterUnit(doc, branchId, 'New Team')!;
    const personId = addRosterUnit(doc, teamId, 'A Person')!;
    expect(personId).toMatch(/^p_/);
    // A person contains nothing.
    expect(addRosterUnit(doc, personId, 'nope')).toBeNull();

    const back = readWorkspace(doc).roster;
    const division = back.cyber!.divisions.find((d) => d.id === divisionId)!;
    expect(division.name).toBe('New Division');
    expect(division.branches[0]!.teams[0]!.people[0]!.name).toBe('A Person');
  });

  it('never gives a hand-created unit an externalId', () => {
    // A null externalId is how "this unit is ours, not the directory's" is recorded, and the sync
    // preserves it deliberately. Minting one here would make the next sync delete the unit.
    const doc = docFromWorkspace(workspace);
    const id = addRosterUnit(doc, 'cyber', 'Ours')!;
    const back = readWorkspace(doc).roster.cyber!.divisions.find((d) => d.id === id)!;
    expect(back.externalId).toBeNull();
  });

  it('appends after the existing siblings', () => {
    const doc = docFromWorkspace(workspace);
    const before = readWorkspace(doc).roster.cyber!.divisions.length;
    const id = addRosterUnit(doc, 'cyber', 'Last')!;
    const after = readWorkspace(doc).roster.cyber!.divisions;
    expect(after).toHaveLength(before + 1);
    expect(after[after.length - 1]!.id).toBe(id);
  });

  it('renames one unit without touching its siblings', () => {
    const doc = docFromWorkspace(workspace);
    const siblings = roster.cyber!.divisions.map((d) => d.name);
    setRosterUnitField(doc, firstDivision.id, 'name', 'Renamed');
    const back = readWorkspace(doc).roster.cyber!.divisions;
    expect(back[0]!.name).toBe('Renamed');
    expect(back.slice(1).map((d) => d.name)).toEqual(siblings.slice(1));
  });

  it('sets and clears a lead in one transaction', () => {
    const doc = docFromWorkspace(workspace);
    setRosterLead(doc, firstBranch.id, { id: 'p_new', name: 'Someone' });
    const set = readWorkspace(doc).roster.cyber!.divisions[0]!.branches[0]!;
    expect(set.chief).toEqual({ id: 'p_new', name: 'Someone' });
    setRosterLead(doc, firstBranch.id, null);
    expect(readWorkspace(doc).roster.cyber!.divisions[0]!.branches[0]!.chief).toBeNull();
  });

  it('deletes a unit and everything under it', () => {
    const doc = docFromWorkspace(workspace);
    const removed = deleteRosterUnit(doc, firstDivision.id);
    expect(removed).toContain(firstDivision.id);
    expect(removed).toContain(firstBranch.id);
    expect(removed).toContain(firstTeam.id);
    expect(readWorkspace(doc).roster.cyber!.divisions.map((d) => d.id)).not.toContain(firstDivision.id);
  });

  it('refuses to delete a directorate — the six are the fixed spine org refs point at', () => {
    const doc = docFromWorkspace(workspace);
    expect(deleteRosterUnit(doc, 'cyber')).toEqual([]);
    expect(readWorkspace(doc).roster.cyber).toBeDefined();
  });

  it('moves a branch to another division', () => {
    const doc = docFromWorkspace(workspace);
    const target = roster.cyber!.divisions[1];
    if (!target) return;
    moveRosterUnit(doc, firstBranch.id, target.id, 'z');
    const back = readWorkspace(doc).roster.cyber!.divisions;
    expect(back[0]!.branches.map((b) => b.id)).not.toContain(firstBranch.id);
    expect(back.find((d) => d.id === target.id)!.branches.map((b) => b.id)).toContain(firstBranch.id);
  });

  it('refuses a move that would change what a unit IS', () => {
    // Dragging a branch into a directorate would make it a division. Refusing keeps the tree's
    // shape an invariant rather than a hope.
    const doc = docFromWorkspace(workspace);
    moveRosterUnit(doc, firstBranch.id, 'cyber', 'z');
    const back = readWorkspace(doc).roster.cyber!;
    expect(back.divisions.map((d) => d.id)).not.toContain(firstBranch.id);
    expect(back.divisions[0]!.branches.map((b) => b.id)).toContain(firstBranch.id);
  });

  it('lists a unit’s children in order', () => {
    const doc = docFromWorkspace(workspace);
    expect(rosterChildren(doc, 'cyber').map((u) => u.id)).toEqual(
      roster.cyber!.divisions.map((d) => d.id),
    );
  });

  it('replaces one directorate without touching the others', () => {
    const doc = docFromWorkspace(workspace);
    const swBefore = readWorkspace(doc).roster.sw;
    setDirectorate(doc, 'cyber', { lead: null, externalId: null, divisions: [] }, 'directory-sync');
    const back = readWorkspace(doc).roster;
    expect(back.cyber!.divisions).toEqual([]);
    expect(back.sw).toEqual(swBefore);
  });
});

describe('two people editing the roster at once', () => {
  const sync = (a: Y.Doc, b: Y.Doc) => {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
  };

  it('keeps both when two people add a team to the same branch', () => {
    // The whole reason the roster was flattened. Under the old storage — one plain JSON value per
    // directorate — one of these two writes was simply gone.
    const a = docFromWorkspace(workspace);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    const fromA = addRosterUnit(a, firstBranch.id, 'A team')!;
    const fromB = addRosterUnit(b, firstBranch.id, 'B team')!;
    sync(a, b);

    const teams = readWorkspace(a).roster.cyber!.divisions[0]!.branches[0]!.teams.map((t) => t.id);
    expect(teams).toContain(fromA);
    expect(teams).toContain(fromB);
    expect(readWorkspace(a).roster).toEqual(readWorkspace(b).roster);
  });

  it('keeps both when two people rename different divisions of one directorate', () => {
    const a = docFromWorkspace(workspace);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const second = roster.cyber!.divisions[1];
    if (!second) return;

    setRosterUnitField(a, firstDivision.id, 'name', 'From A');
    setRosterUnitField(b, second.id, 'name', 'From B');
    sync(a, b);

    const divisions = readWorkspace(a).roster.cyber!.divisions;
    expect(divisions.find((d) => d.id === firstDivision.id)!.name).toBe('From A');
    expect(divisions.find((d) => d.id === second.id)!.name).toBe('From B');
  });

  it('keeps a person added by hand while a sync rewrites a different directorate', () => {
    const a = docFromWorkspace(workspace);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    const person = addRosterUnit(a, firstTeam.id, 'Hand-added')!;
    setDirectorate(b, 'sw', { lead: null, externalId: null, divisions: [] }, 'directory-sync');
    sync(a, b);

    const merged = readWorkspace(a).roster;
    const people = merged.cyber!.divisions[0]!.branches[0]!.teams[0]!.people.map((p) => p.id);
    expect(people).toContain(person);
    expect(merged.sw!.divisions).toEqual([]);
  });
});
