import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import demo from '../../core/src/__fixtures__/demo-workspace.json' with { type: 'json' };
import { importLegacy } from '@raci/core';
import { docFromWorkspace, readWorkspace } from './doc.js';
import { insertChart, insertEntities, setColumnLabels } from './mutations.js';

const { workspace } = importLegacy(demo);

describe('bulk insert — what an Excel import lands as', () => {
  const sync = (a: Y.Doc, b: Y.Doc) => {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
  };

  const smallChart = (id: string, title: string) => ({
    id,
    title,
    framework: 'raci' as const,
    status: 'draft' as const,
    finalizedAt: null,
    meta: { description: '', customer: '', priority: '' as const, budget: '', tags: [] },
    custom: null,
    nodes: {
      [`${id}_a`]: {
        id: `${id}_a`, chartId: id, parentId: null, order: 'V', name: 'Alpha',
        raci: { hq: 'A' }, primaryR: null, org: null, description: '',
        documents: [], inputs: [], outputs: [],
      },
      [`${id}_b`]: {
        id: `${id}_b`, chartId: id, parentId: `${id}_a`, order: 'V', name: 'Beta',
        raci: { cos: 'R' }, primaryR: null, org: null, description: '',
        documents: [], inputs: [], outputs: [],
      },
    },
  });

  it('adds the header and every row, keeping the ids the report named', () => {
    // The person approved a preview naming these rows. Renumbering here would mean the thing
    // written is not the thing they said yes to.
    const doc = docFromWorkspace(workspace);
    insertChart(doc, smallChart('c_import', 'Imported') as never);
    const chart = readWorkspace(doc).charts['c_import']!;
    expect(chart.title).toBe('Imported');
    expect(Object.keys(chart.nodes).sort()).toEqual(['c_import_a', 'c_import_b']);
    expect(chart.nodes['c_import_b']!.parentId).toBe('c_import_a');
  });

  it('appends after the charts already there', () => {
    const doc = docFromWorkspace(workspace);
    const before = Object.keys(readWorkspace(doc).chartOrder).length;
    insertChart(doc, smallChart('c_import', 'Imported') as never);
    const order = readWorkspace(doc).chartOrder;
    expect(Object.keys(order)).toHaveLength(before + 1);
    const sorted = Object.entries(order).sort((a, b) => (a[1] < b[1] ? -1 : 1));
    expect(sorted[sorted.length - 1]![0]).toBe('c_import');
  });

  it('arrives as ONE transaction, so a peer sees one change and undo is one press', () => {
    const doc = docFromWorkspace(workspace);
    let transactions = 0;
    doc.on('afterTransaction', () => transactions++);
    insertChart(doc, smallChart('c_import', 'Imported') as never);
    expect(transactions).toBe(1);
  });

  it('skips an entity whose name is already taken', () => {
    // An imported workbook mints fresh ids every time, so importing the same file twice would
    // otherwise stack a second "Cyber Review Board" beside the first.
    const doc = docFromWorkspace(workspace);
    const existing = Object.values(readWorkspace(doc).entities)[0]!;
    const added = insertEntities(doc, [
      { id: 'e_dup', name: existing.name, kind: 'board', short: '', description: '', lead: null },
      { id: 'e_new', name: 'Brand New Board', kind: 'board', short: 'BNB', description: '', lead: null },
    ]);
    expect(added).toEqual(['e_new']);
    const entities = readWorkspace(doc).entities;
    expect(entities['e_dup']).toBeUndefined();
    expect(entities['e_new']!.short).toBe('BNB');
  });

  it('merges column labels rather than replacing the set', () => {
    const doc = docFromWorkspace(workspace);
    setColumnLabels(doc, { hq: 'Head Office' }, { hq: 'HO' });
    const ws = readWorkspace(doc);
    expect(ws.columnLabels.hq).toBe('Head Office');
    expect(ws.columnShort.hq).toBe('HO');
  });

  it('merges with a chart someone else added at the same moment', () => {
    const a = docFromWorkspace(workspace);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    insertChart(a, smallChart('c_from_a', 'From A') as never);
    insertChart(b, smallChart('c_from_b', 'From B') as never);
    sync(a, b);

    const charts = readWorkspace(a).charts;
    expect(charts['c_from_a']!.title).toBe('From A');
    expect(charts['c_from_b']!.title).toBe('From B');
    expect(Object.keys(charts['c_from_a']!.nodes)).toHaveLength(2);
    expect(readWorkspace(a).charts).toEqual(readWorkspace(b).charts);
  });
});
