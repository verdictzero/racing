/**
 * Tree operations over the flat node map.
 *
 * Every function here is pure: it takes the node map and returns an answer or a set of changes.
 * Nothing mutates, because the same logic has to run against a plain object (an imported file, a
 * database row) and against a Yjs document, and only one of those can be mutated by assignment.
 *
 * THE CYCLE PROBLEM
 * A flat tree stores parentage per node, which is what makes concurrent edits merge. The cost is
 * that a cycle becomes REPRESENTABLE: two people, each moving one of two rows under the other,
 * both make a legal single-node change, and the merge produces A→B→A. No CRDT prevents this; it
 * is inherent to distributed tree editing.
 *
 * The fix is not to prevent it — you cannot, without a lock — but to make it detectable and to
 * resolve it the same way on every client. `findCycles` finds them; `resolveCycles` breaks each
 * one by re-rooting its lexicographically-smallest member. Smallest-id is arbitrary but it is
 * DETERMINISTIC, which is the property that matters: every client independently arrives at the
 * same tree without exchanging a message. The rows are never lost — worst case one surfaces at
 * the top level, visible, for a person to put back.
 */

import { byOrder, keyBetween } from './fractional.js';
import type { ChartNode } from './schema.js';

export type NodeMap = Readonly<Record<string, ChartNode>>;

/** Children of `parentId` (null = the roots), in order. */
export function childrenOf(nodes: NodeMap, parentId: string | null): ChartNode[] {
  const out: ChartNode[] = [];
  for (const id in nodes) {
    const n = nodes[id]!;
    if (n.parentId === parentId) out.push(n);
  }
  return out.sort(byOrder);
}

/** Roots, in order. */
export function rootsOf(nodes: NodeMap): ChartNode[] {
  return childrenOf(nodes, null);
}

/**
 * Depth of a node: 0 for a root, 1 for its children, and so on.
 * Returns -1 when the node is missing or its ancestry runs into a cycle.
 */
export function depthOf(nodes: NodeMap, id: string): number {
  let depth = 0;
  let cur = nodes[id];
  const seen = new Set<string>([id]);
  while (cur && cur.parentId !== null) {
    if (seen.has(cur.parentId)) return -1; // cycle
    seen.add(cur.parentId);
    cur = nodes[cur.parentId];
    if (!cur) return -1; // dangling parent
    depth++;
  }
  return cur ? depth : -1;
}

/** Ancestors of `id`, nearest first. Stops at a cycle rather than looping. */
export function ancestorsOf(nodes: NodeMap, id: string): ChartNode[] {
  const out: ChartNode[] = [];
  const seen = new Set<string>([id]);
  let cur = nodes[id];
  while (cur && cur.parentId !== null) {
    if (seen.has(cur.parentId)) break;
    seen.add(cur.parentId);
    const parent = nodes[cur.parentId];
    if (!parent) break;
    out.push(parent);
    cur = parent;
  }
  return out;
}

/** Root-first path down to `id`, inclusive — the breadcrumb. */
export function pathTo(nodes: NodeMap, id: string): ChartNode[] {
  const node = nodes[id];
  if (!node) return [];
  return [...ancestorsOf(nodes, id).reverse(), node];
}

/** `id` and everything beneath it, depth-first in display order. */
export function subtreeOf(nodes: NodeMap, id: string): ChartNode[] {
  const root = nodes[id];
  if (!root) return [];
  const out: ChartNode[] = [root];
  const seen = new Set<string>([id]);
  const walk = (parentId: string) => {
    for (const child of childrenOf(nodes, parentId)) {
      if (seen.has(child.id)) continue; // cycle guard
      seen.add(child.id);
      out.push(child);
      walk(child.id);
    }
  };
  walk(id);
  return out;
}

/** Every node in display order, depth-first from the roots. */
export function walkInOrder(nodes: NodeMap): ChartNode[] {
  const out: ChartNode[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null) => {
    for (const child of childrenOf(nodes, parentId)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
      walk(child.id);
    }
  };
  walk(null);
  return out;
}

/** How deep the subtree under `id` runs. A leaf is 0. */
export function subtreeDepth(nodes: NodeMap, id: string): number {
  const kids = childrenOf(nodes, id);
  if (kids.length === 0) return 0;
  return 1 + Math.max(...kids.map((k) => subtreeDepth(nodes, k.id)));
}

/** Count of everything strictly below `id`. */
export function descendantCount(nodes: NodeMap, id: string): number {
  return Math.max(0, subtreeOf(nodes, id).length - 1);
}

/** True when `maybeAncestorId` is at or above `id`. The check a reparent has to make. */
export function isAncestorOf(nodes: NodeMap, maybeAncestorId: string, id: string): boolean {
  if (maybeAncestorId === id) return true;
  return ancestorsOf(nodes, id).some((a) => a.id === maybeAncestorId);
}

// ---- moves -----------------------------------------------------------------------------------

export interface MovePlan {
  readonly id: string;
  readonly parentId: string | null;
  readonly order: string;
}

export class TreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TreeError';
  }
}

/**
 * Work out where a node lands when it is dropped into `parentId` at position `index`, without
 * applying anything. The caller writes the two fields — which is one small change in a CRDT
 * rather than a splice of two arrays.
 *
 * `index` counts among the destination's children AFTER the node is removed from wherever it was,
 * so dragging a row down one place inside its own parent behaves the way a person expects.
 */
export function planMove(
  nodes: NodeMap,
  id: string,
  parentId: string | null,
  index: number,
): MovePlan {
  const node = nodes[id];
  if (!node) throw new TreeError(`no such node: ${id}`);
  if (parentId !== null && !nodes[parentId]) throw new TreeError(`no such parent: ${parentId}`);
  // Locally preventable cycles are still worth preventing: it keeps the single-client case exact
  // and leaves resolveCycles to handle only the genuinely concurrent case it cannot avoid.
  if (parentId !== null && isAncestorOf(nodes, id, parentId)) {
    throw new TreeError(`cannot move ${id} into its own descendant ${parentId}`);
  }

  const siblings = childrenOf(nodes, parentId).filter((n) => n.id !== id);
  const at = Math.max(0, Math.min(index, siblings.length));
  const before = at > 0 ? siblings[at - 1]!.order : null;
  const after = at < siblings.length ? siblings[at]!.order : null;
  return { id, parentId, order: keyBetween(before, after) };
}

/** The order key for a new last child of `parentId`. */
export function orderForAppend(nodes: NodeMap, parentId: string | null): string {
  const siblings = childrenOf(nodes, parentId);
  const last = siblings.length > 0 ? siblings[siblings.length - 1]!.order : null;
  return keyBetween(last, null);
}

/** The order key for a new sibling directly after `siblingId`. */
export function orderAfter(nodes: NodeMap, siblingId: string): string {
  const sibling = nodes[siblingId];
  if (!sibling) throw new TreeError(`no such node: ${siblingId}`);
  const siblings = childrenOf(nodes, sibling.parentId);
  const at = siblings.findIndex((n) => n.id === siblingId);
  const next = at >= 0 && at + 1 < siblings.length ? siblings[at + 1]!.order : null;
  return keyBetween(sibling.order, next);
}

// ---- integrity ---------------------------------------------------------------------------------

/**
 * Every cycle in the parent graph, each as the set of node ids that form it.
 * An empty result is the normal case; anything else came from a concurrent reparent.
 */
export function findCycles(nodes: NodeMap): string[][] {
  const state = new Map<string, 'visiting' | 'done'>();
  const cycles: string[][] = [];

  for (const startId in nodes) {
    if (state.get(startId) === 'done') continue;
    const path: string[] = [];
    const onPath = new Map<string, number>();
    let cur: string | null = startId;

    while (cur !== null) {
      if (state.get(cur) === 'done') break;
      const seenAt = onPath.get(cur);
      if (seenAt !== undefined) {
        cycles.push(path.slice(seenAt));
        break;
      }
      onPath.set(cur, path.length);
      path.push(cur);
      const node: ChartNode | undefined = nodes[cur];
      cur = node ? node.parentId : null;
    }
    for (const id of path) state.set(id, 'done');
  }
  return cycles;
}

/** A node whose parentId names something that is not in the map. */
export function findOrphans(nodes: NodeMap): string[] {
  const out: string[] = [];
  for (const id in nodes) {
    const p = nodes[id]!.parentId;
    if (p !== null && !nodes[p]) out.push(id);
  }
  return out.sort();
}

export interface RepairPlan {
  /** Nodes to re-root, with the order key each should take. */
  readonly reparent: MovePlan[];
  readonly cycles: string[][];
  readonly orphans: string[];
}

/**
 * Work out the repairs that make a merged node map a valid tree again.
 *
 * Deterministic by construction — same input, same plan, on every client — so each one can apply
 * it independently and land on the same tree. Nothing is deleted: a broken node is re-rooted where
 * a person can see it and put it back.
 */
export function planRepair(nodes: NodeMap): RepairPlan {
  const cycles = findCycles(nodes);
  const orphans = findOrphans(nodes);
  const reparent: MovePlan[] = [];

  // Track the order keys handed out so two repairs in one pass cannot collide.
  const rootOrders = rootsOf(nodes).map((n) => n.order);
  let lastRoot = rootOrders.length > 0 ? rootOrders[rootOrders.length - 1]! : null;
  const toRoot = (id: string) => {
    const order = keyBetween(lastRoot, null);
    lastRoot = order;
    reparent.push({ id, parentId: null, order });
  };

  for (const cycle of cycles) {
    // The smallest id is an arbitrary choice; being the SAME arbitrary choice everywhere is the
    // point. Every client breaks the ring at the same link with no coordination.
    const victim = [...cycle].sort()[0]!;
    toRoot(victim);
  }
  for (const id of orphans) toRoot(id);

  return { reparent, cycles, orphans };
}

/** Apply a repair plan to a plain node map, returning a new one. */
export function applyRepair(nodes: NodeMap, plan: RepairPlan): NodeMap {
  if (plan.reparent.length === 0) return nodes;
  const next: Record<string, ChartNode> = { ...nodes };
  for (const move of plan.reparent) {
    const node = next[move.id];
    if (!node) continue;
    next[move.id] = { ...node, parentId: move.parentId, order: move.order };
  }
  return next;
}

/** Convenience: repair in one call. Returns the fixed map and what had to be done. */
export function repairTree(nodes: NodeMap): { nodes: NodeMap; plan: RepairPlan } {
  const plan = planRepair(nodes);
  return { nodes: applyRepair(nodes, plan), plan };
}
