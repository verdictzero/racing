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
