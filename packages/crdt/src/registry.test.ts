import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import demo from '../../core/src/__fixtures__/demo-workspace.json' with { type: 'json' };
import {
  artifactsInOrder,
  computeArtifactUses,
  entitiesInOrder,
  importLegacy,
  objectRegistry,
} from '@raci/core';
import { docFromWorkspace, readWorkspace } from './doc.js';
import { addArtifact, addEntity, duplicateArtifact, duplicateEntity } from './mutations.js';

const { workspace } = importLegacy(demo);

describe('duplicating a registry object — the gallery’s right-click Duplicate', () => {
  it('copies a deliverable under a fresh id, named "Copy of …", with no uses of its own', () => {
    const doc = docFromWorkspace(workspace);
    const copyId = duplicateArtifact(doc, 'a_triage')!;
    const ws = readWorkspace(doc);
    const copy = ws.artifacts[copyId]!;
    expect(copyId).not.toBe('a_triage');
    expect(copy.name).toBe('Copy of Triage Report');
    expect(copy.type).toBe('document');
    expect(copy.description).toBe(ws.artifacts['a_triage']!.description);
    // Nothing names a thing made a second ago; the original keeps every use it had.
    const uses = computeArtifactUses(ws);
    expect(uses.get(copyId)).toBeUndefined();
    expect(uses.get('a_triage')!.producers.length).toBeGreaterThan(0);
  });

  it('never takes a name already in use — "Copy of X (2)" as the source numbers them', () => {
    const doc = docFromWorkspace(workspace);
    const first = duplicateArtifact(doc, 'a_triage')!;
    const second = duplicateArtifact(doc, 'a_triage')!;
    const third = duplicateArtifact(doc, first)!; // a copy of a copy is not "Copy of Copy of"
    const ws = readWorkspace(doc);
    expect(ws.artifacts[second]!.name).toBe('Copy of Triage Report (2)');
    expect(ws.artifacts[third]!.name).toBe('Copy of Triage Report (3)');
  });

  it('copies an entity with its kind, short name and lead', () => {
    const doc = docFromWorkspace(workspace);
    const source = Object.values(workspace.entities)[0]!;
    const copyId = duplicateEntity(doc, source.id)!;
    const copy = readWorkspace(doc).entities[copyId]!;
    expect(copy.name).toBe(`Copy of ${source.name}`);
    expect({ ...copy, id: source.id, name: source.name, order: source.order }).toEqual(source);
  });

  it('lands a copy at the end of the registry, where the source pushes it', () => {
    const doc = docFromWorkspace(workspace);
    const copyId = duplicateArtifact(doc, 'a_triage')!;
    expect(artifactsInOrder(readWorkspace(doc)).map((a) => a.id).at(-1)).toBe(copyId);
  });
});

describe('registry order — what the gallery lists first', () => {
  const sync = (from: Y.Doc, to: Y.Doc) => Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));

  it('keeps an addition last after a reload, whatever the adding client’s id', () => {
    // A keyed map iterates in integration order, and a fresh load integrates the higher client id
    // first — without an order key, a deliverable someone added would jump to the top on reload.
    for (const offset of [1000, -1000]) {
      const server = docFromWorkspace(workspace);
      const peer = new Y.Doc();
      peer.clientID = Math.max(1, server.clientID + offset);
      sync(server, peer);
      const added = addArtifact(peer, 'Added Later');
      const addedEntity = addEntity(peer, 'Later Board');
      const reloaded = new Y.Doc();
      Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(peer));
      const ws = readWorkspace(reloaded);
      expect(artifactsInOrder(ws).map((a) => a.id).at(-1)).toBe(added);
      expect(entitiesInOrder(ws).map((e) => e.id).at(-1)).toBe(addedEntity);
      expect(objectRegistry(ws).map((o) => o.id).slice(0, 5)).toEqual([
        'a_triage', 'a_decl', 'a_scope', 'a_rpt', added,
      ]);
    }
  });

  it('settles two additions minted at the same instant the same way on every client', () => {
    const a = docFromWorkspace(workspace);
    const b = new Y.Doc();
    sync(a, b);
    const fromA = addArtifact(a, 'From A');
    const fromB = addArtifact(b, 'From B'); // same key: neither had seen the other's
    sync(a, b);
    sync(b, a);
    const orderA = artifactsInOrder(readWorkspace(a)).map((x) => x.id);
    const orderB = artifactsInOrder(readWorkspace(b)).map((x) => x.id);
    expect(orderA).toEqual(orderB);
    expect(orderA.slice(-2).sort()).toEqual([fromA, fromB].sort());
  });

  it('does nothing for an object that is not there', () => {
    const doc = docFromWorkspace(workspace);
    expect(duplicateArtifact(doc, 'a_gone')).toBeNull();
    expect(duplicateEntity(doc, 'ent_gone')).toBeNull();
  });
});
