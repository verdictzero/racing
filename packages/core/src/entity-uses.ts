/**
 * Where an entity is named as a party — index.html's `entityUses`, to the letter.
 *
 * `computeEntityUses` in registry.ts answers the same question for the Object Gallery, with two
 * deliberate departures: it counts a step once however many of its columns name the entity, and it
 * lists places in record order. The Roster's entity cards print this list verbatim — the count on
 * the badge ("named by 3 things") and every line of its tooltip — so they need the source's own
 * answer, not a tidied one:
 *
 *   - charts in tab order, each walked depth-first in row order;
 *   - one entry per COLUMN that names the entity, so a step naming a board as both A and C is two;
 *   - the source's fallbacks: "(untitled)" rows, "Untitled chart", "(untitled step)",
 *     "Untitled flow".
 *
 * The legacy function also counts the Tasks view's scope when it points at the entity. That scope
 * is per-person view state here, never document content, so it is not a use of anything.
 */

import { byOrder } from './fractional.js';
import type { UseSite } from './registry.js';
import type { OrgRef, Workspace } from './schema.js';
import { childIndex, childrenIn } from './tree.js';

const names = (ref: OrgRef | null | undefined, entityId: string): boolean =>
  !!ref && 'entityId' in ref && ref.entityId === entityId;

export function entityUsesInOrder(ws: Workspace, entityId: string): UseSite[] {
  const out: UseSite[] = [];

  const charts = Object.values(ws.charts)
    .map((chart) => ({ chart, id: chart.id, order: ws.chartOrder[chart.id] ?? '' }))
    .sort(byOrder)
    .map((entry) => entry.chart);
  for (const chart of charts) {
    const where = chart.title || 'Untitled chart';
    const index = childIndex(chart.nodes);
    const seen = new Set<string>();
    const walk = (parentId: string | null) => {
      for (const node of childrenIn(index, parentId)) {
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        if (names(node.org, entityId)) {
          out.push({ kind: 'chartRow', name: node.name || '(untitled)', where, chartId: chart.id, nodeId: node.id });
        }
        walk(node.id);
      }
    };
    walk(null);
  }

  for (const flow of Object.values(ws.flows)) {
    const where = flow.name || 'Untitled flow';
    for (const step of Object.values(flow.steps)) {
      for (const ref of Object.values(step.parties)) {
        if (names(ref, entityId)) {
          out.push({ kind: 'flowStep', name: step.name || '(untitled step)', where, flowId: flow.id, stepId: step.id });
        }
      }
    }
  }

  for (const artifact of Object.values(ws.artifacts)) {
    if (names(artifact.ownerRef, entityId)) {
      out.push({ kind: 'deliverable', name: artifact.name, where: 'Deliverables' });
    }
  }

  return out;
}
