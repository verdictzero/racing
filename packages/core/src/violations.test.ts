import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import demo from './__fixtures__/demo-workspace.json' with { type: 'json' };
import { importLegacy } from './legacy.js';
import { resolveActiveChart, resolveActiveFlow } from './lint-context.js';
import type { ViolationRecord } from './raci.js';
import {
  flowsToLint,
  isFlowView,
  violationCounts,
  violationIndex,
  violationPillText,
  violationRecords,
  viewViolations,
} from './violations.js';

/**
 * PARITY WITH index.html.
 *
 * The expected side of every assertion in the first block is index.html's own output: its
 * `_violations` and the text of its warnings pill, read out of the real file running in headless
 * Chromium by scripts/capture-legacy-violations.mjs. Nothing in legacy-violations.json was written
 * by hand, and nothing in it should be — re-run the script instead.
 *
 * Two workspaces are captured: the shipped demo, and a small one built so that every rule fires and
 * every message variant is printed (the demo on its own raises five of them). Each is captured in
 * several views, with several charts and flows in front, because WHICH flows are linted — and even
 * what an anchored flow inherits — depends on the screen.
 */

interface LegacyIssue {
  readonly rule: string;
  readonly severity: 'err' | 'warn';
  readonly message: string;
}
interface LegacyRecord {
  readonly kind: 'chart' | 'flow';
  readonly nodeId?: string;
  readonly tier?: number;
  readonly flowId?: string;
  readonly stepId?: string;
  readonly name: string;
  readonly tierLabel: string;
  readonly ancestors: ReadonlyArray<{ readonly id: string | null; readonly name: string }>;
  readonly severity: 'err' | 'warn';
  readonly issues: readonly LegacyIssue[];
}
interface LegacyCapture {
  readonly requested: { readonly chartId: string; readonly flowId: string };
  readonly view: string;
  readonly activeChartId: string;
  readonly activeFlowId: string;
  readonly pill: string;
  readonly onlyWarn: boolean;
  readonly records: readonly string[];
}
interface LegacyFixture {
  readonly source: { readonly appVersion: string; readonly functions: Record<string, string> };
  readonly scenarios: ReadonlyArray<{
    readonly name: string;
    /** The legacy workspace itself, or the name of a fixture file holding it. */
    readonly input: unknown;
    readonly captures: readonly LegacyCapture[];
  }>;
  readonly records: Readonly<Record<string, LegacyRecord>>;
}

const fixture = JSON.parse(
  readFileSync(new URL('./__fixtures__/legacy-violations.json', import.meta.url), 'utf8'),
) as LegacyFixture;

const inputOf = (input: unknown): unknown => (input === 'demo-workspace.json' ? demo : input);

/** A record in the shape the legacy app writes it, which has no chart id on a chart row. */
function asLegacy(r: ViolationRecord): LegacyRecord {
  const common = {
    name: r.name,
    tierLabel: r.tierLabel,
    ancestors: r.ancestors,
    severity: r.severity,
    issues: r.issues,
  };
  return r.kind === 'chart'
    ? { kind: 'chart', nodeId: r.nodeId, tier: r.tier, ...common }
    : { kind: 'flow', flowId: r.flowId, stepId: r.stepId, ...common };
}

const where = (r: { kind: string; nodeId?: string; flowId?: string; stepId?: string }) =>
  r.kind === 'chart' ? `chart row ${r.nodeId}` : `flow ${r.flowId} step ${r.stepId}`;

describe('parity with index.html', () => {
  // Keep identical to RULE_FUNCTIONS in scripts/capture-legacy-violations.mjs.
  const LEGACY_RULE_FUNCTIONS = [
    'recomputeViolations', 'lintFlow', 'renderViolationsUI',
    'fw', 'chartFw', 'normalizeRaci', 'rColumns', 'primaryRColumn', 'cascadeDown',
    'inheritedOwnerColIn', 'chartCols', 'chartColDef', 'chartColLabel', 'chartTierLabel',
    'normalizeChartCustom', 'normalizeNodes', 'normalizeOrgRef', 'ac', 'abc',
    'artStatus', 'isFinal', 'artifactById', 'artifactLabel', 'computeArtifactUses',
    'isSubflow', 'bizCaseById', 'bizCaseName', 'bizTaskLabel', 'bizExitPoints', 'subflowPorts',
    'subflowOpenPorts', 'bizEmbedWouldCycle', 'chartById', 'nodeInChart', 'resolveAnchor',
    'bizAnchorCtx', 'columnActorKey', 'bizDefaultPartyFor', 'bizIsLinked', 'bizBindCtx',
    'translateLetters', 'bizStepRaci', 'bizDefaultPartyForTask',
  ];

  /** Same extraction as the capture script: the opening line to the first `}` at column 0. */
  function functionText(lines: readonly string[], name: string): string {
    const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
    if (start < 0) throw new Error(`function ${name} not found in index.html`);
    const first = lines[start]!;
    const opens = (first.match(/{/g) ?? []).length;
    const closes = (first.match(/}/g) ?? []).length;
    if (opens > 0 && opens === closes) return first;
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return lines.slice(start, end + 1).join('\n');
  }

  it('was captured from the rule functions index.html has today', () => {
    // The drift guard. The rest of this block compares against a snapshot of index.html's output;
    // if the functions that produce that output have changed since, the snapshot is stale and a
    // green run would be a lie. Re-run scripts/capture-legacy-violations.mjs, then make the port
    // agree with whatever the source now says.
    const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
    const lines = html.replace(/\r/g, '').split('\n');
    const changed = LEGACY_RULE_FUNCTIONS.filter(
      (name) =>
        createHash('sha256').update(functionText(lines, name)).digest('hex') !==
        fixture.source.functions[name],
    );
    expect(changed, 'changed in index.html since legacy-violations.json was captured').toEqual([]);
    expect(Object.keys(fixture.source.functions).sort()).toEqual([...LEGACY_RULE_FUNCTIONS].sort());
  });

  for (const scenario of fixture.scenarios) {
    describe(`the ${scenario.name} workspace`, () => {
      const { workspace } = importLegacy(inputOf(scenario.input));

      for (const capture of scenario.captures) {
        const { chartId, flowId } = capture.requested;
        const title = `${capture.view} view, ${chartId} in front, ${flowId} open → "${capture.pill}"`;

        it(title, () => {
          const records = viewViolations(workspace, { view: capture.view, chartId, flowId });
          const expected = capture.records.map((key) => fixture.records[key]!);

          // Which records, in which order — reported as a list of places first, so a mismatch
          // reads as "this row is missing" rather than as a 400-entry object diff.
          expect(records.map(where)).toEqual(expected.map(where));
          // …and then every field of every record: name, tier label, crumb, severity, and each
          // issue's rule id, severity and message, character for character.
          expect(records.map(asLegacy)).toEqual(expected);

          expect(violationPillText(records)).toBe(capture.pill);
          const { errors } = violationCounts(records);
          expect(records.length > 0 && errors === 0).toBe(capture.onlyWarn);
          // A stale id resolves where the legacy app resolves it.
          expect(resolveActiveChart(workspace, chartId)?.id).toBe(capture.activeChartId);
          expect(resolveActiveFlow(workspace, flowId)?.id).toBe(capture.activeFlowId);
        });
      }
    });
  }
});

describe('the demo, in the numbers index.html shows', () => {
  // The same facts as the parity block, stated as the numbers a person sees in the corner. Kept
  // because "the pill said 1068 and index.html says 410" is how this port started.
  const { workspace } = importLegacy(demo);
  const chartId = Object.keys(workspace.charts)[0]!;
  const tabletop = Object.values(workspace.flows).find((f) => /Tabletop/.test(f.name))!;
  const evidence = Object.values(workspace.flows).find((f) => /Evidence/.test(f.name))!;
  const tally = (records: ViolationRecord[]) => {
    const out: Record<string, number> = {};
    for (const r of records) for (const i of r.issues) out[i.rule] = (out[i.rule] ?? 0) + 1;
    return out;
  };

  it('says "410 warnings" in the chart view', () => {
    const records = viewViolations(workspace, { view: 'chart', chartId });
    expect(violationPillText(records)).toBe('410 warnings');
    expect(tally(records)).toEqual({ ambiguousPrimaryR: 400, overConsulted: 10 });
    expect(records.every((r) => r.kind === 'chart')).toBe(true);
  });

  it('says the same in the other non-flow views, which lint the same things', () => {
    for (const view of ['roster', 'work', 'objects'] as const) {
      expect(violationPillText(viewViolations(workspace, { view, chartId }))).toBe('410 warnings');
    }
  });

  it('says "416 warnings" in the flow view with the tabletop open', () => {
    const records = viewViolations(workspace, { view: 'bizcase', chartId, flowId: tabletop.id });
    expect(violationPillText(records)).toBe('416 warnings');
    const steps = records.filter((r) => r.kind === 'flow');
    // Every ordinary step lacks an executing party: the flow has no anchor to default one from.
    expect(steps).toHaveLength(6);
    expect(tally(steps)).toEqual({
      flowPartyMissing: 6,
      decisionUnlabeled: 1,
      handoffWithoutArtifact: 1,
    });
  });

  it('says "415 warnings" with the evidence procedure open', () => {
    const records = viewViolations(workspace, { view: 'flow', chartId, flowId: evidence.id });
    expect(violationPillText(records)).toBe('415 warnings');
  });

  it('counts rows, not issues — a row breaking two rules is one record', () => {
    const records = viewViolations(workspace, { view: 'bizcase', chartId, flowId: tabletop.id });
    const issues = records.reduce((n, r) => n + r.issues.length, 0);
    expect(issues).toBeGreaterThan(records.length);
  });

  it('keeps the legacy ids, so a record points at the row or step it is about', () => {
    // importLegacy keeps every id the file carries; the fixture's ids are the legacy app's own.
    const records = viewViolations(workspace, { view: 'bizcase', chartId, flowId: tabletop.id });
    for (const r of records) {
      if (r.kind === 'chart') expect(workspace.charts[r.chartId]!.nodes[r.nodeId]).toBeDefined();
      else expect(workspace.flows[r.flowId]!.steps[r.stepId]).toBeDefined();
    }
  });
});

describe('flowsToLint — which flows ride along with the chart', () => {
  const base = importLegacy(demo).workspace;
  const chartId = Object.keys(base.charts)[0]!;
  const rowId = Object.keys(base.charts[chartId]!.nodes)[0]!;
  const [firstFlow, secondFlow] = Object.keys(base.flows) as [string, string];

  it('lints no flow in the chart view when none is anchored to the chart', () => {
    expect(flowsToLint(base, { view: 'chart', chartId })).toEqual([]);
  });

  it('lints every flow anchored to the chart in front, in every view but the flow view', () => {
    const ws = structuredClone(base);
    ws.flows[secondFlow]!.anchor = { chartId, nodeId: rowId };
    for (const view of ['chart', 'roster', 'work', 'objects'] as const) {
      expect(flowsToLint(ws, { view, chartId, flowId: firstFlow })).toEqual([secondFlow]);
    }
  });

  it('lints only the open flow in the flow view, anchored or not', () => {
    const ws = structuredClone(base);
    ws.flows[secondFlow]!.anchor = { chartId, nodeId: rowId };
    expect(flowsToLint(ws, { view: 'bizcase', chartId, flowId: firstFlow })).toEqual([firstFlow]);
    expect(flowsToLint(ws, { view: 'flow', chartId, flowId: firstFlow })).toEqual([firstFlow]);
  });

  it('falls back to the first flow when the open one is gone', () => {
    expect(flowsToLint(base, { view: 'bizcase', chartId, flowId: 'b_deleted' })).toEqual([firstFlow]);
  });

  it('ignores an anchor that no longer resolves, as the legacy loader drops it', () => {
    const ws = structuredClone(base);
    ws.flows[secondFlow]!.anchor = { chartId, nodeId: 'n_deleted' };
    expect(flowsToLint(ws, { view: 'chart', chartId })).toEqual([]);
  });

  it('knows the flow view by either name', () => {
    expect(isFlowView('bizcase')).toBe(true);
    expect(isFlowView('flow')).toBe(true);
    expect(isFlowView('chart')).toBe(false);
  });
});

describe('the pill and the pins', () => {
  const record = (severity: 'err' | 'warn', n: number): ViolationRecord => ({
    kind: 'flow',
    flowId: 'b_1',
    stepId: `t_${severity}${n}`,
    name: 'Step',
    tierLabel: 'Flow step',
    ancestors: [{ id: null, name: 'Flow' }],
    severity,
    issues: [{ rule: 'flowNoDoer', severity, message: '…' }],
  });
  const many = (errs: number, warns: number) => [
    ...Array.from({ length: errs }, (_, i) => record('err', i)),
    ...Array.from({ length: warns }, (_, i) => record('warn', i)),
  ];

  it('words the pill as index.html does', () => {
    expect(violationPillText(many(0, 410))).toBe('410 warnings');
    expect(violationPillText(many(0, 1))).toBe('1 warning');
    expect(violationPillText(many(1, 0))).toBe('1 error');
    expect(violationPillText(many(2, 3))).toBe('2 errors · 3 warnings');
    expect(violationPillText([])).toBe('');
  });

  it('indexes records by what they pin', () => {
    const { workspace } = importLegacy(demo);
    const chartId = Object.keys(workspace.charts)[0]!;
    const records = violationRecords(workspace, {
      chartId,
      flowIds: Object.keys(workspace.flows),
    });
    const { byNodeId, byStepId } = violationIndex(records);
    expect(byNodeId.size + byStepId.size).toBe(records.length);
    for (const r of byStepId.values()) expect(r.kind).toBe('flow');
  });
});
