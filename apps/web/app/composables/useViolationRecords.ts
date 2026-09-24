/**
 * The warnings pill's list for the view on screen — a thin wrapper over @raci/core's port of
 * index.html's recomputeViolations / lintFlow, which is pinned by a parity test to the source's own
 * output (packages/core/src/violations.test.ts).
 *
 * One RECORD per chart row or flow step with anything wrong, carrying every issue found there. The
 * pill counts records ("410 warnings" is 410 rows). Scope, as the source's: the active chart always;
 * on the flow screen the open flow; on every other screen, every flow anchored to the active chart.
 */
import { viewViolations, type ViolationRecord, type Workspace } from '@raci/core';

export type { ViolationRecord } from '@raci/core';
export { violationPillText } from '@raci/core';

export function violationRecords(ws: Workspace, view: string, chartId: string | null, flowId: string | null): ViolationRecord[] {
  return viewViolations(ws, { view, chartId, flowId });
}

/** The row or step a record is about. */
export function recordId(r: ViolationRecord): string {
  return r.kind === 'chart' ? r.nodeId : r.stepId;
}
