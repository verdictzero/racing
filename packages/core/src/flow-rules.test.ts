import { describe, it, expect } from 'vitest';
import demo from './__fixtures__/demo-workspace.json' with { type: 'json' };
import { importLegacy } from './legacy.js';
import { embedWouldCycle, flowHealth, flowViolations, reachableSteps } from './flow-rules.js';
import { computeArtifactUses, orphanArtifacts } from './registry.js';
import type { Workspace } from './schema.js';

const { workspace } = importLegacy(demo);
const tabletopId = Object.entries(workspace.flows).find(([, f]) => /Tabletop/.test(f.name))![0];
const evidenceId = Object.entries(workspace.flows).find(([, f]) => /Evidence/.test(f.name))![0];

const rulesOf = (ws: Workspace, id: string, opts = {}) =>
  flowViolations(ws, id, opts).map((v) => v.rule);

describe('reachability', () => {
  it('reaches every step of the demo tabletop', () => {
    const flow = workspace.flows[tabletopId]!;
    expect(reachableSteps(flow).size).toBe(Object.keys(flow.steps).length);
  });

  it('spots a step nothing leads to', () => {
    const ws = structuredClone(workspace);
    const flow = ws.flows[tabletopId]!;
    flow.steps['t_island'] = {
      id: 't_island', flowId: flow.id, kind: 'step', refId: null,
      name: 'Orphaned step', description: '', entry: '', exit: '',
      x: 0, y: 0, groupId: null, raci: { hq: 'A', cyber: 'R' }, parties: {}, bind: null,
      bindOverrides: [], ports: { in: [], out: [] },
    };
    // A step with no incoming edge is by definition an ENTRY point, so an isolated one counts as
    // reachable — which is why "disconnected" has to be its own rule rather than a case of
    // unreachability. The rule id was 'disconnected' here; index.html's is 'flowDisconnected'.
    expect(reachableSteps(flow).has('t_island')).toBe(true);
    expect(rulesOf(ws, tabletopId)).toContain('flowDisconnected');
  });

  it('knows a step stranded inside a cycle is unreachable — and, like index.html, says nothing', () => {
    const ws = structuredClone(workspace);
    const flow = ws.flows[tabletopId]!;
    // Two steps that only point at each other: they have handoffs, so they are not disconnected,
    // but no path from any entry point reaches them.
    for (const [id, name] of [['t_x', 'Stranded A'], ['t_y', 'Stranded B']] as const) {
      flow.steps[id] = {
        id, flowId: flow.id, kind: 'step', refId: null, name,
        description: '', entry: '', exit: '', x: 0, y: 0, groupId: null,
        raci: { hq: 'A', cyber: 'R' }, parties: {}, bind: null, bindOverrides: [],
        ports: { in: [], out: [] },
      };
    }
    flow.edges['e_xy'] = { id: 'e_xy', flowId: flow.id, from: 't_x', to: 't_y', fromPort: null, toPort: null, label: '', artifactIds: [], via: [] };
    flow.edges['e_yx'] = { id: 'e_yx', flowId: flow.id, from: 't_y', to: 't_x', fromPort: null, toPort: null, label: '', artifactIds: [], via: [] };

    expect(reachableSteps(flow).has('t_x')).toBe(false);
    // This engine used to warn 'unreachable' here. index.html's lintFlow has no reachability rule
    // at all, so the port raises nothing; `reachableSteps` stays as a question the canvas can ask.
    expect(rulesOf(ws, tabletopId)).not.toContain('unreachable');
    // What the stranded pair does get is what any wired step with those letters gets: a bare
    // handoff, and a doer column with no executing party.
    const stranded = flowViolations(ws, tabletopId).filter((v) => v.stepId === 't_x');
    expect(stranded.map((v) => v.rule)).toEqual(['handoffWithoutArtifact', 'flowPartyMissing']);
  });

  it('treats a pure cycle as reachable rather than flagging every step', () => {
    // A flow that is all loop has no entry point. Calling every step unreachable would be true and
    // useless; the flow is strange but the warning would not help anyone fix it.
    const ws = structuredClone(workspace);
    const flow = ws.flows[evidenceId]!;
    const ids = Object.keys(flow.steps);
    flow.edges['e_loop'] = {
      id: 'e_loop', flowId: flow.id, from: ids[ids.length - 1]!, to: ids[0]!,
      fromPort: null, toPort: null, label: 'again', artifactIds: [], via: [],
    };
    // Every step now has an incoming edge, so there is no entry point.
    expect(reachableSteps(flow).size).toBe(ids.length);
  });
});

// The rule ids below are index.html's (`lintFlow`), which violations.test.ts pins against the legacy
// app's own output. Where an expectation changed, the comment beside it says what this engine used
// to do and what the source does instead.
describe('flow rules', () => {
  it('flags a step nobody owns', () => {
    // Was 'noOwner'; index.html's flow rule is 'flowNoOwner'.
    const ws = structuredClone(workspace);
    const flow = ws.flows[tabletopId]!;
    const step = Object.values(flow.steps).find((s) => s.kind === 'step')!;
    step.raci = { cyber: 'R' }; // a doer but no owner
    const found = flowViolations(ws, tabletopId).filter(
      (v) => v.stepId === step.id && v.rule === 'flowNoOwner',
    );
    expect(found).toHaveLength(1);
  });

  it('does NOT flag an ownerless step when the flow inherits an owner from its anchor', () => {
    // The single most annoying false positive this engine could produce: an anchored flow's steps
    // have an owner, they just did not have to repeat it.
    //
    // This used to hand the rule an owner column through `anchorOwnerColumn` on a flow with no
    // anchor. The rule now resolves the anchor itself, as index.html does, so the test anchors the
    // flow for real — under the demo's first row, whose single R cascades down to its children.
    const ws = structuredClone(workspace);
    const flow = ws.flows[tabletopId]!;
    const chartId = Object.keys(ws.charts)[0]!;
    const top = Object.values(ws.charts[chartId]!.nodes).find((n) => n.parentId === null)!;
    flow.anchor = { chartId, nodeId: top.id };
    const step = Object.values(flow.steps).find((s) => s.kind === 'step')!;
    step.raci = { cyber: 'R' };
    const onStep = (w: Workspace) =>
      flowViolations(w, tabletopId).filter((v) => v.stepId === step.id).map((v) => v.rule);
    expect(onStep(ws)).not.toContain('flowNoOwner');

    // The explicit override still works for a caller that wants to ask "what if".
    flow.anchor = null;
    expect(onStep(ws)).toContain('flowNoOwner');
    expect(rulesOf(ws, tabletopId, { anchorOwnerColumn: 'hq' })).not.toContain('flowNoOwner');
  });

  it('flags two owners on one step', () => {
    // Was 'multipleOwners'; index.html's rule id is 'multipleOwner'.
    const ws = structuredClone(workspace);
    const step = Object.values(ws.flows[tabletopId]!.steps).find((s) => s.kind === 'step')!;
    step.raci = { hq: 'A', cos: 'A', cyber: 'R' };
    const found = flowViolations(ws, tabletopId).find((v) => v.rule === 'multipleOwner')!;
    expect(found.severity).toBe('err');
  });

  it('flags a decision point whose branches carry no condition', () => {
    // Was 'unlabelledBranch'; index.html's rule id is 'decisionUnlabeled'.
    const ws = structuredClone(workspace);
    const flow = ws.flows[tabletopId]!;
    for (const edge of Object.values(flow.edges)) edge.label = '';
    expect(rulesOf(ws, tabletopId)).toContain('decisionUnlabeled');
  });

  it('does not flag a labelled decision point — the demo labels both branches', () => {
    const detect = Object.values(workspace.flows[tabletopId]!.steps).find(
      (s) => s.name === 'Detect & Triage',
    )!;
    const found = flowViolations(workspace, tabletopId).filter(
      (v) => v.stepId === detect.id && v.rule === 'decisionUnlabeled',
    );
    expect(found).toHaveLength(0);
  });

  it('flags a handoff that names no deliverable', () => {
    // "And then the work moves along" is exactly what the typed handoff exists to stop.
    // Was 'handoffWithoutDeliverable', one per edge; index.html's is 'handoffWithoutArtifact', one
    // per step, counting that step's bare outgoing handoffs.
    expect(rulesOf(workspace, tabletopId)).toContain('handoffWithoutArtifact');
  });

  it('does not check inputs at all — a flow cannot have one without a producer', () => {
    // Worth pinning down, because the rule reads like it belongs here and does not. A deliverable
    // can only reach a step by riding a handoff, and a handoff registers its SOURCE step as that
    // deliverable's producer. So the check is unfalsifiable in a flow: put an otherwise-unproduced
    // deliverable on any edge and the edge itself supplies the producer.
    const ws = structuredClone(workspace);
    ws.artifacts['a_ghost'] = {
      id: 'a_ghost', name: 'Ghost Report', type: 'document',
      ownerRef: null, description: '', doc: null,
    };
    const [edge] = Object.values(ws.flows[tabletopId]!.edges);
    edge!.artifactIds = ['a_ghost'];

    expect(computeArtifactUses(ws).get('a_ghost')!.producers).toHaveLength(1);
    expect(rulesOf(ws, tabletopId)).not.toContain('inputWithoutProducer');
    expect(rulesOf(ws, tabletopId)).not.toContain('inputNoProducer');
    // Where it IS a real rule is a chart row, whose inputs are declared rather than delivered.
    // See raci.test.ts.
  });

  it('says nothing about a deliverable that is produced and never consumed', () => {
    // The report at the end of the process is what the process was FOR. Flagging it produces the
    // warn-storm that makes people stop reading warnings, so the engine stays quiet and the
    // registry annotates instead.
    const ws = structuredClone(workspace);
    ws.artifacts['a_final'] = {
      id: 'a_final', name: 'Post-Incident Report', type: 'document',
      ownerRef: null, description: '', doc: null,
    };
    const flow = ws.flows[tabletopId]!;
    // Carried on a handoff into the last step, and taken nowhere afterwards.
    const terminal = Object.keys(flow.steps).find(
      (id) => !Object.values(flow.edges).some((e) => e.from === id),
    )!;
    const inbound = Object.values(flow.edges).find((e) => e.to === terminal)!;
    inbound.artifactIds = [...inbound.artifactIds, 'a_final'];

    const rules = rulesOf(ws, tabletopId);
    expect(rules).not.toContain('outputNeverConsumed');
    expect(rules).not.toContain('inputWithoutProducer');
    expect(rules).not.toContain('inputNoProducer');

    // …and it is not an orphan either: something DOES point at it. See registry.test.ts for the
    // annotations that answer the question the rule engine deliberately stays quiet about.
    expect(orphanArtifacts(ws).map((a) => a.id)).not.toContain('a_final');
  });

  it('is deterministic', () => {
    expect(flowViolations(workspace, tabletopId)).toEqual(flowViolations(workspace, tabletopId));
  });

  it('returns nothing for a flow that does not exist', () => {
    expect(flowViolations(workspace, 'b_nope')).toEqual([]);
  });
});

describe('nested-flow rules', () => {
  it('does not apply the role rules to a subflow box', () => {
    // A nested box holds no RACI of its own; the roles live in the flow it references.
    const flow = workspace.flows[tabletopId]!;
    const sub = Object.values(flow.steps).find((s) => s.kind === 'subflow')!;
    const rules = flowViolations(workspace, tabletopId)
      .filter((v) => v.stepId === sub.id)
      .map((v) => v.rule);
    // The role rules' ids were 'noOwner' / 'noDoer' here; index.html's are these.
    expect(rules).not.toContain('flowNoOwner');
    expect(rules).not.toContain('flowNoDoer');
    expect(rules).not.toContain('flowPartyMissing');
  });

  it('flags a box whose flow is gone', () => {
    const ws = structuredClone(workspace);
    const sub = Object.values(ws.flows[tabletopId]!.steps).find((s) => s.kind === 'subflow')!;
    sub.refId = 'b_deleted';
    const found = flowViolations(ws, tabletopId).find((v) => v.rule === 'subflowMissing')!;
    expect(found.severity).toBe('err');
  });

  it('flags a nesting loop', () => {
    // Rewritten for the port. This used to make the tabletop's box nest the tabletop ITSELF and
    // expect 'subflowCycle'. index.html's loader clears a self-reference (the editor refuses one),
    // so such a box points at nothing — 'subflowMissing' — and a loop takes two flows: here the
    // evidence procedure nests the tabletop that nests it.
    const ws = structuredClone(workspace);
    const self = structuredClone(ws);
    const sub = Object.values(self.flows[tabletopId]!.steps).find((s) => s.kind === 'subflow')!;
    sub.refId = tabletopId;
    expect(rulesOf(self, tabletopId)).toContain('subflowMissing');
    expect(rulesOf(self, tabletopId)).not.toContain('subflowCycle');

    const evidence = ws.flows[evidenceId]!;
    evidence.steps['t_back'] = {
      ...Object.values(ws.flows[tabletopId]!.steps).find((s) => s.kind === 'subflow')!,
      id: 't_back', flowId: evidenceId, refId: tabletopId, name: 'Back to the tabletop',
    };
    expect(rulesOf(ws, tabletopId)).toContain('subflowCycle');
    expect(rulesOf(ws, evidenceId)).toContain('subflowCycle');
  });

  it('flags a box pointing at an empty flow', () => {
    const ws = structuredClone(workspace);
    ws.flows[evidenceId]!.steps = {};
    ws.flows[evidenceId]!.edges = {};
    expect(rulesOf(ws, tabletopId)).toContain('subflowEmpty');
  });
});

describe('embedWouldCycle', () => {
  it('refuses a flow containing itself', () => {
    expect(embedWouldCycle(workspace, tabletopId, tabletopId)).toBe(true);
  });

  it('refuses nesting a host inside something it already contains', () => {
    // The tabletop already nests the evidence procedure, so nesting the tabletop inside the
    // evidence flow would close a loop.
    expect(embedWouldCycle(workspace, evidenceId, tabletopId)).toBe(true);
  });

  it('allows a legitimate nesting', () => {
    const ws = structuredClone(workspace);
    ws.flows['b_fresh'] = { ...ws.flows[evidenceId]!, id: 'b_fresh', steps: {}, edges: {}, groups: {} };
    expect(embedWouldCycle(ws, tabletopId, 'b_fresh')).toBe(false);
  });
});

describe('flowHealth', () => {
  it('scores the demo flow', () => {
    const health = flowHealth(workspace, tabletopId)!;
    expect(health.total).toBeGreaterThan(0);
    expect(health.percent).toBeGreaterThanOrEqual(0);
    expect(health.percent).toBeLessThanOrEqual(100);
  });

  it('improves when the flow inherits an owner', () => {
    const bare = flowHealth(workspace, tabletopId)!;
    const anchored = flowHealth(workspace, tabletopId, { anchorOwnerColumn: 'hq' })!;
    expect(anchored.passed).toBeGreaterThanOrEqual(bare.passed);
  });

  it('does not dock the host for a nested box holding no roles', () => {
    const flow = workspace.flows[tabletopId]!;
    const ordinary = Object.values(flow.steps).filter((s) => s.kind === 'step').length;
    const edges = Object.keys(flow.edges).length;
    // Two role checks per ordinary step, one per handoff. A subflow contributes neither.
    expect(flowHealth(workspace, tabletopId)!.total).toBe(ordinary * 2 + edges);
  });

  it('returns null for a flow that does not exist', () => {
    expect(flowHealth(workspace, 'b_nope')).toBeNull();
  });

  it('asks a Chart-Linked flow one more question per step: does it trace to a row?', () => {
    // index.html's flowHealth, which this one now follows: in Chart-Linked mode a step's owner and
    // doer come off the row it is bound to, and an unbound step is itself a failed check.
    const ws = structuredClone(workspace);
    const flow = ws.flows[tabletopId]!;
    const ordinary = Object.values(flow.steps).filter((s) => s.kind === 'step');
    const free = flowHealth(ws, tabletopId)!;
    flow.mode = 'linked';
    const linked = flowHealth(ws, tabletopId)!;
    expect(linked.total).toBe(free.total + ordinary.length);
    // No step is bound, so every step keeps its own letters and fails only the new check.
    expect(linked.passed).toBe(free.passed);

    const chartId = Object.keys(ws.charts)[0]!;
    const rowId = Object.keys(ws.charts[chartId]!.nodes)[0]!;
    for (const step of ordinary) step.bind = { chartId, nodeId: rowId };
    expect(flowHealth(ws, tabletopId)!.passed).toBeGreaterThan(linked.passed);
  });
});
