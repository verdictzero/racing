#!/usr/bin/env node
// Capture index.html's own rule-engine output as the parity fixture for @raci/core.
//
// packages/core/src/violations.test.ts asserts that the rebuild's `violationRecords` reproduces what
// index.html's `recomputeViolations` + `lintFlow` put in `_violations` — record for record, in the
// same order, message for message, character for character. The expected side of that assertion is
// not written by hand: this script loads the real index.html in headless Chromium with a workspace
// seeded into localStorage, reads `_violations` and the warnings pill, and writes
// packages/core/src/__fixtures__/legacy-violations.json.
//
// Two scenarios:
//   demo   the shipped demo workspace (packages/core/src/__fixtures__/demo-workspace.json), in the
//          chart view, the roster view, and the flow view with each flow active.
//   rules  a small workspace built below so that EVERY rule fires, every message variant is
//          printed, and every loader repair the port has to mirror is exercised at least once.
//          The demo alone raises five of the twenty-odd rules.
//
// Re-run it whenever the rule functions change in index.html — the test's drift guard names the
// function that changed:
//
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
//   CHROMIUM=/path/to/chrome \
//   node scripts/capture-legacy-violations.mjs
//
// Playwright is deliberately not a dependency of this repository: it is a large download for a
// script that runs only when the legacy rules change. Any installed copy will do.

// Node's structuredClone, and the page globals the functions handed to the browser read.
/* global structuredClone, _violations, state, document, localStorage, APP_VERSION */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = join(root, 'index.html');
const FIXTURES = join(root, 'packages/core/src/__fixtures__');
const OUT = join(FIXTURES, 'legacy-violations.json');

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');

// ---- the drift guard's input ---------------------------------------------------------------------
// Every index.html function the port mirrors. The test hashes the same list the same way and
// compares, so an edit to any of them in the source fails the parity test until this is re-run.
// Keep the two lists identical (violations.test.ts, LEGACY_RULE_FUNCTIONS).
const RULE_FUNCTIONS = [
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

/**
 * One top-level function's text, as the test extracts it: from the line that opens it to the first
 * line that is exactly `}` (index.html closes every multi-line top-level function at column 0), or
 * just the opening line for a one-liner.
 */
function functionText(lines, name) {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`function ${name} not found in index.html`);
  const first = lines[start];
  const opens = (first.match(/{/g) || []).length;
  const closes = (first.match(/}/g) || []).length;
  if (opens > 0 && opens === closes) return first;
  const end = lines.findIndex((l, i) => i > start && l === '}');
  if (end < 0) throw new Error(`function ${name} has no closing brace at column 0`);
  return lines.slice(start, end + 1).join('\n');
}

const html = readFileSync(INDEX, 'utf8');
const lines = html.replace(/\r/g, '').split('\n');
const functions = Object.fromEntries(
  RULE_FUNCTIONS.map((name) => [
    name,
    createHash('sha256').update(functionText(lines, name)).digest('hex'),
  ]),
);

// ---- scenario builders (legacy shapes, exactly as index.html stores them) -------------------------

const meta = () => ({ description: '', customer: '', priority: '', budget: '', tags: [] });
const row = (id, name, raci = {}, children = [], extra = {}) => ({
  id, name, raci: { ...raci }, status: 'todo', description: '', documents: [],
  inputs: [], outputs: [], children, ...extra,
});
const chart = (id, title, activities, extra = {}) => ({
  id, title, framework: 'raci', status: 'draft', finalizedAt: null, meta: meta(), custom: null,
  activities, drillPath: [], chartSize: null, chartZoom: 1, chartPos: {}, ...extra,
});
const task = (id, name, raci = {}, extra = {}) => ({
  id, kind: 'task', name, raci: { ...raci }, parties: {}, description: '', entry: '', exit: '',
  bind: null, bindOverrides: [], status: 'todo', x: 0, y: 0, groupId: null, ...extra,
});
const sub = (id, name, refId, ports = { in: [], out: [] }) => ({
  id, kind: 'subflow', refId, name, raci: {}, parties: {}, description: '', entry: '', exit: '',
  status: 'todo', x: 0, y: 0, groupId: null, ports,
});
const edge = (id, from, to, extra = {}) => ({
  id, from, to, label: '', artifactIds: [], fromPort: null, toPort: null, via: [], ...extra,
});
const flow = (id, name, tasks, edges, extra = {}) => ({
  id, name, meta: meta(), framework: 'raci', mode: 'free', sourceChartId: null, status: 'draft',
  finalizedAt: null, anchor: null, tasks, edges, groups: [], view: { panX: 0, panY: 0, zoom: 1 },
  showTable: false, ...extra,
});
const artifact = (id, name) => ({ id, name, type: 'document', ownerRef: null, description: '', doc: null });

/**
 * The rules workspace. Each row, step and handoff is there for a reason, and the comment beside it
 * says which rule or which message variant it pins.
 */
function rulesWorkspace() {
  const org = chart('c_rules', 'Rules Org', [
    row('p1', 'Portfolio One', { hq: 'A', cos: 'R' }, [
      // multipleOwner, naming both columns — one of them relabelled by the workspace.
      row('g1', 'Program with two owners', { hq: 'A', cos: 'A', mission: 'R' }, [
        // ambiguousPrimaryR; a lower-case letter the loader normalizes before any rule sees it.
        row('j1', 'Project with two doers', { mission: 'R', infra: 'r' }, [
          row('k1', 'Task nobody does', { hq: 'C' }), // noDoer, "task"
          row('k2', 'Task consulting everyone', { hq: 'c', cos: 'C', mission: 'C', infra: 'C', cyber: 'R' }), // overConsulted 4 of 7
          // Untitled; and it has a child an organization chart cannot hold (depth 4). The loader
          // drops the child, which makes this row a LEAF — so noDoer fires on it.
          row('k3', '', {}, [row('k3x', 'Too deep for an organization chart', { hq: 'A', cos: 'A' })]),
        ]),
        // ambiguousPrimaryR AND invalidPrimaryR: two doers and a primary that is neither.
        row('j2', 'Project with a stale primary', { cyber: 'R', sw: 'R', hq: 'A' }, [
          row('k4', 'Task with two orphan inputs', { cyber: 'R', hq: 'A' }, [], { inputs: ['a_ghost1', 'a_ghost2'] }),
          row('k5', 'Task with one orphan input', { cyber: 'R', hq: 'A' }, [], { inputs: ['a_ghost1', 'a_made'] }),
          row('k6', 'Task supplying itself', { cyber: 'R', hq: 'A' }, [], { inputs: ['a_self'], outputs: ['a_self', 'a_made'] }),
          // Its input rides a handoff — but only on a DUPLICATE handoff the loader drops, so in the
          // source nothing produces it and the rule fires.
          row('k7', 'Task fed by a dropped handoff', { cyber: 'R', hq: 'A' }, [], { inputs: ['a_handoff'] }),
          row('k8', 'Task naming one input twice', { cyber: 'R', hq: 'A' }, [], { inputs: ['a_ghost1', 'a_ghost1'] }),
        ], { primaryR: 'contacts' }),
        row('j3', 'Project with a primary', { cyber: 'R', sw: 'R' }, [
          row('k9', 'Task inheriting from the primary', { infra: 'R' }),
        ], { primaryR: 'sw' }),
      ]),
      row('g2', 'Program inheriting its owner', { mission: 'R' }),
    ]),
    // noOwner + ambiguousPrimaryR at the top, and a cascade that passes nothing down.
    row('p2', 'Portfolio with no owner', { cyber: 'R', sw: 'R' }, [
      row('g3', 'Program under an ambiguous root', { infra: 'R' }), // noOwner
      row('g4', 'Program with nobody on it', {}), // noOwner + noDoer, "program"
    ]),
    row('p3', 'Portfolio leaf', { hq: 'C' }), // noOwner + noDoer, "portfolio"
    // Every rule a row can break at once, with an error among them: the record is an error.
    row('p4', 'Portfolio breaking everything', { hq: 'A', cos: 'A', mission: 'C', infra: 'C', cyber: 'C', sw: 'C' }, [], { inputs: ['a_ghost1'] }),
  ]);

  const rasci = chart('c_rasci', 'Rules RASCI', [
    row('r1', 'RASCI portfolio', { hq: 'A', cyber: 'R', sw: 'S' }, [
      row('r2', 'RASCI program', { mission: 'R', infra: 'S' }),
    ]),
  ], { framework: 'rasci' });

  // A free-form chart: its own columns (one duplicated key, one padded label, one blank label), its
  // own level names (one blank, one padded), and no depth limit.
  const free = chart('c_free', 'Rules Free', [
    row('f1', 'Stream one', { x1: 'A', x2: 'R' }, [
      row('f2', 'Second-level row', { x2: 'R', x3: 'R' }, [ // ambiguousPrimaryR (Ops, Party)
        row('f3', 'Work item row', { x1: 'C', x3: 'C', x4: 'C' }, [ // overConsulted 3 of 4
          row('f4', 'Fourth-level row', {}, [
            row('f5', 'Fifth-level row', { x4: 'R' }, [], { primaryR: 'hq' }), // invalidPrimaryR, org label
            row('f6', 'Fifth-level sibling', { x4: 'R', x1: 'R' }, [], { primaryR: 'zz' }), // …and a raw key
          ]),
        ]),
      ]),
    ]),
    row('f7', 'Stream without an owner', { x3: 'R' }), // noOwner
  ], {
    custom: {
      cols: [
        { key: 'x1', label: 'Board', short: 'B' },
        { key: 'x2', label: '  Ops  ', short: '' },
        { key: 'x3', label: '', short: '' },
        { key: 'x1', label: 'Duplicate key', short: '' },
        { key: 'x4', label: 'Vendor', short: 'V' },
      ],
      tiers: ['Stream', '   ', ' Work item '],
    },
  });

  const bizCases = [
    // Anchored under a row whose PRIMARY doer column (sw) is what its steps inherit.
    flow('b_anch', 'Anchored flow', [
      task('t_a1', 'Step inheriting its owner', { cyber: 'R' }),
      task('t_a2', 'Step naming another owner', { cos: 'A', hq: 'R' }), // flowOwnerOverride + flowPartyMissing (hq unmapped)
      task('t_a3', 'Step with two owners', { hq: 'A', cos: 'A', cyber: 'R' }), // multipleOwner
      task('t_a4', 'Step nobody does', { cos: 'C' }), // flowNoDoer
      task('t_a5', 'Step with one party named', { hq: 'R', contacts: 'R', sw: 'A' }, { parties: { hq: { actor: 'ocio' } } }), // party missing on contacts only
      task('t_a6', '', { cyber: 'R' }), // untitled, and wired to nothing: flowDisconnected
      task('t_a7', 'Decision', { sw: 'A', mission: 'R' }), // decisionUnlabeled (3 ways) + 2 bare handoffs
      task('t_a8', 'Step on a column unmapped on purpose', { infra: 'R' }), // infra: explicit null
    ], [
      // The bare duplicate comes FIRST, so it is the one the loader keeps: t_a1 then has a bare
      // handoff, and a_handoff (on the dropped copy) has no producer anywhere.
      edge('e_a1dup', 't_a1', 't_a2'),
      edge('e_a1', 't_a1', 't_a2', { artifactIds: ['a_handoff'] }),
      edge('e_a1self', 't_a1', 't_a1'), // a self-loop: dropped on load
      edge('e_a2', 't_a2', 't_a3', { artifactIds: ['a_made'] }),
      edge('e_a3', 't_a3', 't_a4', { artifactIds: ['a_made'] }),
      edge('e_a4', 't_a4', 't_a7', { artifactIds: ['a_made'] }),
      edge('e_a5', 't_a7', 't_a5'),
      edge('e_a6', 't_a7', 't_a8', { label: '   ' }), // whitespace is not a label
      edge('e_a7', 't_a7', 't_a3', { label: 'Escalate', artifactIds: ['a_made'] }),
    ], { anchor: { chartId: 'c_rules', nodeId: 'j3' } }),

    // Anchored under a row whose cascade hands down nothing.
    flow('b_anch2', 'Anchored without a cascade', [
      task('t_b1', 'Step the cascade cannot own', { mission: 'R' }), // flowNoOwner, "the chart cascade provides none"
    ], [], { anchor: { chartId: 'c_rules', nodeId: 'p2' } }),

    flow('b_free', 'Standalone flow', [
      task('t_c1', 'Step on its own', { cyber: 'R' }), // flowNoOwner, "standalone flows inherit none"
      // A pre-v0.17 file keyed parties by LETTER; the loader copies each onto the columns holding it.
      task('t_c2', 'Step with letter-keyed parties', { hq: 'R', cos: 'A' }, { parties: { R: { actor: 'ocio' } } }),
      task('t_c3', 'Step with no anchor to default from', { infra: 'R', hq: 'A' }),
    ], [
      edge('e_c1', 't_c1', 't_c2', { artifactIds: ['a_made'] }),
      edge('e_c2', 't_c2', 't_c3', { artifactIds: ['a_made'] }),
    ]),

    // Chart-Linked, Final, and sourced from the org chart.
    flow('b_link', 'Linked flow', [
      task('t_l1', 'Step linked to nothing', { cyber: 'R', hq: 'A' }), // flowStepUnlinked
      task('t_l2', 'Step linked to a deleted row', { cyber: 'R', hq: 'A' }, { bind: { chartId: 'c_rules', nodeId: 'n_gone' } }), // flowBindMissing
      // flowBindForeign + flowFinalDraftSource; RASCI letters translated (S drops).
      task('t_l3', 'Step linked into another chart', {}, { bind: { chartId: 'c_rasci', nodeId: 'r2' } }),
      // flowBindOverride on ONE column: hq is taken over but unchanged (a no-op), sw likewise;
      // cyber is taken over and emptied. Junk and a repeat in the list are dropped by the loader.
      task('t_l4', 'Step overriding one column', { hq: 'A', cyber: '', sw: '' }, { bind: { chartId: 'c_rules', nodeId: 'k4' }, bindOverrides: ['hq', 'cyber', 'sw', 'bogus', 'hq'] }),
      task('t_l5', 'Step overriding two columns', { cos: 'R', mission: 'C' }, { bind: { chartId: 'c_rules', nodeId: 'k9' }, bindOverrides: ['cos', 'mission'] }),
      task('t_l6', 'Step linked to an ownerless row', {}, { bind: { chartId: 'c_rules', nodeId: 'g4' } }), // flowNoOwner, "the linked row … names none either"
      task('t_l7', 'Step linked to a free-form row', {}, { bind: { chartId: 'c_free', nodeId: 'f1' } }), // free-form rows cannot be bound: flowBindMissing
    ], [
      edge('e_l1', 't_l1', 't_l2', { artifactIds: ['a_made'] }),
      edge('e_l2', 't_l2', 't_l3', { artifactIds: ['a_made'] }),
      edge('e_l3', 't_l3', 't_l4', { artifactIds: ['a_made'] }),
      edge('e_l4', 't_l4', 't_l5', { artifactIds: ['a_made'] }),
      edge('e_l5', 't_l5', 't_l6', { artifactIds: ['a_made'] }),
      edge('e_l6', 't_l6', 't_l7', { artifactIds: ['a_made'] }),
    ], { mode: 'linked', sourceChartId: 'c_rules', status: 'final', finalizedAt: '2026-01-01T00:00:00.000Z' }),

    // A source chart that is not in the file, and one that is free-form: the loader drops both, so
    // neither flow raises flowBindForeign.
    flow('b_link2', 'Linked to a missing source chart', [
      task('t_m1', 'Step linked into the RASCI chart', {}, { bind: { chartId: 'c_rasci', nodeId: 'r1' } }),
    ], [], { mode: 'linked', sourceChartId: 'c_gone' }),
    flow('b_link3', 'Linked to a free-form source chart', [
      task('t_n1', 'Step linked into the RASCI chart', {}, { bind: { chartId: 'c_rasci', nodeId: 'r2' } }),
    ], [], { mode: 'linked', sourceChartId: 'c_free' }),

    // Nested-flow boxes — linted before the ordinary steps, whatever their order in the flow.
    flow('b_sub', 'Nesting flow', [
      task('t_s0', 'Kick-off', { hq: 'A', cyber: 'R' }), // decisionUnlabeled (4) + 3 bare handoffs
      sub('t_s1', '', 'b_gone'), // subflowMissing; untitled, so it reads "Untitled"
      sub('t_s2', 'Loop box', 'b_loop'), // subflowCycle
      sub('t_s3', '', 'b_empty'), // subflowEmpty + flowDisconnected (nested variant)
      sub('t_s4', 'Self box', 'b_sub'), // a box nesting its own flow: the loader clears it → subflowMissing
      sub('t_s5', 'All exits open', 'b_exits'), // subflowExitDangling, 2 of 3 exits unused
      sub('t_s6', 'Two exits chosen', 'b_exits', { in: [], out: ['x_a', 'x_b', 'x_gone'] }), // 1 of 2 unused
      sub('t_s7', 'One exit chosen', 'b_exits', { in: [], out: ['x_a'] }), // one open exit: never dangling
      task('t_s8', 'Receiver', { hq: 'A', cyber: 'R' }),
    ], [
      edge('e_s1', 't_s0', 't_s5', { artifactIds: ['a_made'] }),
      edge('e_s2', 't_s5', 't_s8', { fromPort: 'x_a', artifactIds: ['a_made'] }),
      edge('e_s3', 't_s5', 't_s8', { fromPort: 'x_bogus' }), // names no step over there
      edge('e_s4', 't_s0', 't_s6'),
      edge('e_s5', 't_s6', 't_s8', { fromPort: 'x_a' }),
      edge('e_s6', 't_s0', 't_s7'),
      edge('e_s7', 't_s0', 't_s2'),
    ]),
    flow('b_loop', 'Loop flow', [sub('t_lp1', '', 'b_sub')], []), // subflowCycle, from the other side
    flow('b_empty', 'Empty flow', [], []),
    flow('b_exits', 'Exits flow', [
      task('x_in', 'Entry', { hq: 'A', cyber: 'R' }),
      task('x_a', 'Exit A', { hq: 'A', cyber: 'R' }),
      task('x_b', 'Exit B', { hq: 'A', cyber: 'R' }),
      task('x_c', '', { hq: 'A', cyber: 'R' }),
    ], [
      edge('e_x1', 'x_in', 'x_a', { label: 'Path A' }),
      edge('e_x2', 'x_in', 'x_b', { label: 'Path B' }),
      edge('e_x3', 'x_in', 'x_c'),
    ]),
    // An anchor naming a row that is not there: the loader drops it, and the flow is standalone.
    flow('b_dangle', 'Dangling anchor', [
      task('t_d1', 'Step under a vanished row', { cyber: 'R' }),
    ], [], { anchor: { chartId: 'c_rules', nodeId: 'n_missing' } }),
    // Anchored into the FREE-FORM chart. The source resolves the anchor's cascade with the ACTIVE
    // chart's columns, so what these steps inherit depends on which chart tab is in front.
    flow('b_freeanch', 'Anchored to a free-form row', [
      task('t_fa1', 'Step owned elsewhere', { cos: 'A', cyber: 'R' }),
      task('t_fa2', 'Step without an owner', { mission: 'R' }),
    ], [edge('e_fa1', 't_fa1', 't_fa2', { artifactIds: ['a_made'] })], { anchor: { chartId: 'c_free', nodeId: 'f1' } }),
  ];

  return {
    charts: [org, rasci, free],
    activeChartId: 'c_rules',
    bizCases,
    activeBizCaseId: 'b_free',
    artifacts: [
      artifact('a_ghost1', 'Ghost Report'),
      artifact('a_ghost2', ''), // a blank name: the loader reads it as "Untitled deliverable"
      artifact('a_made', 'Made Here'),
      artifact('a_self', 'Self Register'),
      artifact('a_handoff', 'Handoff Pack'),
    ],
    entities: [],
    workScope: null,
    actorLabels: {},
    // A relabelled column, and a blank label that falls back to the default.
    columnLabels: { cos: 'Chief of Staff (custom)', hq: '   ' },
    columnShort: {},
    // infra is unmapped ON PURPOSE (an explicit null); mission is absent, so it self-maps by default.
    columnActor: { hq: null, cos: null, infra: null, cyber: 'cyber', sw: 'sw', contacts: null },
    directorates: {},
    collapsedDirectorates: {},
    bizGallery: false,
    rosterMode: 'explore',
    viewMode: 'chart',
    showLegend: false,
  };
}

const demo = JSON.parse(readFileSync(join(FIXTURES, 'demo-workspace.json'), 'utf8'));
const rules = rulesWorkspace();
const rulesFlows = rules.bizCases.map((b) => b.id);

const scenarios = [
  {
    name: 'demo',
    input: 'demo-workspace.json',
    workspace: demo,
    captures: [
      { view: 'chart', chart: 'c_53jst3no', flow: 'b_080aooen' },
      { view: 'roster', chart: 'c_53jst3no', flow: 'b_080aooen' },
      { view: 'bizcase', chart: 'c_53jst3no', flow: 'b_080aooen' },
      { view: 'bizcase', chart: 'c_53jst3no', flow: 'b_1ntte2mi' },
    ],
  },
  {
    name: 'rules',
    input: rules,
    workspace: rules,
    captures: [
      { view: 'chart', chart: 'c_rules', flow: 'b_free' },
      { view: 'chart', chart: 'c_rasci', flow: 'b_free' },
      { view: 'chart', chart: 'c_free', flow: 'b_free' },
      { view: 'work', chart: 'c_rules', flow: 'b_free' },
      ...rulesFlows.map((id) => ({ view: 'bizcase', chart: 'c_rules', flow: id })),
      // The same flows with the free-form chart in front: the cascade reads ITS columns.
      { view: 'bizcase', chart: 'c_free', flow: 'b_anch' },
      { view: 'bizcase', chart: 'c_free', flow: 'b_link' },
      { view: 'bizcase', chart: 'c_free', flow: 'b_freeanch' },
      // A stale active id: the source falls back to the first chart and the first flow.
      { view: 'bizcase', chart: 'c_nope', flow: 'b_nope' },
    ],
  },
];

const browser = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
);

async function capture(workspace, { view, chart: chartId, flow: flowId }) {
  const seeded = structuredClone(workspace);
  seeded.viewMode = view;
  seeded.activeChartId = chartId;
  seeded.activeBizCaseId = flowId;
  const ctx = await browser.newContext();
  await ctx.addInitScript((s) => {
    localStorage.setItem('raci-matrix-v8', s);
    localStorage.setItem('raci-matrix-splash-v2', 'never');
  }, JSON.stringify(seeded));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(pathToFileURL(INDEX).href);
  await page.waitForFunction(() => document.readyState === 'complete');
  await page.waitForTimeout(400);
  const got = await page.evaluate(() => {
    const toast = document.getElementById('violations-toast');
    const lit = !!toast && toast.classList.contains('has-issues');
    return {
      appVersion: APP_VERSION,
      view: state.viewMode,
      activeChartId: state.activeChartId,
      activeFlowId: state.activeBizCaseId,
      pill: lit ? toast.querySelector('.vt-text').textContent : '',
      onlyWarn: lit && toast.classList.contains('only-warn'),
      records: _violations.map((v) => ({
        kind: v.kind === 'flow' ? 'flow' : 'chart',
        ...(v.kind === 'flow'
          ? { flowId: v.bizCaseId, stepId: v.taskId }
          : { nodeId: v.nodeId, tier: v.tier }),
        name: v.name,
        tierLabel: v.tierLabel,
        ancestors: v.ancestors.map((a) => ({ id: a.id, name: a.name })),
        severity: v.severity,
        issues: v.issues.map((i) => ({ rule: i.rule, severity: i.severity, message: i.message })),
      })),
    };
  });
  await ctx.close();
  if (errors.length) console.warn(`  page errors in ${view}/${chartId}/${flowId}:`, errors);
  return got;
}

// Records are stored once and referenced by key, because the chart's rows repeat in every capture
// of the same chart — the demo's 410 of them four times over. A key maps to exactly one record: if
// the same row ever reads differently in two captures, the second gets a suffixed key of its own.
const records = {};
const keyFor = (capture, r) => {
  const base = r.kind === 'flow'
    ? `flow:${r.flowId}:${r.stepId}`
    : `chart:${capture.activeChartId}:${r.nodeId}`;
  const text = JSON.stringify(r);
  for (let n = 1; ; n++) {
    const key = n === 1 ? base : `${base}#${n}`;
    if (!(key in records)) { records[key] = r; return key; }
    if (JSON.stringify(records[key]) === text) return key;
  }
};

let appVersion = null;
const out = [];
for (const scenario of scenarios) {
  const captures = [];
  for (const want of scenario.captures) {
    const got = await capture(scenario.workspace, want);
    appVersion = got.appVersion;
    captures.push({
      // What was seeded, and what the source made of it — they differ when an id is stale.
      requested: { chartId: want.chart, flowId: want.flow },
      view: got.view,
      activeChartId: got.activeChartId,
      activeFlowId: got.activeFlowId,
      pill: got.pill,
      onlyWarn: got.onlyWarn,
      records: got.records.map((r) => keyFor(got, r)),
    });
    console.log(
      `${scenario.name.padEnd(6)} ${got.view.padEnd(8)} ${got.activeChartId.padEnd(11)} ${got.activeFlowId.padEnd(12)} ` +
      `${String(got.records.length).padStart(4)} records  "${got.pill}"`,
    );
  }
  out.push({ name: scenario.name, input: scenario.input, captures });
}
await browser.close();

// Hand-rolled layout: the scenarios pretty-printed, every record on one line. Diffable when the
// source changes, and a third of the size of pretty-printing the records too.
const body = [
  '{',
  `  "about": ${JSON.stringify('index.html\'s own _violations, captured by scripts/capture-legacy-violations.mjs. Do not edit by hand.')},`,
  `  "source": ${JSON.stringify({ file: 'index.html', appVersion, functions }, null, 2).replace(/\n/g, '\n  ')},`,
  `  "scenarios": ${JSON.stringify(out, null, 2).replace(/\n/g, '\n  ')},`,
  '  "records": {',
  Object.entries(records)
    .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(',\n'),
  '  }',
  '}',
  '',
].join('\n');
writeFileSync(OUT, body);
console.log(`wrote ${OUT} — ${Object.keys(records).length} distinct records`);
