import { describe, it, expect } from 'vitest';
import demo from './__fixtures__/demo-workspace.json' with { type: 'json' };
import { importLegacy } from './legacy.js';
import { collectWork, summarizeWork, workScopeLabel } from './work.js';
import { orgScopes } from './org.js';
import { rootsOf, walkInOrder } from './tree.js';
import { COLS } from './constants.js';
import type { Workspace } from './schema.js';

const { workspace } = importLegacy(demo);
const division = workspace.roster.cyber!.divisions[0]!;
const branch = division.branches[0]!;

const DIRECTORATE = { actor: 'cyber' } as const;
const DIVISION = { actor: 'cyber', divisionId: division.id } as const;
const BRANCH = { actor: 'cyber', divisionId: division.id, branchId: branch.id } as const;

describe('collecting a unit’s work from the charts', () => {
  it('finds the rows assigned to the unit or to something inside it', () => {
    const items = collectWork(workspace, DIVISION);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.relation === 'direct')).toBe(true);
    // The demo assigns at division and branch level only, so a division scope picks up both.
    expect(items.some((i) => i.unit === branch.name)).toBe(true);
  });

  it('narrows as the scope narrows', () => {
    const wide = collectWork(workspace, DIRECTORATE).length;
    const mid = collectWork(workspace, DIVISION).length;
    const narrow = collectWork(workspace, BRANCH).length;
    expect(wide).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(narrow);
    expect(narrow).toBeGreaterThan(0);
  });

  it('separates work handed DOWN from work handed TO you', () => {
    // Assigned to the whole directorate with nothing more specific named, it lands on every
    // division underneath — which is a different fact from "someone chose us", and a list that
    // merged the two would be read as the second and be wrong.
    const ws = structuredClone(workspace) as Workspace;
    const chart = Object.values(ws.charts)[0]!;
    const root = rootsOf(chart.nodes)[0]!;
    root.org = DIRECTORATE;

    const items = collectWork(ws, DIVISION);
    const inherited = items.filter((i) => i.relation === 'inherited');
    expect(inherited.length).toBeGreaterThan(0);
    expect(items.filter((i) => i.relation === 'direct').length).toBeGreaterThan(0);
  });

  it('keeps document order — the screen splits the groups, the list reads like the chart', () => {
    // index.html walks the tree and appends as it goes; the Tasks screen then files each item under
    // "Assigned to your unit" or "From your org". Sorting here would reorder both groups.
    const ws = structuredClone(workspace) as Workspace;
    const chart = Object.values(ws.charts)[0]!;
    const root = rootsOf(chart.nodes)[0]!;
    root.org = DIRECTORATE;
    const items = collectWork(ws, DIVISION);
    expect(items[0]!.nodeId).toBe(root.id);
    expect(items[0]!.relation).toBe('inherited');
    const order = walkInOrder(chart.nodes).map((n) => n.id);
    const at = items.map((i) => order.indexOf(i.nodeId!));
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('says where each row sits, in the words the chart uses', () => {
    const item = collectWork(workspace, DIVISION).find((i) => i.kind === 'chartRow')!;
    expect(item.where).toMatch(/^(Portfolio|Program|Project|Task) · /);
    expect(item.where).toContain('ASIC RACI Tool Demo');
  });

  it('prints the letters a row states, in column order', () => {
    // The work card shows what the row SAYS; the cascaded owner is the chart's to draw (dashed), not
    // the card's — index.html's card has no inherited chip on a chart row.
    const items = collectWork(workspace, DIVISION);
    const chart = Object.values(workspace.charts)[0]!;
    const withRoles = items.filter((i) => i.roles.length > 0);
    expect(withRoles.length).toBeGreaterThan(0);
    for (const item of withRoles) {
      const node = chart.nodes[item.nodeId!]!;
      expect(item.roles.map((r) => r.column)).toEqual(COLS.filter((k) => node.raci[k]));
      for (const role of item.roles) {
        expect(role.letters).toBe(node.raci[role.column]);
        expect(role.inherited).toBe(false);
      }
    }
  });

  it('lists organization charts only, in tab order', () => {
    const ws = structuredClone(workspace) as Workspace;
    const org = Object.values(ws.charts)[0]!;
    // A free-form chart's columns are its own, so its rows say nothing about the org's units.
    ws.charts['c_free'] = {
      ...org, id: 'c_free', title: 'Free', custom: { cols: [{ key: 'p1', label: 'P', short: 'P' }], tiers: [] },
      nodes: { nf: { ...Object.values(org.nodes)[0]!, id: 'nf', chartId: 'c_free', parentId: null, org: DIRECTORATE } },
    };
    ws.chartOrder['c_free'] = '0'; // in front of the org chart
    const items = collectWork(ws, DIRECTORATE);
    expect(items.some((i) => i.chartId === 'c_free')).toBe(false);

    // A second org chart placed first in the strip is listed first.
    ws.charts['c_first'] = { ...org, id: 'c_first', title: 'First', custom: null,
      nodes: { nx: { ...Object.values(org.nodes)[0]!, id: 'nx', chartId: 'c_first', parentId: null, org: DIRECTORATE } } };
    ws.chartOrder['c_first'] = '1';
    expect(collectWork(ws, DIRECTORATE)[0]!.chartId).toBe('c_first');
  });

  /** Two rows the given scope actually owns. The demo spreads assignments across directorates. */
  const twoRowsIn = (ws: Workspace, scope: typeof DIRECTORATE) => {
    const chart = Object.values(ws.charts)[0]!;
    const mine = collectWork(ws, scope).filter((i) => i.kind === 'chartRow');
    return [chart.nodes[mine[0]!.nodeId!]!, chart.nodes[mine[1]!.nodeId!]!] as const;
  };

  it('names who supplies an input and who takes an output', () => {
    const ws = structuredClone(workspace) as Workspace;
    const [consumer, producer] = twoRowsIn(ws, DIRECTORATE);
    const artifact = Object.values(ws.artifacts)[0]!;
    consumer.inputs = [artifact.id];
    producer.outputs = [artifact.id];

    const item = collectWork(ws, DIRECTORATE).find((i) => i.nodeId === consumer.id)!;
    const input = item.inputs.find((io) => io.artifactId === artifact.id)!;
    expect(input.name).toBe(artifact.name);
    expect(input.counterparts).toContain(producer.name);
  });

  it('does not list a row as its own supplier', () => {
    // "Takes the register, returns the register" is a row restating what it works on. Printing
    // itself as the source is noise at best and misleading at worst.
    const ws = structuredClone(workspace) as Workspace;
    const [node] = twoRowsIn(ws, DIRECTORATE);
    const artifact = Object.values(ws.artifacts)[0]!;
    node.inputs = [artifact.id];
    node.outputs = [artifact.id];

    const item = collectWork(ws, DIRECTORATE).find((i) => i.nodeId === node.id)!;
    expect(item.inputs[0]!.counterparts).not.toContain(node.name);
  });

  it('returns nothing for no scope, and nothing for a unit that owns nothing', () => {
    expect(collectWork(workspace, null)).toEqual([]);
    expect(collectWork(workspace, { actor: 'cyber', divisionId: 'div_nope' })).toEqual([]);
  });
});

describe('collecting a unit’s work from the flows', () => {
  /** The demo's flows carry no parties, so the flow half needs a wired-up fixture. */
  const wired = () => {
    const ws = structuredClone(workspace) as Workspace;
    const flow = Object.values(ws.flows)[0]!;
    const step = Object.values(flow.steps).find((s) => s.kind === 'step')!;
    step.raci = { cyber: 'A', sw: 'R' };
    step.parties = { cyber: BRANCH };
    return { ws, flow, step };
  };

  it('finds a step by the party named on one of its columns', () => {
    const { ws, step } = wired();
    const items = collectWork(ws, BRANCH).filter((i) => i.kind === 'flowStep');
    expect(items.map((i) => i.stepId)).toContain(step.id);
    const found = items.find((i) => i.stepId === step.id)!;
    expect(found.relation).toBe('direct');
    // Only the column whose party is in scope. The other belongs to someone else and listing it
    // would tell this unit it holds a responsibility it does not.
    expect(found.roles.map((r) => r.column)).toEqual(['cyber']);
  });

  it('carries the step’s entry and exit criteria, which is why a run book is readable', () => {
    const { ws, step } = wired();
    step.entry = 'A ticket exists';
    step.exit = 'The ticket is closed';
    const found = collectWork(ws, BRANCH).find((i) => i.stepId === step.id)!;
    expect(found.entry).toBe('A ticket exists');
    expect(found.exit).toBe('The ticket is closed');
  });

  it('falls back to the anchor row’s org for a column that names nobody', () => {
    // An anchored flow's steps belong to whoever owns the row the flow hangs under. Requiring
    // every column of every step to restate it would make an anchored flow look unassigned.
    const ws = structuredClone(workspace) as Workspace;
    const chart = Object.values(ws.charts)[0]!;
    const anchorNode = Object.values(chart.nodes).find((n) => n.org)!;
    anchorNode.org = BRANCH;
    const flow = Object.values(ws.flows)[0]!;
    flow.anchor = { chartId: chart.id, nodeId: anchorNode.id };
    const step = Object.values(flow.steps).find((s) => s.kind === 'step')!;
    step.raci = { cyber: 'A' };
    step.parties = {};

    const found = collectWork(ws, BRANCH).find((i) => i.stepId === step.id)!;
    expect(found).toBeDefined();
    expect(found.roles[0]!.inherited).toBe(true);
    expect(found.where).toContain('⚓');
  });

  it('defaults only a column mapped to a directorate, narrowed by the anchor inside it', () => {
    // index.html's bizDefaultPartyFor: the column's directorate, deepened by the deepest org ref
    // above the anchor that sits in that same directorate. An unmapped column (HQ) has no default.
    const ws = structuredClone(workspace) as Workspace;
    const chart = Object.values(ws.charts)[0]!;
    const anchorNode = Object.values(chart.nodes).find((n) => n.parentId && n.org)!;
    anchorNode.org = BRANCH;
    const flow = Object.values(ws.flows)[0]!;
    flow.anchor = { chartId: chart.id, nodeId: anchorNode.id };
    const step = Object.values(flow.steps).find((s) => s.kind === 'step')!;
    step.raci = { hq: 'R', cyber: 'A' };
    step.parties = {};

    const found = collectWork(ws, DIRECTORATE).find((i) => i.stepId === step.id)!;
    expect(found.roles.map((r) => r.column)).toEqual(['cyber']);
    expect(found.roles[0]!.unit).toBe(branch.name);
    expect(found.where).toBe(`Flow step · ${flow.name} ⚓ ${chart.title} › … › ${anchorNode.name}`);
  });

  it('names the far end of a handoff the way the card prints it — quoted, with its units', () => {
    const { ws, flow, step } = wired();
    const edge = Object.values(flow.edges).find((e) => e.from !== step.id && e.artifactIds.length)!;
    edge.to = step.id;
    const source = flow.steps[edge.from]!;
    source.parties = { sw: { actor: 'sw' }, cyber: DIVISION };
    const found = collectWork(ws, BRANCH).find((i) => i.stepId === step.id)!;
    const input = found.inputs.find((io) => io.artifactId === edge.artifactIds[0])!;
    expect(input.counterparts).toEqual([`"${source.name}" (DIRECTORATE E, ${division.name})`]);
  });

  it('reads a Chart-Linked step’s letters off the row it is bound to', () => {
    const ws = structuredClone(workspace) as Workspace;
    const chart = Object.values(ws.charts)[0]!;
    // A row that states its own owner (so nothing cascades onto it) and holds a cyber letter.
    const row = Object.values(chart.nodes).find(
      (n) => n.org && 'branchId' in n.org && n.org.actor === 'cyber' && n.raci.cyber &&
        Object.values(n.raci).some((v) => v.includes('A')),
    )!;
    const flow = Object.values(ws.flows)[0]!;
    flow.mode = 'linked';
    const step = Object.values(flow.steps).find((s) => s.kind === 'step')!;
    step.bind = { chartId: chart.id, nodeId: row.id };
    step.raci = {}; // says nothing itself — the row speaks for it
    step.parties = {};

    const found = collectWork(ws, row.org!).find((i) => i.stepId === step.id)!;
    expect(found).toBeDefined();
    expect(found.where).toBe(`Flow step · ${flow.name} ⛓ Project: ${row.name}`);
    expect(found.roles.find((r) => r.column === 'cyber')?.letters).toBe(row.raci.cyber);
  });

  it('reads a step’s deliverables off its handoffs', () => {
    const { ws, flow, step } = wired();
    const outgoing = Object.values(flow.edges).filter((e) => e.from === step.id);
    const found = collectWork(ws, BRANCH).find((i) => i.stepId === step.id)!;
    const expected = outgoing.flatMap((e) => e.artifactIds).length;
    expect(found.outputs).toHaveLength(expected);
    for (const io of found.outputs) expect(io.name).not.toBe('(missing deliverable)');
  });

  it('skips a nested-flow box — its roles live in the flow it references', () => {
    // Counting it here would report the same work twice: once for the box and once for every
    // step of the flow behind it.
    const ws = structuredClone(workspace) as Workspace;
    const flow = Object.values(ws.flows).find((f) =>
      Object.values(f.steps).some((s) => s.kind === 'subflow'),
    )!;
    const box = Object.values(flow.steps).find((s) => s.kind === 'subflow')!;
    box.raci = { cyber: 'A' };
    box.parties = { cyber: BRANCH };
    expect(collectWork(ws, BRANCH).map((i) => i.stepId)).not.toContain(box.id);
  });

  it('ignores a step whose parties are all somewhere else', () => {
    const { ws } = wired();
    expect(collectWork(ws, { actor: 'sw' }).filter((i) => i.kind === 'flowStep')).toEqual([]);
  });
});

describe('the run book summary', () => {
  it('counts an item once per letter, however many columns carry it', () => {
    // Holding A in two columns of one row is still one thing you are accountable for. Counting
    // cells rather than items is how a run book ends up claiming 300 accountabilities.
    const summary = summarizeWork([
      {
        kind: 'chartRow', relation: 'direct', name: 'x', where: '', unit: '',
        roles: [
          { column: 'a', letters: 'A', inherited: false, unit: '' },
          { column: 'b', letters: 'AR', inherited: false, unit: '' },
        ],
        description: '', entry: '', exit: '', inputs: [], outputs: [],
      },
    ]);
    expect(summary.byLetter).toEqual({ A: 1, R: 1 });
    expect(summary.total).toBe(1);
  });

  it('splits the totals the way the screen groups them', () => {
    const ws = structuredClone(workspace) as Workspace;
    rootsOf(Object.values(ws.charts)[0]!.nodes)[0]!.org = DIRECTORATE;
    const items = collectWork(ws, DIVISION);
    const summary = summarizeWork(items);
    expect(summary.direct + summary.inherited).toBe(summary.total);
    expect(summary.total).toBe(items.length);
  });

  it('is empty for a unit with nothing', () => {
    expect(summarizeWork([])).toEqual({ total: 0, direct: 0, inherited: 0, byLetter: {} });
  });
});

describe('the scope line the screen prints', () => {
  it('names a directorate by its label, and a unit by its path and chief', () => {
    expect(workScopeLabel(workspace, DIRECTORATE)).toEqual({ short: 'DIRECTORATE D', full: 'DIRECTORATE D' });
    const label = workScopeLabel(workspace, BRANCH)!;
    expect(label.short).toBe(branch.name);
    expect(label.full).toBe(
      `DIRECTORATE D › ${division.name} › ${branch.name}${branch.chief?.name ? ` · Chief: ${branch.chief.name}` : ''}`,
    );
    const team = branch.teams[0]!;
    const teamLabel = workScopeLabel(workspace, { ...BRANCH, teamId: team.id })!;
    expect(teamLabel.full.endsWith(`› ${team.name}${team.chief?.name ? ` · Lead: ${team.chief.name}` : ''}`)).toBe(true);
  });

  it('has nothing to say about a unit that no longer exists', () => {
    expect(workScopeLabel(workspace, { actor: 'cyber', divisionId: 'gone' })).toBeNull();
    expect(workScopeLabel(workspace, null)).toBeNull();
  });
});

describe('against every scope the picker offers', () => {
  it('never throws, and never reports work for a scope that has none', () => {
    for (const scope of orgScopes(workspace)) {
      const items = collectWork(workspace, scope.ref);
      for (const item of items) expect(item.relation === 'direct' || item.relation === 'inherited').toBe(true);
    }
  });
});
