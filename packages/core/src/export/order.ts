/**
 * Flow steps in dependency order.
 *
 * Shared by the exporters, which both want a flow to read the way it runs rather than the way it
 * was typed. Kahn's algorithm, with two deliberate properties:
 *
 *   - DETERMINISTIC. Ready steps are taken in id order, so the same flow always produces the same
 *     sequence. Without that, a Mermaid diagram pasted into a wiki would produce a spurious diff
 *     on every re-export.
 *   - TOTAL. A flow may legitimately contain a cycle — a rework loop is a real thing a process
 *     does — so anything still unvisited is appended rather than dropped. An exporter that lost
 *     steps because the process loops would be wrong in the worst way: quietly.
 */

import type { Flow } from '../schema.js';

export function topologicalOrder(flow: Flow): string[] {
  const ids = Object.keys(flow.steps).sort();
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  const out = new Map<string, string[]>();

  for (const edge of Object.values(flow.edges)) {
    if (!flow.steps[edge.from] || !flow.steps[edge.to]) continue;
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    const list = out.get(edge.from);
    if (list) list.push(edge.to);
    else out.set(edge.from, [edge.to]);
  }

  const ready = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
  const ordered: string[] = [];
  const seen = new Set<string>();

  while (ready.length > 0) {
    ready.sort();
    const id = ready.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
    for (const next of out.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }

  for (const id of ids) if (!seen.has(id)) ordered.push(id);
  return ordered;
}
