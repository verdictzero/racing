/**
 * The whole workspace, linted.
 *
 * `chartViolations` and `flowViolations` are the two engines; this is the one call that runs both
 * over everything and hands each the context it cannot work out for itself. There is a real reason
 * it exists rather than leaving callers to loop: two of the rules need information from OUTSIDE the
 * document being linted, and both fail quietly rather than loudly when it is missing.
 *
 *   - a chart row's declared input may be supplied by another chart or by a flow handoff, so the
 *     supply check needs the workspace-wide producer index;
 *   - an anchored flow inherits its owner from the chart row it hangs under, so every step in it
 *     looks ownerless unless that column is passed down.
 *
 * Forgetting the first silently disables a rule. Forgetting the second silently invents a warning
 * on every step of every anchored flow. Neither is the kind of mistake a caller would notice, so
 * neither is left to the caller.
 */

import { computeArtifactUses } from './registry.js';
import { chartViolations, effectiveRaci, type Violation } from './raci.js';
import { flowViolations, type FlowViolation } from './flow-rules.js';
import { framework } from './constants.js';
import { chartColumns, type Flow, type Workspace } from './schema.js';

export interface WorkspaceViolations {
  /** Chart violations, keyed by chart id. Charts with nothing to report are absent. */
  readonly charts: Map<string, Violation[]>;
  /** Flow violations, keyed by flow id. Flows with nothing to report are absent. */
  readonly flows: Map<string, FlowViolation[]>;
  /** Everything, flat — for the corner count and the problems list. */
  readonly all: Array<Violation | FlowViolation>;
  readonly errors: number;
  readonly warnings: number;
}

/**
 * The owner column an anchored flow inherits from the chart row it hangs under.
 *
 * Resolved through `effectiveRaci`, not off the row's own cells: a row that inherits its owner from
 * two tiers up still HAS one, and a flow anchored to it inherits it just the same.
 */
export function anchorOwnerColumn(ws: Workspace, flow: Pick<Flow, 'anchor'>): string | null {
  const anchor = flow.anchor;
  if (!anchor) return null;
  const chart = ws.charts[anchor.chartId];
  if (!chart?.nodes[anchor.nodeId]) return null;

  const fw = framework(chart.framework);
  const eff = effectiveRaci(chart, chart.nodes, anchor.nodeId);
  return chartColumns(chart).find((c) => (eff[c]?.letters ?? '').includes(fw.owner)) ?? null;
}

/** Lint every chart and every flow in the workspace. */
export function workspaceViolations(ws: Workspace): WorkspaceViolations {
  // Computed once for the whole workspace, not once per chart — it walks every node and every edge
  // in the document, and a 810-row chart is not a thing to walk eleven times.
  const artifactUses = computeArtifactUses(ws);
  const ctx = { artifactUses, artifacts: ws.artifacts };

  const charts = new Map<string, Violation[]>();
  const flows = new Map<string, FlowViolation[]>();
  const all: Array<Violation | FlowViolation> = [];

  for (const chart of Object.values(ws.charts)) {
    const found = chartViolations(chart, ctx);
    if (found.length > 0) charts.set(chart.id, found);
    all.push(...found);
  }

  for (const flow of Object.values(ws.flows)) {
    const found = flowViolations(ws, flow.id, { anchorOwnerColumn: anchorOwnerColumn(ws, flow) });
    if (found.length > 0) flows.set(flow.id, found);
    all.push(...found);
  }

  return {
    charts,
    flows,
    all,
    errors: all.filter((v) => v.severity === 'err').length,
    warnings: all.filter((v) => v.severity === 'warn').length,
  };
}
