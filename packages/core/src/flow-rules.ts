/**
 * The flow rules: index.html's `lintFlow`, ported rule for rule.
 *
 * The other half of the rule engine. chart-rules.ts lints a chart; this lints a flow, and the two are
 * separate because they check genuinely different things — a chart is about who owns what, a flow
 * about whether the sequence holds together and every step traces to someone.
 *
 * A nested-flow box owns no RACI, so it gets its own checks and none of the role rules:
 *
 *   subflowMissing       ERROR  the flow it points at is gone
 *   subflowCycle         ERROR  the flow it points at contains this one — a nesting loop
 *   subflowEmpty         warn   the flow it points at has no steps
 *   flowDisconnected     warn   no handoff in or out
 *   subflowExitDangling  warn   exposed exit points that lead nowhere
 *
 * Every other step is checked on its RESOLVED line (`LintContext.stepRaci`), so a Chart-Linked step
 * taking its owner and doer from the row it implements is not nagged for authoring nothing:
 *
 *   flowStepUnlinked      ERROR  Chart-Linked flow, and the step names no chart row
 *   flowBindMissing       ERROR  the row it names is gone
 *   flowBindForeign       warn   the row lives in a chart other than the flow's source chart
 *   flowFinalDraftSource  warn   a Final flow reading live from a Draft chart
 *   flowBindOverride      warn   columns taken back from the row, and changed
 *   multipleOwner         ERROR  more than one owner (A)
 *   flowNoOwner           warn   no owner, and none inherited from the anchor's cascade
 *   flowOwnerOverride     warn   an owner on a different column than the cascade puts it
 *   flowNoDoer            warn   nobody does it
 *   decisionUnlabeled     warn   a branch point with an unlabelled branch
 *   handoffWithoutArtifact warn  outgoing handoffs that carry no deliverable
 *   flowDisconnected      warn   no handoff in or out
 *   flowPartyMissing      warn   a doer column with no executing party, named or defaulted
 *
 * Boxes are reported before steps, whatever their order in the flow — the legacy pass runs two
 * loops, and the popover lists what it produced in that order.
 *
 * WHAT IS DELIBERATELY NOT A RULE
 * "This deliverable is never consumed": a terminal deliverable — the report at the end nothing else
 * takes — is usually what the process was FOR, and flagging it produces the warn-storm that makes
 * people stop reading warnings. It surfaces as a registry annotation (`terminalArtifacts`) instead.
 * Nor "this flow input has no producer": a deliverable can only reach a step on a handoff, and the
 * handoff registers its source step as the producer, so the check could never fail. It is a real
 * rule about a CHART row, whose inputs are declared rather than delivered (`inputNoProducer`).
 * Nor "unreachable step": index.html has no such rule, so neither does this.
 */

import { COLS, framework, type ColKey } from './constants.js';
import {
  columnDirectorate,
  createLintContext,
  legacyChartShape,
  liveAnchor,
  orgColumnLabel,
  ownEntry,
  stepBindOverrides,
  stepLabel,
  subflowRefId,
  translateLetters,
  type LintContext,
} from './lint-context.js';
import {
  worstSeverity,
  type FlowViolationRecord,
  type Violation,
  type ViolationIssue,
} from './raci.js';
import type { Flow, FlowEdge, FlowStep, Workspace } from './schema.js';

export interface FlowViolation extends Violation {
  readonly flowId: string;
  /** The step it is about. Same as `nodeId`, named for what it is in this context. */
  readonly stepId: string;
}

/**
 * Steps reachable by following handoffs from any entry point.
 *
 * An entry point is a step nothing hands off to. A flow with no entry point at all is a pure cycle,
 * and every step in it is then treated as reachable. Not a rule — index.html raises nothing for an
 * unreachable step — but a question the canvas can still ask.
 */
export function reachableSteps(flow: Flow): Set<string> {
  const hasIncoming = new Set<string>();
  for (const edge of Object.values(flow.edges)) {
    if (flow.steps[edge.to]) hasIncoming.add(edge.to);
  }
  const entries = Object.keys(flow.steps).filter((id) => !hasIncoming.has(id));
  if (entries.length === 0) return new Set(Object.keys(flow.steps));

  const out = new Map<string, string[]>();
  for (const edge of Object.values(flow.edges)) {
    const list = out.get(edge.from);
    if (list) list.push(edge.to);
    else out.set(edge.from, [edge.to]);
  }

  const seen = new Set<string>(entries);
  const queue = [...entries];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const next of out.get(id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/**
 * True when nesting `refId` inside `hostId` would close a reference loop: `bizEmbedWouldCycle`.
 * Walks the reference graph across flows, so A→B→C→A is caught, not just A→A.
 */
export function embedWouldCycle(ws: Workspace, hostId: string, refId: string): boolean {
  if (hostId === refId) return true;
  const seen = new Set<string>();
  const visit = (flowId: string): boolean => {
    if (flowId === hostId) return true;
    if (seen.has(flowId)) return false;
    seen.add(flowId);
    const flow = ownEntry(ws.flows, flowId);
    if (!flow) return false;
    for (const step of Object.values(flow.steps)) {
      if (step.kind === 'subflow' && step.refId && visit(step.refId)) return true;
    }
    return false;
  };
  return visit(refId);
}

/**
 * The exit points a nested-flow box exposes (`subflowOpenPorts(box, 'out')`): the referenced flow's
 * exits — steps that hand off to nothing, or every step if it is one closed loop — narrowed to the
 * box's own selection. A selection naming nothing that still exists falls back to all of them.
 */
function openExitPorts(
  lc: LintContext,
  box: FlowStep,
  ref: Flow,
): Array<{ readonly id: string; readonly name: string }> {
  const steps = Object.values(ref.steps);
  const handsOff = new Set(lc.edges(ref).map((e) => e.from));
  const exits = steps.filter((s) => !handsOff.has(s.id));
  const list = exits.length > 0 ? exits : steps;
  const chosen = new Set(box.ports.out);
  const live = list.filter((s) => chosen.has(s.id));
  const on = new Set((live.length > 0 ? live : list).map((s) => s.id));
  return list
    .filter((s) => on.has(s.id))
    .map((s) => ({ id: s.id, name: s.name || '(untitled step)' }));
}

/**
 * Lint one flow, the way `lintFlow` does, into index.html's `_violations` entries.
 *
 * `inheritedOwner` overrides the owner column the flow inherits from its anchor. Leave it undefined:
 * the anchor is resolved from the workspace, as the legacy app resolves it.
 */
export function flowRecords(
  lc: LintContext,
  flow: Flow,
  opts: { readonly inheritedOwner?: string | null } = {},
): FlowViolationRecord[] {
  const ws = lc.ws;
  const F = framework(flow.framework);
  const OWNER = F.owner;
  const DOER = F.doer;
  const ownerLabel = F.meta[OWNER]?.label ?? OWNER;
  const doerLabel = F.meta[DOER]?.label ?? DOER;
  const anchor = lc.anchor(flow);
  const inhOwner =
    opts.inheritedOwner !== undefined ? opts.inheritedOwner : (anchor?.ownerColumn ?? null);
  const linked = flow.mode === 'linked';
  // `COL_LABELS[k]`, printed as-is — including the "undefined" it prints for a column that is not
  // an org column, which only a cascade out of a free-form chart can produce.
  const colLabel = (k: string) => String(orgColumnLabel(ws.columnLabels, k));
  const source = flow.sourceChartId ? ownEntry(ws.charts, flow.sourceChartId) : undefined;
  // The loader drops a source chart that is missing or free-form, and with it this rule's premise.
  const sourceChart = source && !legacyChartShape(source).free ? source : null;

  const edges = lc.edges(flow);
  const outBy = new Map<string, FlowEdge[]>();
  const touched = new Set<string>();
  for (const e of edges) {
    const list = outBy.get(e.from);
    if (list) list.push(e);
    else outBy.set(e.from, [e]);
    touched.add(e.from);
    touched.add(e.to);
  }
  const steps = Object.values(flow.steps);

  const out: FlowViolationRecord[] = [];
  // Shared tail: every path ends by filing its issues against the step.
  const record = (step: FlowStep, issues: ViolationIssue[]) => {
    if (issues.length === 0) return;
    out.push({
      kind: 'flow',
      flowId: flow.id,
      stepId: step.id,
      name: stepLabel(ws, flow, step),
      tierLabel: step.kind === 'subflow' ? 'Nested flow' : 'Flow step',
      ancestors: [{ id: null, name: flow.name || 'Untitled case' }],
      severity: worstSeverity(issues),
      issues,
    });
  };

  // A nested-flow box owns no RACI, so the role rules would be linting the wrong document: the roles
  // live in the flow it references and are linted when THAT flow is. Its own checks instead: is the
  // reference sound, and is the box actually wired in?
  for (const box of steps) {
    if (box.kind !== 'subflow') continue;
    const issues: ViolationIssue[] = [];
    const refId = subflowRefId(flow, box);
    const ref = refId ? ownEntry(ws.flows, refId) : undefined;
    if (!ref) {
      issues.push({
        rule: 'subflowMissing',
        severity: 'err',
        message:
          'Nested flow is missing — the business case this box points at was deleted, or an import did not carry it. Re-point the box or remove it.',
      });
    } else if (embedWouldCycle(ws, flow.id, refId)) {
      issues.push({
        rule: 'subflowCycle',
        severity: 'err',
        message: `"${ref.name || 'Untitled'}" contains this flow somewhere inside it — a nesting loop. Re-point or remove this box to break it.`,
      });
    } else {
      if (Object.keys(ref.steps).length === 0) {
        issues.push({
          rule: 'subflowEmpty',
          severity: 'warn',
          message: `"${ref.name || 'Untitled'}" has no steps yet — nothing happens when this box is reached.`,
        });
      }
      const wiredIn = edges.some((e) => e.to === box.id);
      const wiredOut = edges.some((e) => e.from === box.id);
      if (steps.length > 1 && !wiredIn && !wiredOut) {
        issues.push({
          rule: 'flowDisconnected',
          severity: 'warn',
          message:
            'Disconnected nested flow — no handoffs in or out. Connect one of its mating points into this flow (or remove the box).',
        });
      }
      const open = openExitPorts(lc, box, ref);
      const unused = open.filter(
        (p) => !edges.some((e) => e.from === box.id && (e.fromPort || null) === p.id),
      );
      if (wiredIn && unused.length > 0 && open.length > 1) {
        const one = unused.length === 1;
        issues.push({
          rule: 'subflowExitDangling',
          severity: 'warn',
          message: `${unused.length} exposed exit point${one ? '' : 's'} (${unused.map((p) => p.name).join(', ')}) lead${one ? 's' : ''} nowhere — connect ${one ? 'it' : 'them'} or untick ${one ? 'it' : 'them'} on the card.`,
        });
      }
    }
    record(box, issues);
  }

  for (const step of steps) {
    if (step.kind === 'subflow') continue;
    const eff = lc.stepRaci(flow, step);
    const bind = linked ? lc.bind(step) : null;
    const colsWith = (letter: string): ColKey[] =>
      COLS.filter((k) => eff[k].letters.includes(letter));
    const ownerCols = colsWith(OWNER);
    const doerCols = colsWith(DOER);
    const issues: ViolationIssue[] = [];

    // ---- Chart-Linked rules ----
    // The mode's whole contract is "every step traces to a signed chart row", so a step naming none
    // is an error, not a style note: it is the one thing that makes the flow unverifiable.
    if (linked && !step.bind) {
      issues.push({
        rule: 'flowStepUnlinked',
        severity: 'err',
        message:
          'Chart-Linked flow, but this step names no chart row. Click ⛓ on the card and pick the row it implements — or switch the flow to Free-Form.',
      });
    }
    if (linked && step.bind && !bind) {
      issues.push({
        rule: 'flowBindMissing',
        severity: 'err',
        message:
          'The chart row this step was linked to is gone — the chart was deleted, the row removed, or an import did not carry it. Re-point the step (⛓) or unlink it.',
      });
    }
    if (bind && sourceChart && bind.chart.id !== sourceChart.id) {
      issues.push({
        rule: 'flowBindForeign',
        severity: 'warn',
        message: `This step links into "${bind.chart.title || 'another chart'}", not this flow's source chart ("${sourceChart.title || 'unknown'}"). Steps of one flow spanning charts makes the flow hard to trace back — re-point it, or change the flow's source chart.`,
      });
    }
    // A Final flow in Chart-Linked mode takes its letters LIVE from the chart. While that chart is
    // a Draft, the flow reads as settled on ground that can still move — allowed, since sign-off
    // order is the user's call, but said, per step, naming the chart that has to catch up.
    if (bind && flow.status === 'final' && bind.chart.status !== 'final') {
      issues.push({
        rule: 'flowFinalDraftSource',
        severity: 'warn',
        message: `This flow is Final, but the row it takes from lives in "${bind.chart.title || 'a chart'}", which is still a Draft — that chart can change under it. Finalize the chart, or reopen this flow while the chart settles.`,
      });
    }
    if (bind) {
      // Taking a column over without changing it is a no-op, not a divergence.
      const over = stepBindOverrides(step).filter(
        (k) => translateLetters(bind.raci[k], bind.framework, F) !== eff[k].letters,
      );
      if (over.length > 0) {
        const one = over.length === 1;
        issues.push({
          rule: 'flowBindOverride',
          severity: 'warn',
          message: `${over.length} column${one ? '' : 's'} (${over.map(colLabel).join(', ')}) override${one ? 's' : ''} the linked row "${bind.node.name || 'untitled'}" — allowed, but this step no longer matches the chart. Re-check it, or fix the chart row instead (↺ Chart in the cell to hand it back).`,
        });
      }
    }

    // ---- the role rules, cascade-aware ----
    if (ownerCols.length > 1) {
      issues.push({
        rule: 'multipleOwner',
        severity: 'err',
        message: `Multiple ${ownerLabel} (${OWNER}) assignments: ${ownerCols.map(colLabel).join(', ')}. Only one ${OWNER} per step.`,
      });
    } else if (ownerCols.length === 0 && !inhOwner) {
      const why = bind
        ? ` — and the linked row "${bind.node.name || 'untitled'}" names none either`
        : anchor
          ? ' — and the chart cascade provides none'
          : ' — standalone flows inherit none';
      issues.push({
        rule: 'flowNoOwner',
        severity: 'warn',
        message: `No ${ownerLabel} (${OWNER}) on this step${why}.`,
      });
    }
    // An inherited owner satisfies the owner rule; an explicit owner somewhere else is a branch
    // override — allowed, flagged, never blocked.
    if (ownerCols.length === 1 && inhOwner && ownerCols[0] !== inhOwner) {
      issues.push({
        rule: 'flowOwnerOverride',
        severity: 'warn',
        message: `${ownerLabel} (${OWNER}) sits on ${colLabel(ownerCols[0]!)}, but the chart cascade puts ownership on ${colLabel(inhOwner)} — branch override (allowed, but re-check against the chart).`,
      });
    }
    if (doerCols.length === 0) {
      issues.push({
        rule: 'flowNoDoer',
        severity: 'warn',
        message: `No ${doerLabel} (${DOER}) — no one is assigned to do this step.`,
      });
    }

    // ---- the sequence ----
    const outs = outBy.get(step.id) ?? [];
    if (outs.length >= 2 && outs.some((e) => !e.label.trim())) {
      issues.push({
        rule: 'decisionUnlabeled',
        severity: 'warn',
        message: `Decision point with ${outs.length} branches, but not every branch is labeled — name each path's condition.`,
      });
    }
    const bare = outs.filter((e) => e.artifactIds.length === 0);
    if (bare.length > 0) {
      const one = bare.length === 1;
      issues.push({
        rule: 'handoffWithoutArtifact',
        severity: 'warn',
        message: `${bare.length} outgoing handoff${one ? '' : 's'} carr${one ? 'ies' : 'y'} no deliverable — click the edge and name what is handed off.`,
      });
    }
    if (steps.length > 1 && !touched.has(step.id)) {
      issues.push({
        rule: 'flowDisconnected',
        severity: 'warn',
        message:
          'Disconnected step — no handoffs in or out. Connect it into the flow (or delete it).',
      });
    }

    // ---- who executes ----
    // A doer column needs an executing party: one named on the step, or the default a bound row or
    // the anchor supplies — the column's directorate — when the column maps to one.
    const partyContext = bind ?? anchor;
    const partyless = doerCols.filter(
      (k) => !ownEntry(step.parties, k) && !(partyContext && columnDirectorate(ws, k) !== null),
    );
    if (partyless.length > 0) {
      const one = partyless.length === 1;
      issues.push({
        rule: 'flowPartyMissing',
        severity: 'warn',
        message: `${doerLabel} column${one ? '' : 's'} ${partyless.map(colLabel).join(', ')} ha${one ? 's' : 've'} no responsible party — assign who executes (directorate → … → team).`,
      });
    }
    record(step, issues);
  }

  return out;
}

/** Records, flattened back to one entry per issue. */
export function flowIssues(records: readonly FlowViolationRecord[]): FlowViolation[] {
  return records.flatMap((r) =>
    r.issues.map((i) => ({
      flowId: r.flowId,
      stepId: r.stepId,
      nodeId: r.stepId,
      rule: i.rule,
      severity: i.severity,
      message: i.message,
    })),
  );
}

export interface FlowRuleOptions {
  /**
   * The owner column the flow inherits, overriding what its anchor resolves to. Normally left out:
   * the anchor is read from the workspace, as index.html reads it.
   */
  readonly anchorOwnerColumn?: string | null;
  /**
   * The chart in front — `ac()`. Its columns drive every cascade (see lint-context.ts). Defaults to
   * the chart the flow is anchored in, which is the chart in front whenever the legacy app lints an
   * anchored flow outside the flow view; else the first chart.
   */
  readonly activeChartId?: string | null;
}

function contextFor(ws: Workspace, flow: Flow, opts: FlowRuleOptions): LintContext {
  const activeChartId =
    opts.activeChartId !== undefined ? opts.activeChartId : (liveAnchor(ws, flow)?.chartId ?? null);
  return createLintContext(ws, activeChartId);
}

/**
 * One flow's findings, one per issue, in the order the legacy popover lists them.
 *
 * The flat form of `flowRecords`, kept for the step pins and for callers written against it. The
 * pill counts STEPS — use `viewViolations` for anything that has to match it.
 */
export function flowViolations(
  ws: Workspace,
  flowId: string,
  opts: FlowRuleOptions = {},
): FlowViolation[] {
  const flow = ownEntry(ws.flows, flowId);
  if (!flow) return [];
  return flowIssues(
    flowRecords(contextFor(ws, flow, opts), flow, { inheritedOwner: opts.anchorOwnerColumn }),
  );
}

/**
 * How healthy a flow is, as a percentage — index.html's `flowHealth`, for one flow.
 *
 * The roll-up an anchored chart row shows, so discipline at the bottom is legible at the top. One
 * check per handoff (it names a deliverable), two per step (it has an owner — its own or the
 * cascade's — and a doer, both on its resolved line), and in a Chart-Linked flow one more per step
 * (it traces to a row). Nested-flow boxes are left out: scoring them would permanently dock the
 * host for work that is assigned inside the flow they reference.
 */
export function flowHealth(
  ws: Workspace,
  flowId: string,
  opts: FlowRuleOptions = {},
): { passed: number; total: number; percent: number } | null {
  const flow = ownEntry(ws.flows, flowId);
  if (!flow) return null;

  const lc = contextFor(ws, flow, opts);
  const fw = framework(flow.framework);
  const inherited =
    opts.anchorOwnerColumn !== undefined
      ? opts.anchorOwnerColumn
      : (lc.anchor(flow)?.ownerColumn ?? null);
  let passed = 0;
  let total = 0;

  for (const edge of lc.edges(flow)) {
    total++;
    if (edge.artifactIds.length > 0) passed++;
  }

  for (const step of Object.values(flow.steps)) {
    if (step.kind === 'subflow') continue;
    const eff = lc.stepRaci(flow, step);
    total++;
    if (COLS.some((k) => eff[k].letters.includes(fw.owner)) || inherited) passed++;
    total++;
    if (COLS.some((k) => eff[k].letters.includes(fw.doer))) passed++;
    if (flow.mode === 'linked') {
      total++;
      if (lc.bind(step)) passed++;
    }
  }

  if (total === 0) return { passed: 0, total: 0, percent: 100 };
  return { passed, total, percent: Math.round((passed / total) * 100) };
}
