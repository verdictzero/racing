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
      ports: { in: [], out: [] },
    };
    // A step with no incoming edge is by definition an ENTRY point, so an isolated one counts as
    // reachable — which is why "disconnected" has to be its own rule rather than a case of
    // unreachability.
    expect(reachableSteps(flow).has('t_island')).toBe(true);
    expect(rulesOf(ws, tabletopId)).toContain('disconnected');
  });

  it('flags a step stranded inside a cycle as unreachable', () => {
    const ws = structuredClone(workspace);
    const flow = ws.flows[tabletopId]!;
    // Two steps that only point at each other: they have handoffs, so they are not disconnected,
    // but no path from any entry point reaches them.
    for (const [id, name] of [['t_x', 'Stranded A'], ['t_y', 'Stranded B']] as const) {
      flow.steps[id] = {
        id, flowId: flow.id, kind: 'step', refId: null, name,
        description: '', entry: '', exit: '', x: 0, y: 0, groupId: null,
        raci: { hq: 'A', cyber: 'R' }, parties: {}, bind: null, ports: { in: [], out: [] },
      };
    }
    flow.edges['e_xy'] = { id: 'e_xy', flowId: flow.id, from: 't_x', to: 't_y', fromPort: null, toPort: null, label: '', artifactIds: [], via: [] };
    flow.edges['e_yx'] = { id: 'e_yx', flowId: flow.id, from: 't_y', to: 't_x', fromPort: null, toPort: null, label: '', artifactIds: [], via: [] };

    expect(reachableSteps(flow).has('t_x')).toBe(false);
    expect(rulesOf(ws, tabletopId)).toContain('unreachable');
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

describe('flow rules', () => {
  it('flags a step nobody owns', () => {
    const ws = structuredClone(workspace);
    const flow = ws.flows[tabletopId]!;
    const step = Object.values(flow.steps).find((s) => s.kind === 'step')!;
    step.raci = { cyber: 'R' }; // a doer but no owner
    const found = flowViolations(ws, tabletopId).filter(
      (v) => v.stepId === step.id && v.rule === 'noOwner',
    );
    expect(found).toHaveLength(1);
  });

  it('does NOT flag an ownerless step when the flow inherits an owner from its anchor', () => {
    // The single most annoying false positive this engine could produce: an anchored flow's steps
    // have an owner, they just did not have to repeat it.
    const ws = structuredClone(workspace);
    const flow = ws.flows[tabletopId]!;
    const step = Object.values(flow.steps).find((s) => s.kind === 'step')!;
    step.raci = { cyber: 'R' };
    expect(rulesOf(ws, tabletopId, { anchorOwnerColumn: 'hq' })).not.toContain('noOwner');
  });

  it('flags two owners on one step', () => {
    const ws = structuredClone(workspace);
    const step = Object.values(ws.flows[tabletopId]!.steps).find((s) => s.kind === 'step')!;
    step.raci = { hq: 'A', cos: 'A', cyber: 'R' };
    const found = flowViolations(ws, tabletopId).find((v) => v.rule === 'multipleOwners')!;
    expect(found.severity).toBe('err');
  });

  it('flags a decision point whose branches carry no condition', () => {
    const ws = structuredClone(workspace);
    const flow = ws.flows[tabletopId]!;
    for (const edge of Object.values(flow.edges)) edge.label = '';
    expect(rulesOf(ws, tabletopId)).toContain('unlabelledBranch');
  });

  it('does not flag a labelled decision point — the demo labels both branches', () => {
    const detect = Object.values(workspace.flows[tabletopId]!.steps).find(
      (s) => s.name === 'Detect & Triage',
    )!;
    const found = flowViolations(workspace, tabletopId).filter(
      (v) => v.stepId === detect.id && v.rule === 'unlabelledBranch',
    );
    expect(found).toHaveLength(0);
  });

  it('flags a handoff that names no deliverable', () => {
    // "And then the work moves along" is exactly what the typed handoff exists to stop.
    expect(rulesOf(workspace, tabletopId)).toContain('handoffWithoutDeliverable');
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
    expect(rules).not.toContain('noOwner');
    expect(rules).not.toContain('noDoer');
  });

  it('flags a box whose flow is gone', () => {
    const ws = structuredClone(workspace);
    const sub = Object.values(ws.flows[tabletopId]!.steps).find((s) => s.kind === 'subflow')!;
    sub.refId = 'b_deleted';
    const found = flowViolations(ws, tabletopId).find((v) => v.rule === 'subflowMissing')!;
    expect(found.severity).toBe('err');
  });

  it('flags a nesting loop', () => {
    const ws = structuredClone(workspace);
    const sub = Object.values(ws.flows[tabletopId]!.steps).find((s) => s.kind === 'subflow')!;
    sub.refId = tabletopId; // the flow nests itself
    expect(rulesOf(ws, tabletopId)).toContain('subflowCycle');
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
});
