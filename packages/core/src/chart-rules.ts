/**
 * The chart rules: index.html's `recomputeViolations`, the chart walk, ported rule for rule.
 *
 * Seven checks per row, from the RACI literature by way of the legacy app:
 *
 *   multipleOwner      ERROR  more than one owner (A) on a row — the hard rule
 *   noOwner            warn   no owner on the row, and none inherited down the primary-R cascade
 *   ambiguousPrimaryR  warn   two or more doers (R) and no primary — the cascade stalls here
 *   invalidPrimaryR    warn   a primary is designated, but that column is not a doer on the row
 *   noDoer             warn   a LEAF row nobody is assigned to do; a parent is only a grouping
 *   overConsulted      warn   more than half the columns Consulted — a sign-off bottleneck
 *   inputNoProducer    warn   a declared input nothing anywhere produces
 *
 * Findings come back as index.html's `_violations` entries — one RECORD per row, carrying every
 * issue on it, its severity the worst of them — in the order the chart's tree is walked. That shape
 * is not incidental: the legacy pill counts records, the popover lists them in walk order under a
 * tier label and a crumb, and a pin marks a row once however many rules it breaks.
 *
 * Advisory, always. A chart mid-edit is allowed to be wrong, and a tool that refused to save one
 * would just be worked around.
 */

import { framework } from './constants.js';
import {
  cellLetters,
  chartColumnLabel,
  chartTierLabel,
  legacyChartShape,
  legacyTree,
  ownEntry,
  primaryRColumn,
  type TreeRow,
} from './lint-context.js';
import {
  worstSeverity,
  type ChartViolationRecord,
  type Violation,
  type ViolationCrumb,
  type ViolationIssue,
} from './raci.js';
import type { ArtifactUses } from './registry.js';
import type { Chart, ChartNode } from './schema.js';

/** What the chart walk needs from outside the chart. */
export interface ChartRuleEnv {
  /** The workspace's column labels, which the messages print. */
  readonly columnLabels: Readonly<Record<string, string>>;
  /** The deliverable registry. Without it, every declared input is taken to exist. */
  readonly artifacts?: Readonly<Record<string, { readonly name: string }>>;
  /**
   * Whether anything other than row `consumerNodeId` itself produces `artifactId`. Without it the
   * supply check does not run at all: a chart on its own cannot see a producer in another chart or
   * in a flow, and guessing would mean warning about supplies that exist.
   */
  readonly hasProducer?: (artifactId: string, consumerNodeId: string) => boolean;
}

/** Walk one chart, top down, the way `recomputeViolations` walks the active one. */
export function chartRecords(chart: Chart, env: ChartRuleEnv): ChartViolationRecord[] {
  const F = framework(chart.framework);
  const OWNER = F.owner;
  const DOER = F.doer;
  const ownerName = F.meta[OWNER]?.label ?? OWNER;
  const doerName = F.meta[DOER]?.label ?? DOER;
  const CC = legacyChartShape(chart).columns;
  const colLabel = (k: string) => chartColumnLabel(chart, env.columnLabels, k);
  const tierName = (tier: number) => chartTierLabel(chart, tier);
  const colsWith = (n: ChartNode, letter: string) =>
    CC.filter((k) => cellLetters(n.raci, k).includes(letter));
  // More than half the columns marked Consulted reads as a sign-off bottleneck.
  const OVER_CONSULT = Math.floor(CC.length / 2) + 1;
  const artifact = (id: string) => (env.artifacts ? ownEntry(env.artifacts, id) : undefined);
  const artifactExists = (id: string) => !env.artifacts || artifact(id) !== undefined;
  const artifactLabel = (id: string) => {
    const a = artifact(id);
    return a ? a.name || 'Untitled deliverable' : '(missing deliverable)';
  };

  const out: ChartViolationRecord[] = [];
  // The owner column each row inherits: what `cascadeDown` hands it from the row above.
  const inherited = new Map<string, string | null>();

  for (const row of legacyTree(chart).rows) {
    const n = row.node;
    const inheritedOwnerCol = row.parent
      ? (primaryRColumn(row.parent.node, CC) ?? inherited.get(row.parent.node.id) ?? null)
      : null;
    inherited.set(n.id, inheritedOwnerCol);

    const ownerCols = colsWith(n, OWNER);
    const doerCols = colsWith(n, DOER);
    const consultCols = colsWith(n, 'C');
    const issues: ViolationIssue[] = [];

    // 1. Exactly one owner — too many.
    if (ownerCols.length > 1) {
      issues.push({
        rule: 'multipleOwner',
        severity: 'err',
        message: `Multiple ${ownerName} (${OWNER}) assignments: ${ownerCols.map(colLabel).join(', ')}. Only one ${OWNER} per row.`,
      });
    }
    // 2. Exactly one owner — none, and none inherited from above. The cardinal RACI failure, and
    //    still only a warning: a chart being written has rows nobody has got to yet.
    else if (ownerCols.length === 0 && !inheritedOwnerCol) {
      issues.push({
        rule: 'noOwner',
        severity: 'warn',
        message: `No ${ownerName} (${OWNER}) — this row has no clear owner and inherits none. Assign exactly one ${OWNER}.`,
      });
    }
    // 3. Ambiguous doer cascade — two or more doers, and none designated to flow down as owner.
    if (doerCols.length > 1 && !(n.primaryR && doerCols.includes(n.primaryR))) {
      issues.push({
        rule: 'ambiguousPrimaryR',
        severity: 'warn',
        message: `${doerCols.length} ${doerName} (${DOER}) parties (${doerCols.map(colLabel).join(', ')}) but none marked primary — children won't inherit an ${ownerName}.`,
      });
    }
    // 4. A designated primary pointing at a column that is not actually a doer.
    if (n.primaryR && doerCols.length > 0 && !doerCols.includes(n.primaryR)) {
      issues.push({
        rule: 'invalidPrimaryR',
        severity: 'warn',
        message: `Primary ${DOER} is set to "${colLabel(n.primaryR)}" but that column is not marked ${DOER} on this row.`,
      });
    }
    // 5. A unit of work nobody does. Leaf rows only: a parent is a grouping, and its work is done
    //    by the rows beneath it.
    if (row.leaf && doerCols.length === 0) {
      issues.push({
        rule: 'noDoer',
        severity: 'warn',
        message: `No ${doerName} (${DOER}) — no one is assigned to do this ${tierName(row.depth).toLowerCase()}.`,
      });
    }
    // 6. Over-consulting — the most common RACI anti-pattern.
    if (consultCols.length >= OVER_CONSULT) {
      issues.push({
        rule: 'overConsulted',
        severity: 'warn',
        message: `Over-consulted: ${consultCols.length} of ${CC.length} parties marked Consulted (C). Each C is a sign-off bottleneck — keep consults lean.`,
      });
    }
    // 7. A declared input nothing produces — the supply chain breaks upstream of this row. A row
    //    never supplies itself: "takes the register, returns the register" is a row restating what
    //    it works on, and counting it would silence the rule exactly where a chain is easiest to
    //    break. An input naming a deliverable that no longer exists is a different fault and is
    //    left alone; one named twice is reported twice, as it is in the source.
    const hasProducer = env.hasProducer;
    if (hasProducer) {
      const orphans = n.inputs.filter((id) => artifactExists(id) && !hasProducer(id, n.id));
      if (orphans.length > 0) {
        const one = orphans.length === 1;
        issues.push({
          rule: 'inputNoProducer',
          severity: 'warn',
          message: `Input${one ? '' : 's'} ${orphans.map((id) => `"${artifactLabel(id)}"`).join(', ')} ha${one ? 's' : 've'} no producer — nothing anywhere declares ${one ? 'it' : 'them'} as an output or handoff.`,
        });
      }
    }

    if (issues.length > 0) {
      out.push({
        kind: 'chart',
        chartId: chart.id,
        nodeId: n.id,
        name: n.name || '(untitled)',
        tier: row.depth,
        tierLabel: tierName(row.depth),
        ancestors: crumbOf(row),
        severity: worstSeverity(issues),
        issues,
      });
    }
  }
  return out;
}

/** The rows above `row`, top down, as the popover's crumb prints them. */
function crumbOf(row: TreeRow): ViolationCrumb[] {
  const out: ViolationCrumb[] = [];
  for (let p = row.parent; p; p = p.parent) {
    out.unshift({ id: p.node.id, name: p.node.name || '(untitled)' });
  }
  return out;
}

/** Records, flattened back to one entry per issue. */
export function chartIssues(records: readonly ChartViolationRecord[]): Violation[] {
  return records.flatMap((r) =>
    r.issues.map((i) => ({
      nodeId: r.nodeId,
      rule: i.rule,
      severity: i.severity,
      message: i.message,
    })),
  );
}

/**
 * What `chartViolations` needs that a chart alone cannot answer.
 *
 * A row's declared input may be produced by a row in a DIFFERENT chart, or by a handoff in a flow,
 * which makes the supply check workspace-scoped. Rather than pretend, the check does not run unless
 * the caller hands over the index. `viewViolations` and `workspaceViolations` always do.
 */
export interface ChartRuleContext {
  /** The producer/consumer index from `computeArtifactUses`, computed once for the workspace. */
  readonly artifactUses?: Map<string, ArtifactUses>;
  /** The deliverable registry, for names in the message and to ignore ids that no longer resolve. */
  readonly artifacts?: Readonly<Record<string, { readonly name: string }>>;
  /** The workspace's column labels, which the messages print. The defaults when absent. */
  readonly columnLabels?: Readonly<Record<string, string>>;
}

/**
 * One chart's findings, one per issue, in the order the legacy popover lists them.
 *
 * The flat form of `chartRecords`, kept for the row pins and for callers written against it. The
 * pill counts ROWS — use `viewViolations` for anything that has to match it.
 */
export function chartViolations(chart: Chart, ctx: ChartRuleContext = {}): Violation[] {
  const uses = ctx.artifactUses;
  return chartIssues(
    chartRecords(chart, {
      columnLabels: ctx.columnLabels ?? {},
      artifacts: ctx.artifacts,
      hasProducer: uses
        ? (id, nodeId) =>
            (uses.get(id)?.producers ?? []).some(
              (p) => !(p.kind === 'chartRow' && p.nodeId === nodeId),
            )
        : undefined,
    }),
  );
}
