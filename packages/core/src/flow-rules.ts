/**
 * The flow rules.
 *
 * The other half of the rule engine. `raci.ts` lints a chart; this lints a flow, and the two are
 * separate because they check genuinely different things — a chart is about who owns what, a flow
 * is about whether the sequence holds together.
 *
 * ADVISORY, ALWAYS. Like the chart rules, these are a reading list and never a blocker. A flow
 * mid-draft is allowed to be wrong, and a tool that refused to save one would simply be worked
 * around. The count in the corner is an invitation, not a gate.
 *
 * WHAT IS DELIBERATELY NOT A RULE
 * "This deliverable is never consumed" is not flagged. A terminal deliverable — the report at the
 * end that nothing else takes — is completely legitimate, and is usually what the process was FOR;
 * flagging it produces exactly the warn-storm that makes people stop reading warnings. It surfaces
 * as a registry annotation instead (`terminalArtifacts`, beside `orphanArtifacts` for the ones
 * nothing points at in either direction), which is where the question actually belongs.
 *
 * Nor is the mirror of it, "this input has no producer" — not HERE, at least. A deliverable can
 * only reach a flow step by riding a handoff, and a handoff registers its source step as that
 * deliverable's producer, so the check can never fail for a well-formed flow. It is a real rule
 * about a CHART row, whose `inputs` are declared rather than delivered, and it lives in
 * `chartViolations` accordingly.
 */

import { framework } from './constants.js';
import type { Severity, Violation } from './raci.js';
import type { Flow, FlowStep, Workspace } from './schema.js';

export interface FlowViolation extends Violation {
  readonly flowId: string;
  /** The step it is about. Same as `nodeId`, named for what it is in this context. */
  readonly stepId: string;
}

function issue(
  flow: Flow,
  step: FlowStep,
  rule: string,
  severity: Severity,
  message: string,
): FlowViolation {
  return {
    flowId: flow.id,
    stepId: step.id,
    nodeId: step.id,
    rule,
    severity,
    message,
  };
}

const label = (step: FlowStep) => step.name || 'an untitled step';

/**
 * Steps reachable by following handoffs from any entry point.
 *
 * An entry point is a step nothing hands off to. A flow with no entry point at all is a pure
 * cycle, and every step in it is then treated as reachable — the flow is strange but nothing is
 * gained by flagging every single step as unreachable.
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

/** True when nesting `refId` inside `hostId` would close a reference loop. */
export function embedWouldCycle(ws: Workspace, hostId: string, refId: string): boolean {
  if (hostId === refId) return true;
  const seen = new Set<string>();
  const visit = (flowId: string): boolean => {
    if (flowId === hostId) return true;
    if (seen.has(flowId)) return false;
    seen.add(flowId);
    const flow = ws.flows[flowId];
    if (!flow) return false;
    for (const step of Object.values(flow.steps)) {
      if (step.kind === 'subflow' && step.refId && visit(step.refId)) return true;
    }
    return false;
  };
  return visit(refId);
}

/**
 * Lint one flow.
 *
 * `anchorOwnerColumn` is the owner column the flow inherits from the chart row it is anchored to.
 * Pass it and a step that states no owner of its own is NOT nagged — it has one, it just did not
 * have to repeat it. Omitting it makes every step look ownerless, which is the wrong answer for
 * an anchored flow.
 */
export function flowViolations(
  ws: Workspace,
  flowId: string,
  opts: { anchorOwnerColumn?: string | null } = {},
): FlowViolation[] {
  const flow = ws.flows[flowId];
  if (!flow) return [];

  const fw = framework(flow.framework);
  const out: FlowViolation[] = [];
  const reachable = reachableSteps(flow);

  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of Object.values(flow.edges)) {
    (outgoing.get(edge.from) ?? outgoing.set(edge.from, []).get(edge.from)!).push(edge.id);
    (incoming.get(edge.to) ?? incoming.set(edge.to, []).get(edge.to)!).push(edge.id);
  }

  const stepCount = Object.keys(flow.steps).length;

  for (const step of Object.values(flow.steps)) {
    // ---- nested-flow boxes get their own checks -------------------------------------------------
    // A subflow box holds no RACI of its own — the roles live in the flow it references and are
    // linted when THAT flow is checked. Applying the role rules here would lint the wrong document.
    if (step.kind === 'subflow') {
      const ref = step.refId ? ws.flows[step.refId] : null;
      if (!ref) {
        out.push(
          issue(
            flow,
            step,
            'subflowMissing',
            'err',
            `The nested flow behind "${label(step)}" is gone — deleted, or an import did not carry it. Re-point the box or remove it.`,
          ),
        );
      } else if (step.refId && embedWouldCycle(ws, flow.id, step.refId)) {
        out.push(
          issue(
            flow,
            step,
            'subflowCycle',
            'err',
            `"${ref.name}" contains this flow somewhere inside it — a nesting loop. Re-point or remove this box to break it.`,
          ),
        );
      } else if (Object.keys(ref.steps).length === 0) {
        out.push(
          issue(
            flow,
            step,
            'subflowEmpty',
            'warn',
            `"${ref.name}" has no steps yet — nothing happens when this box is reached.`,
          ),
        );
      }

      const wiredIn = (incoming.get(step.id) ?? []).length > 0;
      const wiredOut = (outgoing.get(step.id) ?? []).length > 0;
      if (stepCount > 1 && !wiredIn && !wiredOut) {
        out.push(
          issue(
            flow,
            step,
            'disconnected',
            'warn',
            `"${label(step)}" has no handoffs in or out — connect one of its mating points, or remove the box.`,
          ),
        );
      }
      continue;
    }

    // ---- ordinary steps --------------------------------------------------------------------------
    const columns = Object.keys(step.raci);
    const owners = columns.filter((c) => (step.raci[c] ?? '').includes(fw.owner));
    const doers = columns.filter((c) => (step.raci[c] ?? '').includes(fw.doer));

    if (owners.length > 1) {
      out.push(
        issue(
          flow,
          step,
          'multipleOwners',
          'err',
          `"${label(step)}" names ${owners.length} ${fw.meta[fw.owner]?.label ?? fw.owner} parties. Exactly one party owns a step.`,
        ),
      );
    }
    // An anchored flow inherits its owner from the chart row, so a step that states none still has
    // one. Nagging here is the single most annoying false positive this engine can produce.
    if (owners.length === 0 && !opts.anchorOwnerColumn) {
      out.push(
        issue(
          flow,
          step,
          'noOwner',
          'warn',
          `"${label(step)}" has no ${fw.meta[fw.owner]?.label ?? fw.owner} party, and the flow inherits none.`,
        ),
      );
    }
    if (doers.length === 0) {
      out.push(
        issue(
          flow,
          step,
          'noDoer',
          'warn',
          `"${label(step)}" has no ${fw.meta[fw.doer]?.label ?? fw.doer} party — nobody is named to do it.`,
        ),
      );
    }

    // Two different faults, and telling them apart is what makes the message actionable.
    //
    // DISCONNECTED: no handoffs at all. Note this is NOT caught by the reachability check — a step
    // with no incoming edge is by definition an entry point, so an isolated step counts as
    // "reachable" and would slip through. It needs its own rule.
    //
    // UNREACHABLE: it has handoffs, but no path from any entry point leads to it — which in
    // practice means it is stranded inside a cycle.
    const isolated =
      (incoming.get(step.id) ?? []).length === 0 && (outgoing.get(step.id) ?? []).length === 0;
    if (stepCount > 1 && isolated) {
      out.push(
        issue(
          flow,
          step,
          'disconnected',
          'warn',
          `"${label(step)}" has no handoffs in or out — nothing leads to it and nothing follows it.`,
        ),
      );
    } else if (stepCount > 1 && !reachable.has(step.id)) {
      out.push(
        issue(
          flow,
          step,
          'unreachable',
          'warn',
          `"${label(step)}" cannot be reached from the start of the flow — no path of handoffs leads to it.`,
        ),
      );
    }

    // A decision point whose branches are unlabelled is the flow equivalent of an unowned row:
    // the diagram says a choice happens and refuses to say what decides it.
    const outIds = outgoing.get(step.id) ?? [];
    if (outIds.length >= 2) {
      const unlabelled = outIds.filter((id) => !(flow.edges[id]?.label ?? '').trim());
      if (unlabelled.length > 0) {
        out.push(
          issue(
            flow,
            step,
            'unlabelledBranch',
            'warn',
            `"${label(step)}" branches ${outIds.length} ways but ${unlabelled.length} of them carry no condition — a reader cannot tell which path is taken.`,
          ),
        );
      }
    }

  }

  // A handoff naming no deliverable is "and then the work moves along" — the thing the typed
  // handoff exists to stop. Filed against the source step, which is where a person would look.
  for (const edge of Object.values(flow.edges)) {
    if (edge.artifactIds.length > 0) continue;
    const from = flow.steps[edge.from];
    const to = flow.steps[edge.to];
    if (!from || !to) continue;
    out.push(
      issue(
        flow,
        from,
        'handoffWithoutDeliverable',
        'warn',
        `The handoff from "${label(from)}" to "${label(to)}" names no deliverable — what, exactly, moves?`,
      ),
    );
  }

  return out.sort(
    (a, b) => a.stepId.localeCompare(b.stepId) || a.rule.localeCompare(b.rule),
  );
}

/**
 * How healthy an anchored flow is, as a percentage.
 *
 * The roll-up the chart row shows, so discipline at the bottom is legible at the top. Counts three
 * checks: every step has an owner, every step has a doer, every handoff names a deliverable.
 * Nested-flow boxes are excluded from the role checks — scoring them would permanently dock the
 * host for work that is assigned inside the flow they reference.
 */
export function flowHealth(
  ws: Workspace,
  flowId: string,
  opts: { anchorOwnerColumn?: string | null } = {},
): { passed: number; total: number; percent: number } | null {
  const flow = ws.flows[flowId];
  if (!flow) return null;

  const fw = framework(flow.framework);
  let passed = 0;
  let total = 0;

  for (const edge of Object.values(flow.edges)) {
    total++;
    if (edge.artifactIds.length > 0) passed++;
  }

  for (const step of Object.values(flow.steps)) {
    if (step.kind === 'subflow') continue;
    const columns = Object.keys(step.raci);
    total += 2;
    if (columns.some((c) => (step.raci[c] ?? '').includes(fw.owner)) || opts.anchorOwnerColumn) passed++;
    if (columns.some((c) => (step.raci[c] ?? '').includes(fw.doer))) passed++;
  }

  if (total === 0) return { passed: 0, total: 0, percent: 100 };
  return { passed, total, percent: Math.round((passed / total) * 100) };
}
