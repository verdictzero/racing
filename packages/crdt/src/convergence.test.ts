import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
// The same real workspace @raci/core tests against — read from its source tree rather than
// re-exported, because a fixture is a test asset and does not belong in the package's public API.
import demo from '../../core/src/__fixtures__/demo-workspace.json' with { type: 'json' };
import {
  childrenOf,
  findCycles,
  findOrphans,
  importLegacy,
  rootsOf,
  exportLegacy,
} from '@raci/core';
import { docFromWorkspace, maps, readChart, readWorkspace, toYMap } from './doc.js';
import {
  addNode,
  deleteNode,
  duplicateNode,
  moveNode,
  MutationError,
  renameNode,
  setNodeRaci,
  addStep,
  moveStep,
  addArtifact,
  deleteArtifact,
} from './mutations.js';
import { repairDocument, attachAutoRepair } from './repair.js';
import { createUndoManager } from './undo.js';

/**
 * Two clients, wired to each other the way a real pair would be through the server, but with the
 * connection under the test's control so "concurrent" means genuinely concurrent: both sides
 * apply their edit before either sees the other's.
 */
class Pair {
  readonly a: Y.Doc;
  readonly b: Y.Doc;
  private connected = true;
  private queueA: Uint8Array[] = [];
  private queueB: Uint8Array[] = [];

  constructor(seed: Y.Doc) {
    const snapshot = Y.encodeStateAsUpdate(seed);
    this.a = new Y.Doc();
    this.b = new Y.Doc();
    Y.applyUpdate(this.a, snapshot);
    Y.applyUpdate(this.b, snapshot);

    this.a.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin === 'remote') return;
      if (this.connected) Y.applyUpdate(this.b, u, 'remote');
      else this.queueA.push(u);
    });
    this.b.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin === 'remote') return;
      if (this.connected) Y.applyUpdate(this.a, u, 'remote');
      else this.queueB.push(u);
    });
  }

  /** Cut the wire — everything after this is concurrent. */
  partition(): void {
    this.connected = false;
  }

  /** Reconnect and exchange everything both sides missed. */
  heal(): void {
    this.connected = true;
    for (const u of this.queueA) Y.applyUpdate(this.b, u, 'remote');
    for (const u of this.queueB) Y.applyUpdate(this.a, u, 'remote');
    this.queueA = [];
    this.queueB = [];
  }

  /**
   * The property a CRDT is for: both replicas hold identical state.
   *
   * Checked at two levels. The state vector is the CRDT's own notion of convergence — both
   * replicas have seen the same set of operations. The stable-stringified workspace then checks
   * that the state MEANS the same thing on both sides. Key order is normalized first, because the
   * order a Y.Map happens to iterate in is not part of the logical state and two replicas that
   * converged can still enumerate their entries differently.
   */
  expectConverged(): void {
    expect(Y.encodeStateVector(this.a)).toEqual(Y.encodeStateVector(this.b));
    expect(stableStringify(readWorkspace(this.a))).toEqual(stableStringify(readWorkspace(this.b)));
  }
}

/** JSON with every object's keys sorted, so the comparison is about content, not iteration order. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return val;
  });
}

const { workspace } = importLegacy(demo);
const chartId = Object.keys(workspace.charts)[0]!;

/**
 * A small FREE-FORM chart for the structural tests.
 *
 * The demo is an organization chart, which stops at four tiers, and the depth guard rightly
 * refuses to move a Portfolio under another Portfolio — so it cannot be used to stage a
 * reparent race. A free-form chart nests without limit, which is exactly the shape where
 * concurrent reparenting is both legal and dangerous.
 */
const FREE_CHART = 'c_free';
function freeChartDoc(): Y.Doc {
  const doc = new Y.Doc();
  const m = maps(doc);
  doc.transact(() => {
    m.meta.set('schemaVersion', 1);
    m.charts.set(
      FREE_CHART,
      toYMap({
        id: FREE_CHART,
        title: 'Free-form',
        framework: 'raci',
        status: 'draft',
        finalizedAt: null,
        meta: { description: '', customer: '', priority: '', budget: '', tags: [] },
        custom: { cols: [{ key: 'p_a', label: 'Party A', short: 'A' }], tiers: [] },
      }),
    );
    m.chartOrder.set(FREE_CHART, 'V');
  }, 'load');
  // Four roots, so a move never runs out of neighbours.
  for (const name of ['alpha', 'bravo', 'charlie', 'delta']) {
    addNode(doc, { chartId: FREE_CHART, name });
  }
  return doc;
}

describe('document round trip', () => {
  it('carries the whole demo workspace through Yjs unchanged', () => {
    const doc = docFromWorkspace(workspace);
    const out = readWorkspace(doc);
    expect(out).toEqual(workspace);
  });

  it('still exports a file the legacy app can open', () => {
    const doc = docFromWorkspace(workspace);
    expect(exportLegacy(readWorkspace(doc))).toEqual(exportLegacy(workspace));
  });

  it('reads one chart without materializing the rest', () => {
    const doc = docFromWorkspace(workspace);
    const chart = readChart(doc, chartId)!;
    expect(Object.keys(chart.nodes)).toHaveLength(810);
    expect(readChart(doc, 'c_nope')).toBeNull();
  });
});

describe('concurrent edits converge', () => {
  it('merges two people renaming two different rows', () => {
    const pair = new Pair(docFromWorkspace(workspace));
    const [first, second] = rootsOf(readChart(pair.a, chartId)!.nodes);

    pair.partition();
    renameNode(pair.a, first!.id, 'Alice was here');
    renameNode(pair.b, second!.id, 'Bob was here');
    pair.heal();

    pair.expectConverged();
    const nodes = readChart(pair.a, chartId)!.nodes;
    expect(nodes[first!.id]!.name).toBe('Alice was here');
    expect(nodes[second!.id]!.name).toBe('Bob was here');
  });

  it('merges two people assigning different columns of the SAME row', () => {
    // The case that decided the document layout: a per-record plain object would be
    // last-writer-wins and one of these two assignments would simply vanish.
    const pair = new Pair(docFromWorkspace(workspace));
    const row = rootsOf(readChart(pair.a, chartId)!.nodes)[0]!;

    pair.partition();
    setNodeRaci(pair.a, row.id, 'cyber', 'R');
    setNodeRaci(pair.b, row.id, 'infra', 'C');
    pair.heal();

    pair.expectConverged();
    const merged = readChart(pair.a, chartId)!.nodes[row.id]!;
    expect(merged.raci.cyber).toBe('R');
    expect(merged.raci.infra).toBe('C');
  });

  it('keeps both rows when two people insert at the same position', () => {
    const pair = new Pair(docFromWorkspace(workspace));
    const parent = rootsOf(readChart(pair.a, chartId)!.nodes)[0]!;
    const before = childrenOf(readChart(pair.a, chartId)!.nodes, parent.id).length;

    pair.partition();
    const idA = addNode(pair.a, { chartId, parentId: parent.id, name: 'From Alice' });
    const idB = addNode(pair.b, { chartId, parentId: parent.id, name: 'From Bob' });
    pair.heal();

    pair.expectConverged();
    const kids = childrenOf(readChart(pair.a, chartId)!.nodes, parent.id);
    expect(kids).toHaveLength(before + 2);
    expect(kids.map((k) => k.id)).toContain(idA);
    expect(kids.map((k) => k.id)).toContain(idB);
  });

  it('merges a rename against a move of the same row', () => {
    const pair = new Pair(freeChartDoc());
    const roots = rootsOf(readChart(pair.a, FREE_CHART)!.nodes);
    const mover = roots[1]!;
    const target = roots[0]!;

    pair.partition();
    renameNode(pair.a, mover.id, 'Renamed by Alice');
    moveNode(pair.b, FREE_CHART, mover.id, target.id, 0);
    pair.heal();

    pair.expectConverged();
    const node = readChart(pair.a, FREE_CHART)!.nodes[mover.id]!;
    expect(node.name).toBe('Renamed by Alice');
    expect(node.parentId).toBe(target.id);
  });

  it('merges two people dragging different steps on one flow canvas', () => {
    const pair = new Pair(docFromWorkspace(workspace));
    const flowId = Object.keys(workspace.flows)[0]!;
    const steps = Object.values(readWorkspace(pair.a).flows[flowId]!.steps);

    pair.partition();
    moveStep(pair.a, steps[0]!.id, 111, 222);
    moveStep(pair.b, steps[1]!.id, 333, 444);
    pair.heal();

    pair.expectConverged();
    const merged = readWorkspace(pair.a).flows[flowId]!.steps;
    expect([merged[steps[0]!.id]!.x, merged[steps[0]!.id]!.y]).toEqual([111, 222]);
    expect([merged[steps[1]!.id]!.x, merged[steps[1]!.id]!.y]).toEqual([333, 444]);
  });
});

describe('the cases a CRDT cannot fix on its own', () => {
  it('detects and repairs the cycle two concurrent moves create', () => {
    const pair = new Pair(freeChartDoc());
    const roots = rootsOf(readChart(pair.a, FREE_CHART)!.nodes);
    const x = roots[0]!;
    const y = roots[1]!;
    const total = Object.keys(readChart(pair.a, FREE_CHART)!.nodes).length;

    // Each move is legal where it is made. Neither client can see the other's.
    pair.partition();
    moveNode(pair.a, FREE_CHART, x.id, y.id, 0);
    moveNode(pair.b, FREE_CHART, y.id, x.id, 0);
    pair.heal();

    // Converged, and broken — which is exactly the distinction that matters.
    pair.expectConverged();
    expect(findCycles(readChart(pair.a, FREE_CHART)!.nodes).length).toBeGreaterThan(0);

    // Two clients holding the merged state, each repairing on its own with NO channel between
    // them. (Repairing pair.a and pair.b directly would not prove anything: they are reconnected,
    // so the first one's repair would simply propagate to the second.)
    const merged = Y.encodeStateAsUpdate(pair.a);
    const clientOne = new Y.Doc();
    const clientTwo = new Y.Doc();
    Y.applyUpdate(clientOne, merged);
    Y.applyUpdate(clientTwo, merged);

    const resultOne = repairDocument(clientOne);
    const resultTwo = repairDocument(clientTwo);
    expect(resultOne[0]!.plan.cycles).toHaveLength(1);
    expect(resultTwo[0]!.plan.cycles).toHaveLength(1);

    // Same repair, arrived at independently — which is the property that lets every client fix
    // the document without a round trip.
    expect(resultOne[0]!.plan.reparent).toEqual(resultTwo[0]!.plan.reparent);
    expect(findCycles(readChart(clientOne, FREE_CHART)!.nodes)).toEqual([]);
    expect(findCycles(readChart(clientTwo, FREE_CHART)!.nodes)).toEqual([]);
    expect(readChart(clientOne, FREE_CHART)!.nodes[x.id]!.parentId).toEqual(
      readChart(clientTwo, FREE_CHART)!.nodes[x.id]!.parentId,
    );

    // Nothing was lost.
    expect(Object.keys(readChart(clientOne, FREE_CHART)!.nodes)).toHaveLength(total);
  });

  it('re-roots a row whose parent was deleted underneath it', () => {
    const pair = new Pair(docFromWorkspace(workspace));
    const parent = rootsOf(readChart(pair.a, chartId)!.nodes)[0]!;

    pair.partition();
    const orphanId = addNode(pair.a, { chartId, parentId: parent.id, name: 'Added by Alice' });
    deleteNode(pair.b, chartId, parent.id);
    pair.heal();

    pair.expectConverged();
    const merged = readChart(pair.a, chartId)!.nodes;
    expect(findOrphans(merged)).toContain(orphanId);

    repairDocument(pair.a);
    const repaired = readChart(pair.a, chartId)!.nodes;
    // Alice's row survives, at the top level where she can see it — not silently deleted.
    expect(repaired[orphanId]).toBeDefined();
    expect(repaired[orphanId]!.parentId).toBeNull();
    expect(findOrphans(repaired)).toEqual([]);
  });

  it('does nothing at all to a healthy document', () => {
    const doc = docFromWorkspace(workspace);
    const before = Y.encodeStateAsUpdate(doc);
    expect(repairDocument(doc)).toEqual([]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('repairs automatically when attached, and settles rather than looping', () => {
    const pair = new Pair(freeChartDoc());
    const repairs: number[] = [];
    // Attached to ONE side only. Its repair propagates over the same channel as any other edit,
    // which is what makes a single repairing client enough to fix the document for everyone.
    const detachA = attachAutoRepair(pair.a, (r) => repairs.push(r.length));

    const roots = rootsOf(readChart(pair.a, FREE_CHART)!.nodes);
    pair.partition();
    moveNode(pair.a, FREE_CHART, roots[0]!.id, roots[1]!.id, 0);
    moveNode(pair.b, FREE_CHART, roots[1]!.id, roots[0]!.id, 0);
    pair.heal();

    expect(repairs.length).toBeGreaterThan(0);
    expect(findCycles(readChart(pair.a, FREE_CHART)!.nodes)).toEqual([]);
    expect(findCycles(readChart(pair.b, FREE_CHART)!.nodes)).toEqual([]);
    pair.expectConverged();
    detachA();
  });
});

describe('guards', () => {
  it('refuses a move that would nest past an org chart’s bottom tier', () => {
    const doc = docFromWorkspace(workspace);
    const nodes = readChart(doc, chartId)!.nodes;
    const root = rootsOf(nodes)[0]!;
    // Find a Task-tier row (depth 3) to try to move a whole Portfolio subtree under.
    const deep = Object.values(nodes).find(
      (n) => n.parentId !== null && childrenOf(nodes, n.id).length === 0,
    )!;
    expect(() => moveNode(doc, chartId, root.id, deep.id, 0)).toThrow(MutationError);
  });

  it('refuses to move a row inside itself', () => {
    const doc = docFromWorkspace(workspace);
    const root = rootsOf(readChart(doc, chartId)!.nodes)[0]!;
    const child = childrenOf(readChart(doc, chartId)!.nodes, root.id)[0]!;
    expect(() => moveNode(doc, chartId, root.id, child.id, 0)).toThrow(MutationError);
  });

  it('refuses to delete a deliverable something still points at', () => {
    const doc = docFromWorkspace(workspace);
    const inUse = Object.keys(workspace.artifacts)[0]!;
    const result = deleteArtifact(doc, inUse);
    expect(result.deleted).toBe(false);
    expect(result.uses).toBeGreaterThan(0);
    expect(readWorkspace(doc).artifacts[inUse]).toBeDefined();
  });

  it('deletes an unreferenced deliverable', () => {
    const doc = docFromWorkspace(workspace);
    const fresh = addArtifact(doc, 'Nothing points at me');
    expect(deleteArtifact(doc, fresh)).toEqual({ deleted: true, uses: 0 });
    expect(readWorkspace(doc).artifacts[fresh]).toBeUndefined();
  });
});

describe('duplicate', () => {
  it('copies a row and its whole subtree under fresh ids', () => {
    const doc = docFromWorkspace(workspace);
    const before = readChart(doc, chartId)!;
    const source = rootsOf(before.nodes)[0]!;
    const sourceSize = Object.values(before.nodes).filter(
      (n) => n.parentId === source.id,
    ).length;

    const copyId = duplicateNode(doc, chartId, source.id)!;
    const after = readChart(doc, chartId)!;

    expect(copyId).not.toBe(source.id);
    expect(after.nodes[copyId]!.name).toBe(source.name);
    expect(childrenOf(after.nodes, copyId)).toHaveLength(sourceSize);
    // Lands directly after the original.
    const roots = rootsOf(after.nodes).map((n) => n.id);
    expect(roots[roots.indexOf(source.id) + 1]).toBe(copyId);
  });
});

describe('undo', () => {
  it('walks back this user’s edits and steps over a colleague’s', () => {
    const pair = new Pair(docFromWorkspace(workspace));
    const undo = createUndoManager(pair.a, { captureTimeout: 0 });
    const roots = rootsOf(readChart(pair.a, chartId)!.nodes);
    const mine = roots[0]!;
    const theirs = roots[1]!;

    renameNode(pair.a, mine.id, 'My edit');
    renameNode(pair.b, theirs.id, 'Their edit'); // arrives as a remote update on doc A

    undo.undo();

    const nodes = readChart(pair.a, chartId)!.nodes;
    expect(nodes[mine.id]!.name).toBe(mine.name); // mine rolled back
    expect(nodes[theirs.id]!.name).toBe('Their edit'); // theirs untouched
  });

  it('does not undo a repair', () => {
    const doc = docFromWorkspace(workspace);
    const undo = createUndoManager(doc, { captureTimeout: 0 });
    const roots = rootsOf(readChart(doc, chartId)!.nodes);
    addNode(doc, { chartId, parentId: roots[0]!.id, name: 'x' });
    repairDocument(doc);
    expect(undo.undoStack.length).toBe(1); // the add only; the repair is not on the stack
  });
});

describe('flow mutations', () => {
  it('adds a step and reads it back on the other side', () => {
    const pair = new Pair(docFromWorkspace(workspace));
    const flowId = Object.keys(workspace.flows)[0]!;
    const stepId = addStep(pair.a, flowId, { name: 'New step', x: 10, y: 20 });
    const onB = readWorkspace(pair.b).flows[flowId]!.steps[stepId]!;
    expect(onB.name).toBe('New step');
    expect([onB.x, onB.y]).toEqual([10, 20]);
  });
});
