import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import demo from '../../core/src/__fixtures__/demo-workspace.json' with { type: 'json' };
import {
  clearedWorkspace,
  emptyWorkspace,
  importLegacy,
  mergeWorkspace,
  type Workspace,
} from '@raci/core';
import { docFromWorkspace, loadWorkspace, maps, readWorkspace, TOP } from './doc.js';
import { addNode, renameNode } from './mutations.js';
import { replaceWorkspace } from './replace.js';

const { workspace: demoWorkspace } = importLegacy(demo);

/** A small workspace that shares no id with the demo — every record in it is new to the document. */
const { workspace: other } = importLegacy({
  charts: [
    {
      id: 'c_other',
      title: 'Other chart',
      activities: [
        {
          id: 'n_top',
          name: 'Top',
          raci: { hq: 'A', cos: 'R' },
          children: [{ id: 'n_kid', name: 'Kid', raci: { cos: 'A' } }],
        },
      ],
    },
  ],
  bizCases: [
    {
      id: 'b_other',
      name: 'Other flow',
      tasks: [
        { id: 't_one', name: 'One', raci: { hq: 'R' }, groupId: 'g_other' },
        { id: 't_two', name: 'Two', raci: { cos: 'R' } },
      ],
      edges: [{ id: 'e_other', from: 't_one', to: 't_two', artifactIds: ['a_other'] }],
      groups: [{ id: 'g_other', name: 'Frame' }],
    },
  ],
  artifacts: [{ id: 'a_other', name: 'Other deliverable', type: 'data' }],
  entities: [{ id: 'ent_other', name: 'Other board', kind: 'board' }],
  directorates: {
    cyber: {
      lead: { id: 'p_lead', name: 'Lead' },
      divisions: [{ id: 'dv_other', name: 'Division' }],
    },
  },
  columnLabels: { hq: 'The Boss' },
});

/** Every top-level map of a document, as plain JSON. */
const snapshot = (doc: Y.Doc) =>
  Object.fromEntries(Object.values(TOP).map((name) => [name, doc.getMap(name).toJSON()]));

/** Two clients, synced through their update streams, with the wire under the test's control. */
class Pair {
  readonly a = new Y.Doc();
  readonly b = new Y.Doc();
  private connected = true;
  private queued: Array<[Y.Doc, Uint8Array]> = [];

  constructor(seed: Workspace) {
    const snapshot = Y.encodeStateAsUpdate(docFromWorkspace(seed));
    Y.applyUpdate(this.a, snapshot);
    Y.applyUpdate(this.b, snapshot);
    const wire = (from: Y.Doc, to: Y.Doc) =>
      from.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin === 'remote') return;
        if (this.connected) Y.applyUpdate(to, update, 'remote');
        else this.queued.push([to, update]);
      });
    wire(this.a, this.b);
    wire(this.b, this.a);
  }

  disconnect(): void {
    this.connected = false;
  }

  reconnect(): void {
    this.connected = true;
    for (const [to, update] of this.queued.splice(0)) Y.applyUpdate(to, update, 'remote');
  }
}

describe('replaceWorkspace — Load, Demo and Clear', () => {
  it('leaves every map holding exactly the new workspace, and nothing of the old one', () => {
    const doc = docFromWorkspace(demoWorkspace);
    replaceWorkspace(doc, other);
    // Map for map, key for key, the same document a fresh load of the new workspace produces.
    expect(snapshot(doc)).toEqual(snapshot(docFromWorkspace(other)));
    expect(readWorkspace(doc)).toEqual(readWorkspace(docFromWorkspace(other)));
  });

  it('rewrites a record that exists on both sides, rather than leaving stale fields on it', () => {
    const doc = docFromWorkspace(demoWorkspace);
    const flowId = Object.keys(demoWorkspace.flows)[0]!;
    // A field the next workspace's record does not carry at all.
    maps(doc).flows.get(flowId)!.set('stray', 'left over');
    replaceWorkspace(doc, demoWorkspace);
    expect(maps(doc).flows.get(flowId)!.get('stray')).toBeUndefined();
    expect(readWorkspace(doc)).toEqual(readWorkspace(docFromWorkspace(demoWorkspace)));
  });

  it('empties the pre-flattening roster map too, so an old org cannot come back', () => {
    // A document written before the roster was flattened keeps it in `roster`, and readWorkspace
    // falls back to that map whenever `rosterUnits` is empty.
    const doc = docFromWorkspace(demoWorkspace);
    const m = maps(doc);
    doc.transact(() => {
      m.rosterUnits.clear();
      m.roster.set('cyber', { lead: { id: 'p_old', name: 'Old lead' }, divisions: [] });
    });
    expect(readWorkspace(doc).roster.cyber?.lead?.name).toBe('Old lead');

    replaceWorkspace(doc, emptyWorkspace());
    expect(m.roster.size).toBe(0);
    expect(readWorkspace(doc).roster).toEqual({});
  });

  it('is one transaction: a peer receives one update, never the half-replaced state', () => {
    const doc = docFromWorkspace(demoWorkspace);
    let transactions = 0;
    let updates = 0;
    doc.on('afterTransaction', () => transactions++);
    doc.on('update', () => updates++);
    replaceWorkspace(doc, other);
    expect(transactions).toBe(1);
    expect(updates).toBe(1);
  });

  it("tags the transaction 'load' unless told otherwise", () => {
    const doc = docFromWorkspace(demoWorkspace);
    const origins: unknown[] = [];
    doc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin));
    replaceWorkspace(doc, other);
    replaceWorkspace(doc, demoWorkspace, 'mine');
    expect(origins).toEqual(['load', 'mine']);
  });

  it('undoes as one step when its origin is tracked', () => {
    const doc = docFromWorkspace(demoWorkspace);
    const before = readWorkspace(doc);
    const undo = new Y.UndoManager(Object.values(maps(doc)), { trackedOrigins: new Set(['mine']) });
    replaceWorkspace(doc, clearedWorkspace(before), 'mine');
    expect(Object.keys(readWorkspace(doc).charts)).toHaveLength(1);
    undo.undo();
    expect(readWorkspace(doc)).toEqual(before);
  });

  it('clears to one blank chart and an empty roster, with the flows and deliverables kept', () => {
    const doc = docFromWorkspace(demoWorkspace);
    replaceWorkspace(doc, clearedWorkspace(readWorkspace(doc)));
    const after = readWorkspace(doc);
    expect(Object.values(after.charts).map((c) => [c.title, Object.keys(c.nodes).length])).toEqual([
      ['Untitled chart', 0],
    ]);
    expect(maps(doc).nodes.size).toBe(0);
    expect(after.entities).toEqual({});
    for (const directorate of Object.values(after.roster))
      expect(directorate.divisions).toEqual([]);
    expect(Object.keys(after.flows)).toEqual(Object.keys(demoWorkspace.flows));
    expect(after.artifacts).toEqual(demoWorkspace.artifacts);
  });

  describe('two peers', () => {
    it('converge on the new workspace after one of them replaces it', () => {
      const pair = new Pair(demoWorkspace);
      replaceWorkspace(pair.a, other);
      expect(snapshot(pair.b)).toEqual(snapshot(pair.a));
      expect(readWorkspace(pair.b)).toEqual(readWorkspace(docFromWorkspace(other)));
    });

    it('converge even when the other was editing, offline, at the same moment', () => {
      const pair = new Pair(demoWorkspace);
      const chart = Object.values(demoWorkspace.charts)[0]!;
      const row = Object.values(chart.nodes)[0]!;
      pair.disconnect();
      renameNode(pair.b, row.id, 'Renamed while offline');
      addNode(pair.b, { chartId: chart.id, name: 'Added while offline' });
      replaceWorkspace(pair.a, other);
      pair.reconnect();

      // Both hold the same document, and it is the replacement: the offline rename landed on a
      // record the replace deleted, and the offline row belongs to a chart that no longer exists,
      // so neither reaches the workspace either peer reads.
      expect(snapshot(pair.a)).toEqual(snapshot(pair.b));
      const read = readWorkspace(pair.a);
      expect(read).toEqual(readWorkspace(pair.b));
      expect(Object.keys(read.charts)).toEqual(Object.keys(other.charts));
      expect(read.flows).toEqual(readWorkspace(docFromWorkspace(other)).flows);
    });
  });
});

describe('applying a merge', () => {
  it('writes the additions in one transaction and changes nothing already there', () => {
    const doc = docFromWorkspace(demoWorkspace);
    const before = readWorkspace(doc);
    const result = mergeWorkspace(before, importLegacy(demo).workspace);

    let transactions = 0;
    doc.on('afterTransaction', () => transactions++);
    loadWorkspace(doc, result.additions);
    expect(transactions).toBe(1);

    const after = readWorkspace(doc);
    expect(Object.keys(after.charts)).toHaveLength(2);
    expect(Object.keys(after.flows)).toHaveLength(4);
    for (const [id, chart] of Object.entries(before.charts))
      expect(after.charts[id]).toEqual(chart);
    for (const [id, flow] of Object.entries(before.flows)) expect(after.flows[id]).toEqual(flow);
    expect(after.roster).toEqual(before.roster);
    expect(after.columnLabels).toEqual(before.columnLabels);
  });
});
