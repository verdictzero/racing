/**
 * The warnings pill's list — index.html's `_violations`, for the view on screen.
 *
 * One RECORD per chart row or flow step that has anything wrong with it, carrying every issue
 * found there; the record's severity is the worst of its issues. The pill counts records, not
 * issues ("410 warnings" is 410 rows), and the popover lists them in the source's order: the
 * active chart's rows depth-first, then flow steps.
 *
 * Scope, exactly as recomputeViolations: the active chart is always linted; on the flow screen only
 * the OPEN flow is added, and on every other screen, every flow anchored to the active chart.
 */
import {
  ancestorsOf,
  depthOf,
  tierLabel,
  walkInOrder,
  workspaceViolations,
  type Workspace,
} from '@raci/core';

export interface ViolationIssue {
  readonly rule: string;
  readonly severity: 'err' | 'warn';
  readonly message: string;
}

export interface ViolationRecord {
  readonly kind: 'chart' | 'flow';
  /** Chart row id, or flow step id. */
  readonly id: string;
  readonly flowId: string | null;
  readonly name: string;
  readonly tierLabel: string;
  readonly ancestors: readonly string[];
  readonly severity: 'err' | 'warn';
  readonly issues: readonly ViolationIssue[];
}

export function violationRecords(
  ws: Workspace,
  view: string,
  chartId: string | null,
  flowId: string | null,
): ViolationRecord[] {
  const all = workspaceViolations(ws);
  const out: ViolationRecord[] = [];

  const chart = chartId ? ws.charts[chartId] : undefined;
  if (chart) {
    const byNode = new Map<string, ViolationIssue[]>();
    for (const v of all.charts.get(chart.id) ?? []) {
      const list = byNode.get(v.nodeId) ?? [];
      list.push({ rule: v.rule, severity: v.severity, message: v.message });
      byNode.set(v.nodeId, list);
    }
    for (const node of walkInOrder(chart.nodes)) {
      const issues = byNode.get(node.id);
      if (!issues?.length) continue;
      out.push({
        kind: 'chart',
        id: node.id,
        flowId: null,
        name: node.name || '(untitled)',
        tierLabel: tierLabel(chart, depthOf(chart.nodes, node.id)),
        ancestors: ancestorsOf(chart.nodes, node.id).map((a) => a.name || '(untitled)'),
        severity: issues.some((i) => i.severity === 'err') ? 'err' : 'warn',
        issues,
      });
    }
  }

  const flowIds = view === 'bizcase'
    ? (flowId ? [flowId] : [])
    : Object.values(ws.flows).filter((f) => chartId && f.anchor?.chartId === chartId).map((f) => f.id);
  for (const fid of flowIds) {
    const flow = ws.flows[fid];
    if (!flow) continue;
    const byStep = new Map<string, ViolationIssue[]>();
    for (const v of all.flows.get(fid) ?? []) {
      const list = byStep.get(v.stepId) ?? [];
      list.push({ rule: v.rule, severity: v.severity, message: v.message });
      byStep.set(v.stepId, list);
    }
    for (const step of Object.values(flow.steps)) {
      const issues = byStep.get(step.id);
      if (!issues?.length) continue;
      out.push({
        kind: 'flow',
        id: step.id,
        flowId: fid,
        name: step.name || (step.kind === 'subflow' ? 'Nested flow' : 'Untitled step'),
        tierLabel: step.kind === 'subflow' ? 'Nested flow' : 'Flow step',
        ancestors: [flow.name || 'Untitled case'],
        severity: issues.some((i) => i.severity === 'err') ? 'err' : 'warn',
        issues,
      });
    }
  }
  return out;
}

/** "410 warnings", "2 errors · 3 warnings", "1 warning" — index.html's renderViolationsUI. */
export function violationPillText(records: readonly ViolationRecord[]): string {
  const errs = records.filter((r) => r.severity === 'err').length;
  const warns = records.length - errs;
  const parts: string[] = [];
  if (errs) parts.push(`${errs} error${errs === 1 ? '' : 's'}`);
  if (warns) parts.push(`${warns} warning${warns === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
