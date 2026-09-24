/**
 * Running the rules the way index.html runs them.
 *
 * chart-rules.ts and flow-rules.ts are the two engines. This is what decides which of them runs over
 * what, and how the result is counted — and both of those are as much a part of matching the legacy
 * app as the rules are. Its warnings pill does not count issues: it counts RECORDS, one per row or
 * step, each as severe as the worst issue on it. Nor does it lint everything: it lints the chart in
 * front, and then
 *
 *   - in the flow view, the flow being worked on (anchored or not), and nothing else;
 *   - in every other view, each flow anchored to the chart in front — so the pill carries the flow
 *     hygiene of the chart under review without dragging in unrelated tabletop sketches.
 *
 * `viewViolations` does all of that in one call, and is what a screen should use. On the demo it
 * says "410 warnings" in the chart view and "416 warnings" in the flow view with the tabletop open,
 * as index.html does — which `violations.test.ts` checks against index.html's own output.
 */

import { chartIssues, chartRecords, type ChartRuleEnv } from './chart-rules.js';
import { flowIssues, flowRecords, type FlowViolation } from './flow-rules.js';
import {
  chartsInOrder,
  createLintCache,
  createLintContext,
  liveAnchor,
  ownEntry,
  resolveActiveChart,
  resolveActiveFlow,
  type LintCache,
  type LintContext,
} from './lint-context.js';
import type {
  ChartViolationRecord,
  FlowViolationRecord,
  Violation,
  ViolationRecord,
} from './raci.js';
import type { Flow, Workspace } from './schema.js';

/**
 * Which screen is up, in index.html's names — the same ones the shell writes to `body[data-view]`.
 * `'flow'` is accepted for the flow view too, since that is the rebuild's route for it.
 */
export type ViolationView = 'chart' | 'roster' | 'work' | 'objects' | 'bizcase' | 'flow';

/** What decides which flows are linted: the screen, the chart tab in front, the flow open. */
export interface ViolationScope {
  readonly view: ViolationView | (string & {});
  /** The chart in front. A missing or stale id falls back to the first chart tab, as `ac()` does. */
  readonly chartId?: string | null;
  /** The flow open in the flow view. A missing or stale id falls back to the first flow (`abc()`). */
  readonly flowId?: string | null;
}

/** True for the flow view, whichever of its two names the caller uses. */
export function isFlowView(view: string): boolean {
  return view === 'bizcase' || view === 'flow';
}

/**
 * The flows the legacy app lints alongside the chart, in its order: the open flow in the flow
 * view; everywhere else, every flow anchored to the chart in front.
 */
export function flowsToLint(ws: Workspace, scope: ViolationScope): string[] {
  if (isFlowView(scope.view)) {
    const flow = resolveActiveFlow(ws, scope.flowId);
    return flow ? [flow.id] : [];
  }
  const chart = resolveActiveChart(ws, scope.chartId);
  if (!chart) return [];
  const cache = createLintCache();
  return Object.values(ws.flows)
    .filter((flow) => liveAnchor(ws, flow, cache)?.chartId === chart.id)
    .map((flow) => flow.id);
}

/** Everything the chart walk needs from the workspace — the supply check included, always. */
function chartEnv(ws: Workspace, lc: LintContext): ChartRuleEnv {
  return { columnLabels: ws.columnLabels, artifacts: ws.artifacts, hasProducer: lc.hasProducer };
}

/**
 * index.html's `_violations`: the chart in front walked row by row, then the given flows, each
 * step and nested-flow box of which is a record of its own.
 *
 * `chartId` is the chart in front (a stale one falls back to the first tab). It matters to the
 * flows as well as the chart: every cascade reads the chart in front's columns, as the legacy app's
 * does. `flowIds` is which flows to lint — `flowsToLint` gives the legacy app's choice, and
 * `viewViolations` makes both calls at once.
 */
export function violationRecords(
  ws: Workspace,
  opts: { readonly chartId?: string | null; readonly flowIds: readonly string[] },
): ViolationRecord[] {
  const lc = createLintContext(ws, opts.chartId);
  const out: ViolationRecord[] = lc.activeChart
    ? chartRecords(lc.activeChart, chartEnv(ws, lc))
    : [];
  for (const id of opts.flowIds) {
    const flow = ownEntry(ws.flows, id);
    if (flow) out.push(...flowRecords(lc, flow));
  }
  return out;
}

/** What the legacy app shows for one screen: `flowsToLint` and `violationRecords` in one call. */
export function viewViolations(ws: Workspace, scope: ViolationScope): ViolationRecord[] {
  return violationRecords(ws, { chartId: scope.chartId, flowIds: flowsToLint(ws, scope) });
}

/** Records by severity. A record is an error when any issue on it is. */
export function violationCounts(records: readonly ViolationRecord[]): {
  errors: number;
  warnings: number;
} {
  const errors = records.filter((r) => r.severity === 'err').length;
  return { errors, warnings: records.length - errors };
}

/**
 * The warnings pill, word for word: "410 warnings", "1 warning", "2 errors · 3 warnings",
 * "1 error". Empty when there is nothing to report — the legacy app hides the pill then.
 */
export function violationPillText(records: readonly ViolationRecord[]): string {
  const { errors, warnings } = violationCounts(records);
  const parts: string[] = [];
  if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  if (warnings) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/**
 * The records by what they pin — index.html's `_violationsByNodeId` and `_violationsByBizTaskId`.
 * A pin's colour is its record's severity, and its tooltip the record's messages.
 */
export function violationIndex(records: readonly ViolationRecord[]): {
  byNodeId: Map<string, ChartViolationRecord>;
  byStepId: Map<string, FlowViolationRecord>;
} {
  const byNodeId = new Map<string, ChartViolationRecord>();
  const byStepId = new Map<string, FlowViolationRecord>();
  for (const r of records) {
    if (r.kind === 'chart') byNodeId.set(r.nodeId, r);
    else byStepId.set(r.stepId, r);
  }
  return { byNodeId, byStepId };
}

// ---- the whole workspace, for callers that want everything -----------------------------------------

export interface WorkspaceViolations {
  /** Each chart's findings, linted as the chart in front, keyed by chart id. Clean ones absent. */
  readonly charts: Map<string, Violation[]>;
  /** Each flow's findings, keyed by flow id. Clean flows are absent. */
  readonly flows: Map<string, FlowViolation[]>;
  /** Everything, one entry per issue: every chart in tab order, then every flow. */
  readonly all: Array<Violation | FlowViolation>;
  /**
   * ISSUES by severity, not records. The legacy pill counts records, and only a view's worth of
   * them — for that, `viewViolations` and `violationPillText`.
   */
  readonly errors: number;
  readonly warnings: number;
}

/**
 * The chart a flow is linted against when no screen says otherwise: the one it is anchored in —
 * which is the chart in front whenever the legacy app lints an anchored flow outside the flow view
 * — else the first tab.
 */
function defaultChartFor(
  ws: Workspace,
  flow: Pick<Flow, 'anchor'>,
  cache?: LintCache,
): string | null {
  return liveAnchor(ws, flow, cache)?.chartId ?? null;
}

/**
 * Lint every chart and every flow in the workspace, whatever screen is up.
 *
 * Not something the legacy app ever does — it lints one chart and a view's worth of flows — so it
 * is not what a warnings pill should count. It is the right thing for a per-document question ("is
 * anything wrong in here?") and for the row and step pins, which look the same on every screen.
 */
export function workspaceViolations(ws: Workspace): WorkspaceViolations {
  const cache = createLintCache();
  const contexts = new Map<string | null, LintContext>();
  const contextFor = (chartId: string | null) => {
    let lc = contexts.get(chartId);
    if (!lc) {
      lc = createLintContext(ws, chartId, cache);
      contexts.set(chartId, lc);
    }
    return lc;
  };

  const charts = new Map<string, Violation[]>();
  const flows = new Map<string, FlowViolation[]>();
  const all: Array<Violation | FlowViolation> = [];

  for (const chart of chartsInOrder(ws)) {
    const found = chartIssues(chartRecords(chart, chartEnv(ws, contextFor(chart.id))));
    if (found.length > 0) charts.set(chart.id, found);
    all.push(...found);
  }

  for (const flow of Object.values(ws.flows)) {
    const found = flowIssues(flowRecords(contextFor(defaultChartFor(ws, flow, cache)), flow));
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

/**
 * The owner column an anchored flow's steps inherit — `bizAnchorCtx(flow).ownerCol`.
 *
 * Exactly what the cascade would hand the anchor row's CHILDREN if the drill kept going: the row's
 * own primary R column, else the owner column the row itself inherits. Not the row's own owner —
 * whoever DOES the work at one tier owns it at the next, and a flow sits one tier below its anchor.
 * Null for a flow with no anchor, an anchor that no longer resolves, or a cascade that hands
 * nothing down. `activeChartId` is the chart in front, whose columns every cascade reads.
 */
export function anchorOwnerColumn(
  ws: Workspace,
  flow: Pick<Flow, 'anchor'>,
  opts: { readonly activeChartId?: string | null } = {},
): string | null {
  const chartId = opts.activeChartId !== undefined ? opts.activeChartId : defaultChartFor(ws, flow);
  return createLintContext(ws, chartId).anchor(flow)?.ownerColumn ?? null;
}
