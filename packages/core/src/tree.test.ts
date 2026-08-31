import { describe, it, expect } from 'vitest';
import { keysBetween } from './fractional.js';
import {
  ancestorsOf,
  childIndex,
  childrenIn,
  childrenOf,
  depthOf,
  descendantCount,
  findCycles,
  findOrphans,
  isAncestorOf,
  orderAfter,
  orderForAppend,
  pathTo,
  planMove,
  planRepair,
  repairTree,
  rootsOf,
  subtreeDepth,
  subtreeOf,
  TreeError,
  walkInOrder,
  type NodeMap,
} from './tree.js';
import type { ChartNode } from './schema.js';

/** Build a node map from a compact `id:parent` spec, in the order given. */
function tree(spec: Array<[id: string, parentId: string | null]>): NodeMap {
  const orders = keysBetween(null, null, spec.length);
  const nodes: Record<string, ChartNode> = {};
  spec.forEach(([id, parentId], i) => {
    nodes[id] = {
      id,
      chartId: 'c_test',
      parentId,
      order: orders[i]!,
      name: id,
      raci: {},
      primaryR: null,
      org: null,
      description: '',
      documents: [],
      inputs: [],
      outputs: [],
    };
  });
  return nodes;
}

const sample = tree([
  ['a', null],
  ['b', null],
  ['a1', 'a'],
  ['a2', 'a'],
  ['a1x', 'a1'],
]);

describe('navigation', () => {
  it('lists roots and children in order', () => {
    expect(rootsOf(sample).map((n) => n.id)).toEqual(['a', 'b']);
    expect(childrenOf(sample, 'a').map((n) => n.id)).toEqual(['a1', 'a2']);
    expect(childrenOf(sample, 'a1x')).toEqual([]);
  });

  it('reports depth', () => {
    expect(depthOf(sample, 'a')).toBe(0);
    expect(depthOf(sample, 'a1')).toBe(1);
    expect(depthOf(sample, 'a1x')).toBe(2);
    expect(depthOf(sample, 'nope')).toBe(-1);
  });

  it('walks ancestors nearest-first and paths root-first', () => {
    expect(ancestorsOf(sample, 'a1x').map((n) => n.id)).toEqual(['a1', 'a']);
    expect(pathTo(sample, 'a1x').map((n) => n.id)).toEqual(['a', 'a1', 'a1x']);
  });

  it('collects subtrees and counts descendants', () => {
    expect(subtreeOf(sample, 'a').map((n) => n.id)).toEqual(['a', 'a1', 'a1x', 'a2']);
    expect(descendantCount(sample, 'a')).toBe(3);
    expect(descendantCount(sample, 'b')).toBe(0);
  });

  it('knows its own ancestry', () => {
    expect(isAncestorOf(sample, 'a', 'a1x')).toBe(true);
    expect(isAncestorOf(sample, 'b', 'a1x')).toBe(false);
    expect(isAncestorOf(sample, 'a', 'a')).toBe(true);
  });

  it('walks the whole tree parents-first', () => {
    expect(walkInOrder(sample).map((n) => n.id)).toEqual(['a', 'a1', 'a1x', 'a2', 'b']);
  });
});

describe('planMove', () => {
  it('moves a node under a new parent at an index', () => {
    const plan = planMove(sample, 'b', 'a', 1);
    expect(plan.parentId).toBe('a');
    const next = { ...sample, b: { ...sample.b!, parentId: 'a', order: plan.order } };
    expect(childrenOf(next, 'a').map((n) => n.id)).toEqual(['a1', 'b', 'a2']);
  });

  it('reorders within one parent, counting positions after the node is lifted out', () => {
    const plan = planMove(sample, 'a1', 'a', 1);
    const next = { ...sample, a1: { ...sample.a1!, order: plan.order } };
    expect(childrenOf(next, 'a').map((n) => n.id)).toEqual(['a2', 'a1']);
  });

  it('clamps an out-of-range index instead of throwing', () => {
    const plan = planMove(sample, 'b', 'a', 99);
    const next = { ...sample, b: { ...sample.b!, parentId: 'a', order: plan.order } };
    expect(childrenOf(next, 'a').map((n) => n.id)).toEqual(['a1', 'a2', 'b']);
  });

  it('refuses to move a node into its own descendant', () => {
    expect(() => planMove(sample, 'a', 'a1x', 0)).toThrow(TreeError);
    expect(() => planMove(sample, 'a', 'a', 0)).toThrow(TreeError);
  });

  it('refuses unknown nodes', () => {
    expect(() => planMove(sample, 'ghost', null, 0)).toThrow(TreeError);
    expect(() => planMove(sample, 'a', 'ghost', 0)).toThrow(TreeError);
  });
});

describe('insertion helpers', () => {
  it('appends after the last child', () => {
    const order = orderForAppend(sample, 'a');
    const next = { ...sample, fresh: { ...sample.a1!, id: 'fresh', parentId: 'a', order } };
    expect(childrenOf(next, 'a').map((n) => n.id)).toEqual(['a1', 'a2', 'fresh']);
  });

  it('inserts directly after a given sibling', () => {
    const order = orderAfter(sample, 'a1');
    const next = { ...sample, fresh: { ...sample.a1!, id: 'fresh', parentId: 'a', order } };
    expect(childrenOf(next, 'a').map((n) => n.id)).toEqual(['a1', 'fresh', 'a2']);
  });
});

describe('integrity under concurrent editing', () => {
  it('finds no cycles in a healthy tree', () => {
    expect(findCycles(sample)).toEqual([]);
    expect(findOrphans(sample)).toEqual([]);
  });

  it('detects the cycle two concurrent reparents can create', () => {
    // Alice moves x under y. Bob, at the same moment, moves y under x. Both are legal
    // single-node edits; the merge is a ring. No CRDT prevents this.
    const merged = tree([
      ['x', 'y'],
      ['y', 'x'],
      ['z', null],
    ]);
    const cycles = findCycles(merged);
    expect(cycles).toHaveLength(1);
    expect([...cycles[0]!].sort()).toEqual(['x', 'y']);
  });

  it('breaks a cycle the same way on every client', () => {
    const merged = tree([
      ['x', 'y'],
      ['y', 'x'],
    ]);
    // Two clients, same merged state, different object iteration order.
    const reversed: NodeMap = { y: merged.y!, x: merged.x! };
    const planA = planRepair(merged);
    const planB = planRepair(reversed);
    expect(planA.reparent.map((m) => m.id)).toEqual(planB.reparent.map((m) => m.id));
    expect(planA.reparent[0]!.id).toBe('x'); // lexicographically smallest member
  });

  it('repairs into a real tree and loses nothing', () => {
    const merged = tree([
      ['x', 'y'],
      ['y', 'x'],
      ['keep', null],
    ]);
    const { nodes, plan } = repairTree(merged);
    expect(plan.cycles).toHaveLength(1);
    expect(findCycles(nodes)).toEqual([]);
    expect(Object.keys(nodes).sort()).toEqual(['keep', 'x', 'y']);
    // x came up to the top; y is still hanging off it, so the pair stays together.
    expect(nodes.x!.parentId).toBeNull();
    expect(nodes.y!.parentId).toBe('x');
  });

  it('re-roots a node whose parent was deleted concurrently', () => {
    // Alice deletes the parent; Bob adds a child to it at the same moment.
    const merged = tree([
      ['survivor', 'deleted-parent'],
      ['other', null],
    ]);
    expect(findOrphans(merged)).toEqual(['survivor']);
    const { nodes, plan } = repairTree(merged);
    expect(plan.orphans).toEqual(['survivor']);
    expect(nodes.survivor!.parentId).toBeNull();
    // Bob's row is still there for someone to put back, not silently dropped.
    expect(rootsOf(nodes).map((n) => n.id).sort()).toEqual(['other', 'survivor']);
  });

  it('handles several independent cycles at once', () => {
    const merged = tree([
      ['a', 'b'],
      ['b', 'a'],
      ['c', 'd'],
      ['d', 'c'],
    ]);
    expect(findCycles(merged)).toHaveLength(2);
    const { nodes } = repairTree(merged);
    expect(findCycles(nodes)).toEqual([]);
    expect(Object.keys(nodes)).toHaveLength(4);
  });

  it('navigation stays safe on a corrupt map rather than hanging', () => {
    const merged = tree([
      ['x', 'y'],
      ['y', 'x'],
    ]);
    expect(depthOf(merged, 'x')).toBe(-1);
    expect(ancestorsOf(merged, 'x').map((n) => n.id)).toEqual(['y']);
    expect(subtreeOf(merged, 'x').map((n) => n.id)).toEqual(['x', 'y']);
    expect(walkInOrder(merged)).toEqual([]); // nothing is reachable from a root
  });

  it('gives repaired nodes distinct order keys', () => {
    const merged = tree([
      ['a', 'b'],
      ['b', 'a'],
      ['c', 'd'],
      ['d', 'c'],
    ]);
    const { reparent } = planRepair(merged);
    const orders = reparent.map((m) => m.order);
    expect(new Set(orders).size).toBe(orders.length);
  });
});

describe('the child index', () => {
  /** A wide, shallow tree — the shape a real org chart has, and the one that hurts most. */
  const wideTree = (count: number): NodeMap => {
    const nodes: Record<string, ChartNode> = {};
    const keys = keysBetween(null, null, count);
    nodes['root'] = {
      id: 'root', chartId: 'c', parentId: null, order: keys[0]!, name: 'root',
      raci: {}, primaryR: null, org: null, description: '', documents: [], inputs: [], outputs: [],
    };
    for (let i = 1; i < count; i++) {
      nodes[`n${i}`] = {
        id: `n${i}`, chartId: 'c', parentId: 'root', order: keys[i]!, name: `n${i}`,
        raci: {}, primaryR: null, org: null, description: '', documents: [], inputs: [], outputs: [],
      };
    }
    return nodes;
  };

  it('buckets every node under its parent, in order', () => {
    const nodes = wideTree(6);
    const index = childIndex(nodes);
    expect(childrenIn(index, null).map((n) => n.id)).toEqual(['root']);
    expect(childrenIn(index, 'root').map((n) => n.id)).toEqual(childrenOf(nodes, 'root').map((n) => n.id));
    expect(childrenIn(index, 'n_nobody')).toEqual([]);
  });

  it('gives walkInOrder the same answer as scanning does', () => {
    const nodes = wideTree(40);
    expect(walkInOrder(nodes, childIndex(nodes)).map((n) => n.id)).toEqual(
      walkInOrder(nodes).map((n) => n.id),
    );
  });

  it('keeps the traversal linear, not quadratic', () => {
    // Not a micro-benchmark — the margin is two orders of magnitude. Walking the flat model by
    // calling childrenOf per node scans the whole map each time, which cost 84ms on the 810-row
    // demo and is a visible stall on a screen that re-renders per keystroke. At 4000 rows the old
    // shape takes seconds; this bound only fails if that shape comes back.
    const nodes = wideTree(4000);
    const started = performance.now();
    const rows = walkInOrder(nodes);
    const elapsed = performance.now() - started;
    expect(rows).toHaveLength(4000);
    expect(elapsed).toBeLessThan(250);
  });

  it('survives a parent cycle instead of blowing the stack', () => {
    // A CRDT merge can produce one — two people reparenting into each other's subtree. The walk
    // simply does not reach the cycle from the roots; repairTree is what puts those rows back.
    const nodes = { ...wideTree(4) } as Record<string, ChartNode>;
    nodes['n1'] = { ...nodes['n1']!, parentId: 'n2' };
    nodes['n2'] = { ...nodes['n2']!, parentId: 'n1' };
    expect(() => walkInOrder(nodes)).not.toThrow();
    expect(walkInOrder(nodes).map((n) => n.id)).not.toContain('n1');
  });

  it('subtreeDepth does not recurse forever on a cycle either', () => {
    const nodes = { ...wideTree(4) } as Record<string, ChartNode>;
    nodes['n1'] = { ...nodes['n1']!, parentId: 'n2' };
    nodes['n2'] = { ...nodes['n2']!, parentId: 'n1' };
    expect(() => subtreeDepth(nodes, 'n1')).not.toThrow();
  });
});
