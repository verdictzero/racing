import { describe, it, expect } from 'vitest';
import demo from './__fixtures__/demo-workspace.json' with { type: 'json' };
import { importLegacy, exportLegacy } from './legacy.js';
import { childrenOf, walkInOrder, depthOf, findCycles, findOrphans, rootsOf } from './tree.js';

/**
 * The fixture is the REAL demo workspace, dumped out of index.html v0.39 by driving the app in a
 * browser (scripts in the scratchpad; see docs/dev/PORTING.md). 810 activities, two flows, a
 * nested-flow box, a group, typed handoffs, routed edges, the two registries and the full roster.
 *
 * A hand-written fixture would only prove the converter agrees with itself. This one proves it
 * agrees with the app that has to keep reading these files.
 */

describe('importLegacy', () => {
  const { workspace, report } = importLegacy(demo);

  it('reads everything the file carries', () => {
    expect(report.charts).toBe(1);
    expect(report.nodes).toBe(810);
    expect(report.flows).toBe(2);
    expect(report.steps).toBe(12);
    expect(report.artifacts).toBe(4);
    expect(report.entities).toBe(2);
  });

  it('imports cleanly — the shipped demo has nothing to repair', () => {
    expect(report.warnings).toEqual([]);
  });

  it('produces a valid tree: no cycles, no orphans', () => {
    for (const chart of Object.values(workspace.charts)) {
      expect(findCycles(chart.nodes)).toEqual([]);
      expect(findOrphans(chart.nodes)).toEqual([]);
    }
  });

  it('keeps the organization chart within its four tiers', () => {
    const chart = Object.values(workspace.charts)[0]!;
    expect(chart.custom).toBeNull();
    for (const id of Object.keys(chart.nodes)) {
      const d = depthOf(chart.nodes, id);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(3);
    }
  });

  it('preserves sibling order exactly as the nested array had it', () => {
    const chart = Object.values(workspace.charts)[0]!;
    const legacyRoots = (demo.charts[0]!.activities as { name: string }[]).map((a) => a.name);
    expect(rootsOf(chart.nodes).map((n) => n.name)).toEqual(legacyRoots);

    // And one level down, on the first row that has children.
    const firstLegacy = demo.charts[0]!.activities[0] as { id: string; children: { name: string }[] };
    expect(childrenOf(chart.nodes, firstLegacy.id).map((n) => n.name)).toEqual(
      firstLegacy.children.map((c) => c.name),
    );
  });

  it('carries the flow graph over, nested box and routed handoffs included', () => {
    const flows = Object.values(workspace.flows);
    const tabletop = flows.find((f) => /Tabletop/.test(f.name))!;
    expect(tabletop).toBeDefined();

    const subflow = Object.values(tabletop.steps).find((s) => s.kind === 'subflow');
    expect(subflow, 'the demo nests the evidence procedure').toBeDefined();
    expect(subflow!.refId).toBeTruthy();

    const routed = Object.values(tabletop.edges).filter((e) => e.via.length > 0);
    expect(routed.length, 'the false-positive branch is routed on two redirectors').toBeGreaterThan(0);
    expect(routed[0]!.via).toHaveLength(2);

    expect(Object.keys(tabletop.groups)).toHaveLength(1);
  });

  it('keeps every deliverable reference resolvable', () => {
    const ids = new Set(Object.keys(workspace.artifacts));
    for (const flow of Object.values(workspace.flows)) {
      for (const edge of Object.values(flow.edges)) {
        for (const aid of edge.artifactIds) expect(ids.has(aid)).toBe(true);
      }
    }
  });

  it('imports the roster tree', () => {
    const ocio = workspace.roster.ocio!;
    expect(ocio.divisions.length).toBeGreaterThan(0);
    const legacyOcio = demo.directorates.ocio as { divisions: unknown[] };
    expect(ocio.divisions).toHaveLength(legacyOcio.divisions.length);
  });
});

describe('round trip', () => {
  /**
   * The contract the whole strangler migration rests on: whatever the new app edits can be handed
   * back to index.html and opened. If this test ever fails, the two apps have forked and users
   * can no longer move between them.
   */
  const { workspace } = importLegacy(demo);
  const out = exportLegacy(workspace);

  it('rebuilds the nested activity tree identically', () => {
    const strip = (nodes: unknown[]): unknown =>
      (nodes as Record<string, unknown>[]).map((n) => ({
        id: n.id,
        name: n.name,
        raci: n.raci,
        description: n.description,
        inputs: n.inputs,
        outputs: n.outputs,
        org: n.org ?? undefined,
        primaryR: n.primaryR ?? undefined,
        children: strip((n.children as unknown[]) ?? []),
      }));

    const before = strip(demo.charts[0]!.activities as unknown[]);
    const after = strip((out.charts as Record<string, unknown>[])[0]!.activities as unknown[]);
    expect(after).toEqual(before);
  });

  it('survives a second trip unchanged — the converter is idempotent', () => {
    const again = importLegacy(out);
    expect(exportLegacy(again.workspace)).toEqual(out);
  });

  it('keeps every flow step, handoff and group', () => {
    const before = demo.bizCases as Record<string, unknown>[];
    const after = out.bizCases as Record<string, unknown>[];
    expect(after).toHaveLength(before.length);
    for (const [i, b] of before.entries()) {
      const a = after[i]!;
      expect(a.id).toBe(b.id);
      expect((a.tasks as unknown[]).length).toBe((b.tasks as unknown[]).length);
      expect((a.edges as unknown[]).length).toBe((b.edges as unknown[]).length);
      expect((a.groups as unknown[]).length).toBe((b.groups as unknown[]).length);
    }
  });

  it('re-exports the file in a shape the importer accepts', () => {
    const { report } = importLegacy(out);
    expect(report.nodes).toBe(810);
    expect(report.warnings).toEqual([]);
  });
});

describe('resilience', () => {
  it('wraps a pre-multi-chart file into one chart', () => {
    const { workspace, report } = importLegacy({
      title: 'Old single chart',
      activities: [{ id: 'x1', name: 'Row', raci: { hq: 'A' }, children: [] }],
    });
    expect(report.charts).toBe(1);
    expect(Object.values(workspace.charts)[0]!.title).toBe('Old single chart');
  });

  it('accepts an empty object rather than throwing', () => {
    const { workspace } = importLegacy({});
    expect(Object.keys(workspace.charts)).toHaveLength(1);
  });

  it('re-mints a duplicate node id and reports it instead of losing the row', () => {
    const { workspace, report } = importLegacy({
      charts: [
        {
          id: 'c_dup',
          title: 'Dup',
          activities: [
            { id: 'same', name: 'First', children: [] },
            { id: 'same', name: 'Second', children: [] },
          ],
        },
      ],
    });
    const chart = workspace.charts.c_dup!;
    expect(Object.keys(chart.nodes)).toHaveLength(2);
    expect(rootsOf(chart.nodes).map((n) => n.name)).toEqual(['First', 'Second']);
    expect(report.warnings.some((w) => w.includes('duplicate node id'))).toBe(true);
  });

  it('drops a handoff whose step is gone, and says so', () => {
    const { workspace, report } = importLegacy({
      bizCases: [
        {
          id: 'b_x',
          name: 'Broken',
          tasks: [{ id: 't_a', name: 'A' }],
          edges: [{ id: 'e_1', from: 't_a', to: 't_missing' }],
        },
      ],
    });
    expect(Object.keys(workspace.flows.b_x!.edges)).toHaveLength(0);
    expect(report.warnings.some((w) => w.includes('missing step'))).toBe(true);
  });

  it('drops deliverable references with no registry entry behind them', () => {
    const { workspace, report } = importLegacy({
      artifacts: [{ id: 'a_real', name: 'Real' }],
      charts: [
        {
          id: 'c_1',
          activities: [{ id: 'n1', name: 'Row', inputs: ['a_real', 'a_ghost'], children: [] }],
        },
      ],
    });
    expect(workspace.charts.c_1!.nodes.n1!.inputs).toEqual(['a_real']);
    expect(report.warnings.some((w) => w.includes('pointed at nothing'))).toBe(true);
  });

  it('coerces a flow naming a retired framework to RACI', () => {
    const { workspace } = importLegacy({
      bizCases: [{ id: 'b_1', name: 'Old', framework: 'daci', tasks: [], edges: [] }],
    });
    expect(workspace.flows.b_1!.framework).toBe('raci');
  });

  it('rejects something that is not a workspace at all', () => {
    expect(() => importLegacy('nope')).toThrow();
    expect(() => importLegacy(42)).toThrow();
  });
});

describe('attachments', () => {
  /**
   * A file as index.html's Save writes it: every document entry carries its bytes as a dataUrl,
   * or '' when the browser that saved it could not find them.
   */
  const PDF = 'data:application/pdf;base64,JVBERi0xLjQK';
  const HI = 'data:text/plain;base64,SGk=';
  const file = () => ({
    artifacts: [
      {
        id: 'a_spec',
        name: 'Spec',
        type: 'document',
        doc: { id: 'd_spec', name: 'spec.pdf', type: 'application/pdf', size: 9, dataUrl: PDF },
      },
    ],
    charts: [
      {
        id: 'c_1',
        title: 'Docs',
        activities: [
          {
            id: 'n1',
            name: 'Row',
            documents: [
              { id: 'd_sop', name: 'SOP.pdf', type: 'application/pdf', size: 9, dataUrl: PDF },
              { id: 'd_lost', name: 'lost.txt', type: 'text/plain', size: 4, dataUrl: '' },
            ],
            children: [
              {
                id: 'n2',
                name: 'Child',
                documents: [{ name: 'no-id.txt', type: 'text/plain', size: 2, dataUrl: HI }],
                children: [],
              },
            ],
          },
        ],
      },
    ],
  });

  it('keeps metadata in the document and sets the bytes aside under the same ids', () => {
    const { workspace, attachments } = importLegacy(file());
    expect(workspace.charts.c_1!.nodes.n1!.documents).toEqual([
      { id: 'd_sop', name: 'SOP.pdf', type: 'application/pdf', size: 9 },
      { id: 'd_lost', name: 'lost.txt', type: 'text/plain', size: 4 },
    ]);
    // Megabytes of base64 in a CRDT would ride along in every update; none may get in.
    expect(JSON.stringify(workspace)).not.toContain('base64');
    expect(attachments).toContainEqual({
      id: 'd_sop',
      name: 'SOP.pdf',
      type: 'application/pdf',
      dataUrl: PDF,
    });
    // A doc whose file carried no bytes has nothing to store.
    expect(attachments.map((a) => a.id)).not.toContain('d_lost');
  });

  it("carries a deliverable's spec doc bytes as well as a row's", () => {
    const { workspace, attachments } = importLegacy(file());
    expect(workspace.artifacts.a_spec!.doc).toEqual({
      id: 'd_spec',
      name: 'spec.pdf',
      type: 'application/pdf',
      size: 9,
    });
    expect(attachments.find((a) => a.id === 'd_spec')?.dataUrl).toBe(PDF);
  });

  it('files the bytes of a doc with no id under the id the row is given for it', () => {
    // index.html's migrateState mints an id for such a doc rather than dropping it. Minting it
    // anywhere but here would leave the bytes filed under an id no row holds.
    const { workspace, attachments } = importLegacy(file());
    const doc = workspace.charts.c_1!.nodes.n2!.documents[0]!;
    expect(doc.id).toMatch(/^doc_/);
    expect(doc.name).toBe('no-id.txt');
    expect(attachments.find((a) => a.id === doc.id)?.dataUrl).toBe(HI);
  });

  it('corrects a size a DocRef cannot hold instead of failing the whole import', () => {
    const { workspace } = importLegacy({
      charts: [
        {
          id: 'c_1',
          activities: [
            {
              id: 'n1',
              documents: [
                { id: 'd1', size: -5 },
                { id: 'd2', size: 1.5 },
                { id: 'd3', size: 'big' },
                'not a document',
                null,
              ],
              children: [],
            },
          ],
        },
      ],
    });
    expect(workspace.charts.c_1!.nodes.n1!.documents).toEqual([
      { id: 'd1', name: 'document', type: '', size: 0 },
      { id: 'd2', name: 'document', type: '', size: 1 },
      { id: 'd3', name: 'document', type: '', size: 0 },
    ]);
  });

  it('writes every document back out with its bytes, in the order index.html writes them', () => {
    const { workspace, attachments } = importLegacy(file());
    const dataUrls = new Map(attachments.map((a) => [a.id, a.dataUrl]));
    const out = exportLegacy(workspace, { dataUrls }) as {
      charts: Array<{ activities: Array<{ documents: Array<Record<string, unknown>> }> }>;
      artifacts: Array<{ doc: Record<string, unknown> }>;
    };

    const docs = out.charts[0]!.activities[0]!.documents;
    expect(docs).toEqual([
      { id: 'd_sop', name: 'SOP.pdf', type: 'application/pdf', size: 9, dataUrl: PDF },
      // No stored bytes: '' is what index.html's own Save writes for such a doc.
      { id: 'd_lost', name: 'lost.txt', type: 'text/plain', size: 4, dataUrl: '' },
    ]);
    expect(Object.keys(docs[0]!)).toEqual(['id', 'name', 'type', 'size', 'dataUrl']);
    expect(out.artifacts[0]!.doc.dataUrl).toBe(PDF);

    // And the saved file reads back in to the same bytes under the same ids.
    expect(importLegacy(out).attachments).toEqual(expect.arrayContaining(attachments));
  });

  it('writes metadata only when it is not handed any bytes', () => {
    const { workspace } = importLegacy(file());
    expect(JSON.stringify(exportLegacy(workspace))).not.toContain('dataUrl');
  });

  it('finds nothing to store in the demo, which has no attachments', () => {
    expect(importLegacy(demo).attachments).toEqual([]);
  });
});

describe('walkInOrder', () => {
  it('returns every node once, parents before their children', () => {
    const { workspace } = importLegacy(demo);
    const chart = Object.values(workspace.charts)[0]!;
    const order = walkInOrder(chart.nodes);
    expect(order).toHaveLength(810);

    const seen = new Set<string>();
    for (const node of order) {
      if (node.parentId !== null) {
        expect(seen.has(node.parentId), `${node.name} came before its parent`).toBe(true);
      }
      seen.add(node.id);
    }
  });
});

describe('metadata that the legacy app actually writes', () => {
  it('accepts the priority vocabulary index.html uses', () => {
    // These are wire values, not ours to improve. Core said "medium" where the legacy app writes
    // "normal", so importing any workspace where someone had set a priority threw on the enum —
    // and the demo has none set, so nothing caught it.
    for (const priority of ['', 'low', 'normal', 'high', 'critical']) {
      const raw = structuredClone(demo) as Record<string, unknown>;
      const charts = raw.charts as Array<Record<string, unknown>>;
      charts[0]!.meta = { ...(charts[0]!.meta as object), priority };
      const { workspace } = importLegacy(raw);
      expect(Object.values(workspace.charts)[0]!.meta.priority).toBe(priority);
    }
  });

  it('drops an unknown priority rather than failing the whole import', () => {
    const raw = structuredClone(demo) as Record<string, unknown>;
    const charts = raw.charts as Array<Record<string, unknown>>;
    charts[0]!.meta = { ...(charts[0]!.meta as object), priority: 'urgent-ish' };
    expect(() => importLegacy(raw)).not.toThrow();
    expect(Object.values(importLegacy(raw).workspace.charts)[0]!.meta.priority).toBe('');
  });

  it('carries a priority back out unchanged', () => {
    const raw = structuredClone(demo) as Record<string, unknown>;
    const charts = raw.charts as Array<Record<string, unknown>>;
    charts[0]!.meta = { ...(charts[0]!.meta as object), priority: 'critical' };
    const { workspace } = importLegacy(raw);
    const out = exportLegacy(workspace) as { charts: Array<{ meta: { priority: string } }> };
    expect(out.charts[0]!.meta.priority).toBe('critical');
  });
});
