import { describe, it, expect } from 'vitest';
import demo from './__fixtures__/demo-workspace.json' with { type: 'json' };
import { importLegacy } from './legacy.js';
import {
  chartViolations,
  doerColumns,
  effectiveRaci,
  inheritedOwnerColumn,
  isOwnerOverride,
  needsPrimaryDoer,
  ownerColumns,
  primaryDoerColumn,
  violationsByNode,
} from './raci.js';
import { computeArtifactUses } from './registry.js';
import { workspaceViolations, anchorOwnerColumn } from './violations.js';
import { framework, COLS } from './constants.js';
import type { Chart, ChartNode } from './schema.js';
import { keysBetween } from './fractional.js';

const fw = framework('raci');

function chartOf(spec: Array<[id: string, parent: string | null, raci: Record<string, string>, primaryR?: string]>): Chart {
  const orders = keysBetween(null, null, spec.length);
  const nodes: Record<string, ChartNode> = {};
  spec.forEach(([id, parentId, raci, primaryR], i) => {
    nodes[id] = {
      id,
      chartId: 'c_t',
      parentId,
      order: orders[i]!,
      name: id,
      raci,
      primaryR: primaryR ?? null,
      org: null,
      description: '',
      documents: [],
      inputs: [],
      outputs: [],
    };
  });
  return {
    id: 'c_t',
    title: 'T',
    framework: 'raci',
    status: 'draft',
    finalizedAt: null,
    meta: { description: '', customer: '', priority: '', budget: '', tags: [] },
    custom: null,
    nodes,
  };
}

describe('doer / owner columns', () => {
  const chart = chartOf([['top', null, { hq: 'A', cyber: 'R', sw: 'RC' }]]);
  const node = chart.nodes.top!;

  it('finds every column holding the letter', () => {
    expect(doerColumns(node, COLS, fw)).toEqual(['cyber', 'sw']);
    expect(ownerColumns(node, COLS, fw)).toEqual(['hq']);
  });

  it('will not guess which of several doers carries down', () => {
    expect(primaryDoerColumn(node, COLS, fw)).toBeNull();
    expect(needsPrimaryDoer(node, COLS, fw)).toBe(true);
  });

  it('uses a designated primary once it is set', () => {
    const withPrimary = chartOf([['top', null, { hq: 'A', cyber: 'R', sw: 'RC' }, 'sw']]);
    expect(primaryDoerColumn(withPrimary.nodes.top!, COLS, fw)).toBe('sw');
    expect(needsPrimaryDoer(withPrimary.nodes.top!, COLS, fw)).toBe(false);
  });

  it('ignores a stale primary that is no longer a doer', () => {
    const stale = chartOf([['top', null, { hq: 'A', cyber: 'R', sw: 'C' }, 'sw']]);
    // One doer left, so that one wins regardless of the stale designation.
    expect(primaryDoerColumn(stale.nodes.top!, COLS, fw)).toBe('cyber');
  });

  it('returns null when nobody does the work', () => {
    const none = chartOf([['top', null, { hq: 'A' }]]);
    expect(primaryDoerColumn(none.nodes.top!, COLS, fw)).toBeNull();
  });
});

describe('the cascade', () => {
  it('makes the doer at one tier the owner at the next', () => {
    const chart = chartOf([
      ['top', null, { hq: 'A', cyber: 'R' }],
      ['kid', 'top', { sw: 'R' }],
    ]);
    const eff = effectiveRaci(chart, chart.nodes, 'kid');
    expect(eff.cyber!.letters).toBe('A');
    expect(eff.cyber!.source).toBe('inherited');
    expect(eff.cyber!.fromNodeId).toBe('top');
    expect(eff.sw!.letters).toBe('R');
    expect(eff.sw!.source).toBe('explicit');
  });

  it('passes through a tier that cannot say which doer carries down', () => {
    const chart = chartOf([
      ['top', null, { hq: 'A', cyber: 'R' }],
      ['mid', 'top', { sw: 'R', infra: 'R' }], // two doers, no primary
      ['leaf', 'mid', {}],
    ]);
    // mid is ambiguous, so leaf inherits from top rather than guessing between sw and infra.
    expect(inheritedOwnerColumn(chart.nodes, 'leaf', COLS, fw)).toEqual({
      column: 'cyber',
      fromNodeId: 'top',
    });
  });

  it('stops at a row that names its own owner', () => {
    const chart = chartOf([
      ['top', null, { hq: 'A', cyber: 'R' }],
      ['kid', 'top', { sw: 'A' }],
    ]);
    const eff = effectiveRaci(chart, chart.nodes, 'kid');
    expect(eff.sw!.letters).toBe('A');
    expect(eff.cyber!.letters).toBe(''); // no inherited A when the row named one
  });

  it('flags an owner that differs from the inherited one', () => {
    const override = chartOf([
      ['top', null, { hq: 'A', cyber: 'R' }],
      ['kid', 'top', { sw: 'A' }],
    ]);
    expect(isOwnerOverride(override, override.nodes, 'kid')).toBe(true);

    const agrees = chartOf([
      ['top', null, { hq: 'A', cyber: 'R' }],
      ['kid', 'top', { cyber: 'A' }],
    ]);
    expect(isOwnerOverride(agrees, agrees.nodes, 'kid')).toBe(false);
  });

  it('merges an inherited owner into a column the row already wrote in', () => {
    const chart = chartOf([
      ['top', null, { hq: 'A', cyber: 'R' }],
      ['kid', 'top', { cyber: 'C' }],
    ]);
    const eff = effectiveRaci(chart, chart.nodes, 'kid');
    expect(eff.cyber!.letters).toBe('AC'); // canonical order, not 'CA'
    expect(eff.cyber!.source).toBe('explicit');
  });

  it('inherits nothing at the top of the chart', () => {
    const chart = chartOf([['top', null, { cyber: 'R' }]]);
    expect(inheritedOwnerColumn(chart.nodes, 'top', COLS, fw)).toBeNull();
  });
});

describe('chartViolations', () => {
  it('reports two accountable parties as an error', () => {
    const chart = chartOf([['top', null, { hq: 'A', cos: 'A', cyber: 'R' }]]);
    const rules = chartViolations(chart).map((v) => v.rule);
    expect(rules).toContain('multipleOwners');
    expect(chartViolations(chart).find((v) => v.rule === 'multipleOwners')!.severity).toBe('err');
  });

  it('reports a row nobody owns', () => {
    const chart = chartOf([['top', null, { cyber: 'R' }]]);
    expect(chartViolations(chart).map((v) => v.rule)).toContain('noOwner');
  });

  it('does not report a row that inherits an owner', () => {
    const chart = chartOf([
      ['top', null, { hq: 'A', cyber: 'R' }],
      ['kid', 'top', { sw: 'R' }],
    ]);
    const kidRules = chartViolations(chart)
      .filter((v) => v.nodeId === 'kid')
      .map((v) => v.rule);
    expect(kidRules).not.toContain('noOwner');
  });

  it('warns when nobody does the work', () => {
    const chart = chartOf([['top', null, { hq: 'A' }]]);
    const v = chartViolations(chart).find((x) => x.rule === 'noDoer')!;
    expect(v.severity).toBe('warn');
  });

  it('warns about an undesignated primary doer', () => {
    const chart = chartOf([['top', null, { hq: 'A', cyber: 'R', sw: 'R' }]]);
    expect(chartViolations(chart).map((v) => v.rule)).toContain('noPrimaryDoer');
  });

  it('is deterministic — same chart, same list, in the same order', () => {
    const chart = chartOf([
      ['b', null, { cyber: 'R' }],
      ['a', null, { hq: 'A', cos: 'A' }],
    ]);
    expect(chartViolations(chart)).toEqual(chartViolations(chart));
  });

  it('groups by node for the row pins', () => {
    const chart = chartOf([['top', null, { hq: 'A', cos: 'A' }]]);
    const map = violationsByNode(chartViolations(chart));
    expect(map.get('top')!.length).toBeGreaterThan(0);
  });
});

describe('against the real demo chart', () => {
  const { workspace } = importLegacy(demo);
  const chart = Object.values(workspace.charts)[0]!;

  it('resolves every row without throwing', () => {
    for (const id of Object.keys(chart.nodes)) {
      const eff = effectiveRaci(chart, chart.nodes, id);
      expect(Object.keys(eff)).toEqual([...COLS]);
    }
  });

  it('produces the advisory list the legacy app shows in its corner', () => {
    const violations = chartViolations(chart);
    // The demo ships with warnings on purpose — it is a teaching dataset, and the count in the
    // corner is a reading list. What matters is that the engine runs over 810 rows and every
    // finding names a row that exists.
    expect(violations.length).toBeGreaterThan(0);
    for (const v of violations) expect(chart.nodes[v.nodeId]).toBeDefined();
  });

  it('inherits an owner for the great majority of rows, which is what the cascade is for', () => {
    const withoutOwner = chartViolations(chart).filter((v) => v.rule === 'noOwner');
    expect(withoutOwner.length).toBeLessThan(Object.keys(chart.nodes).length / 2);
  });
});

describe('the supply check — a declared input nothing produces', () => {
  const base = importLegacy(demo).workspace;
  const chartId = Object.keys(base.charts)[0]!;
  const rowId = Object.keys(base.charts[chartId]!.nodes)[0]!;

  /** Give one row one input, and return the rules that fire on that row. */
  const withInput = (mutate: (ws: typeof base) => string) => {
    const ws = structuredClone(base);
    const artifactId = mutate(ws);
    ws.charts[chartId]!.nodes[rowId]!.inputs = [artifactId];
    const found = chartViolations(ws.charts[chartId]!, {
      artifactUses: computeArtifactUses(ws),
      artifacts: ws.artifacts,
    });
    return found.filter((v) => v.nodeId === rowId).map((v) => v.rule);
  };

  const addGhost = (ws: typeof base) => {
    ws.artifacts['a_ghost'] = {
      id: 'a_ghost', name: 'Ghost Report', type: 'document',
      ownerRef: null, description: '', doc: null,
    };
    return 'a_ghost';
  };

  it('flags an input that nothing anywhere declares as an output or hands over', () => {
    expect(withInput(addGhost)).toContain('inputWithoutProducer');
  });

  it('names the deliverable, so the message is actionable without hunting', () => {
    const ws = structuredClone(base);
    addGhost(ws);
    ws.charts[chartId]!.nodes[rowId]!.inputs = ['a_ghost'];
    const found = chartViolations(ws.charts[chartId]!, {
      artifactUses: computeArtifactUses(ws),
      artifacts: ws.artifacts,
    });
    const v = found.find((x) => x.rule === 'inputWithoutProducer')!;
    expect(v.message).toContain('"Ghost Report"');
    expect(v.severity).toBe('warn');
  });

  it('is satisfied by a producer in another chart', () => {
    const rules = withInput((ws) => {
      addGhost(ws);
      const other = Object.values(ws.charts).find((c) => c.id !== chartId);
      const host = other ?? ws.charts[chartId]!;
      const supplier = Object.keys(host.nodes).find((id) => id !== rowId)!;
      host.nodes[supplier]!.outputs = ['a_ghost'];
      return 'a_ghost';
    });
    expect(rules).not.toContain('inputWithoutProducer');
  });

  it('is satisfied by a flow handoff, not just by a chart row', () => {
    // The supply chain crosses documents: a deliverable produced by a step in a business case
    // legitimately feeds a chart row, and a check that only looked at charts would warn about it.
    const rules = withInput((ws) => {
      addGhost(ws);
      const flow = Object.values(ws.flows)[0]!;
      Object.values(flow.edges)[0]!.artifactIds = ['a_ghost'];
      return 'a_ghost';
    });
    expect(rules).not.toContain('inputWithoutProducer');
  });

  it('does not let a row supply itself', () => {
    // "Takes the register, returns the register" is a row restating what it works on. Counting it
    // as a supply would silence the rule exactly where a broken chain is easiest to create.
    const ws = structuredClone(base);
    addGhost(ws);
    const node = ws.charts[chartId]!.nodes[rowId]!;
    node.inputs = ['a_ghost'];
    node.outputs = ['a_ghost'];
    const found = chartViolations(ws.charts[chartId]!, {
      artifactUses: computeArtifactUses(ws),
      artifacts: ws.artifacts,
    });
    expect(found.map((v) => v.rule)).toContain('inputWithoutProducer');
  });

  it('ignores an input pointing at a deliverable that no longer exists', () => {
    // A dangling id is a different fault, and reporting it as a broken supply chain would send
    // someone looking for a producer that was never the problem.
    const ws = structuredClone(base);
    ws.charts[chartId]!.nodes[rowId]!.inputs = ['a_deleted'];
    const found = chartViolations(ws.charts[chartId]!, {
      artifactUses: computeArtifactUses(ws),
      artifacts: ws.artifacts,
    });
    expect(found.map((v) => v.rule)).not.toContain('inputWithoutProducer');
  });

  it('does not run at all when the caller cannot supply the index', () => {
    // Silence is the honest answer for a chart linted on its own — the producer may be in a
    // document this call cannot see, and warning would be a guess.
    const ws = structuredClone(base);
    addGhost(ws);
    ws.charts[chartId]!.nodes[rowId]!.inputs = ['a_ghost'];
    const found = chartViolations(ws.charts[chartId]!);
    expect(found.map((v) => v.rule)).not.toContain('inputWithoutProducer');
  });
});

describe('linting the whole workspace', () => {
  const base = importLegacy(demo).workspace;

  it('runs the supply check without the caller having to remember the index', () => {
    const ws = structuredClone(base);
    ws.artifacts['a_ghost'] = {
      id: 'a_ghost', name: 'Ghost Report', type: 'document',
      ownerRef: null, description: '', doc: null,
    };
    const chartId = Object.keys(ws.charts)[0]!;
    const rowId = Object.keys(ws.charts[chartId]!.nodes)[0]!;
    ws.charts[chartId]!.nodes[rowId]!.inputs = ['a_ghost'];

    const report = workspaceViolations(ws);
    expect(report.charts.get(chartId)!.map((v) => v.rule)).toContain('inputWithoutProducer');
  });

  it('covers charts and flows in one flat list, with the counts adding up', () => {
    const report = workspaceViolations(base);
    const fromMaps =
      [...report.charts.values()].reduce((n, v) => n + v.length, 0) +
      [...report.flows.values()].reduce((n, v) => n + v.length, 0);
    expect(report.all).toHaveLength(fromMaps);
    expect(report.errors + report.warnings).toBe(report.all.length);
  });

  it('passes an anchored flow the owner its chart row cascades down', () => {
    // The single most annoying false positive this engine can produce is nagging every step of an
    // anchored flow for an owner it already has. The wrapper exists to make that unforgettable.
    const ws = structuredClone(base);
    const chartId = Object.keys(ws.charts)[0]!;
    const chart = ws.charts[chartId]!;
    const owned = Object.keys(chart.nodes).find((id) => {
      const eff = effectiveRaci(chart, chart.nodes, id);
      return COLS.some((c) => (eff[c]?.letters ?? '').includes(fw.owner));
    })!;
    const flowId = Object.keys(ws.flows)[0]!;
    ws.flows[flowId]!.anchor = { chartId, nodeId: owned };

    expect(anchorOwnerColumn(ws, ws.flows[flowId]!)).not.toBeNull();
    const rules = (workspaceViolations(ws).flows.get(flowId) ?? []).map((v) => v.rule);
    expect(rules).not.toContain('noOwner');
  });

  it('still reports an unanchored flow’s ownerless steps', () => {
    const ws = structuredClone(base);
    const flowId = Object.keys(ws.flows)[0]!;
    ws.flows[flowId]!.anchor = null;
    for (const step of Object.values(ws.flows[flowId]!.steps)) step.raci = {};
    const rules = (workspaceViolations(ws).flows.get(flowId) ?? []).map((v) => v.rule);
    expect(rules).toContain('noOwner');
  });
});
