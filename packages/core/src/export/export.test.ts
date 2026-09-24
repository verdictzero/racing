import { describe, it, expect } from 'vitest';
import demo from '../__fixtures__/demo-workspace.json' with { type: 'json' };
// Digests of what index.html's own `exportXML()`, `exportMermaid()` and `exportMermaidFlow()` wrote
// for the demo and two variations of it, run headless in Chromium (en-US, UTC) by
// scripts/capture-legacy-parity.mjs — rerun it when index.html changes an export.
import golden from '../__fixtures__/legacy-parity.json' with { type: 'json' };
import { anchoredVariant, freeFormVariant } from '../__fixtures__/parity-variants.js';
import { importLegacy } from '../legacy.js';
import { chartsInTabOrder } from '../registry.js';
import { exportXml } from './xml.js';
import { exportChartMermaid, exportFlowMermaid } from './mermaid.js';

/** The locale and zone the golden capture ran in. */
const CAPTURED = { locale: 'en-US', timeZone: 'UTC' } as const;

async function sha256(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const inputs = {
  demo,
  anchored: anchoredVariant(demo),
  freeform: freeFormVariant(demo),
} as const;
const cases = Object.keys(inputs) as Array<keyof typeof inputs>;

const { workspace } = importLegacy(demo);
const chartId = golden.cases.demo.chartId;
const tabletopId = 'b_080aooen';
const evidenceId = 'b_1ntte2mi';
const anchored = importLegacy(inputs.anchored).workspace;
const freeform = importLegacy(inputs.freeform).workspace;

describe('XML export', () => {
  const xml = exportXml(workspace, { chartId });

  it('is well-formed enough to parse', () => {
    // No DOMParser in Node, so check the structural invariants that actually break consumers:
    // a declaration, one root, and balanced tags.
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<raciTool ')).toBe(true);
    expect(xml.match(/<raciTool\b/g)).toHaveLength(1);
    expect(xml.endsWith('</raciTool>\n')).toBe(true);

    const opens = [...xml.matchAll(/<([A-Za-z][A-Za-z0-9]*)(?:\s[^>]*?)?(?<!\/)>/g)].map((m) => m[1]);
    const closes = [...xml.matchAll(/<\/([A-Za-z][A-Za-z0-9]*)>/g)].map((m) => m[1]);
    expect(opens.sort()).toEqual(closes.sort());
  });

  it('carries every row of the real 810-row demo, one element per tier', () => {
    const count = (tag: string) => xml.match(new RegExp(`<${tag}\\b`, 'g'))?.length ?? 0;
    expect([count('portfolio'), count('program'), count('project'), count('task')]).toEqual([
      11, 39, 117, 643,
    ]);
  });

  it('names each column, then each row with its roster unit and resolved line', () => {
    expect(xml).toContain('    <column key="cyber" label="Cyber &amp; EW Dir."/>\n');
    expect(xml).toContain(
      '<program name="Program Activity 1.1" org="DIRECTORATE A › Division A1 · Chief: Karen Anderson" hq="A" cos="I" mission="R" infra="R" cyber="C" sw="I" contacts="I">',
    );
  });

  it('writes the RESOLVED line: an inherited owner shows, and a blank cell reads as Informed', () => {
    // "Blank-named level" is R for legal only; its parent names legal its primary doer, so legal
    // is where it inherits its owner.
    expect(exportXml(freeform, { chartId: 'c_par_free' })).toContain(
      '<level3 name="Blank-named level" sponsor="I" pmo="I" legal="RA">',
    );
  });

  it('escapes markup in names rather than emitting it', () => {
    const nasty = structuredClone(workspace);
    const first = Object.values(nasty.charts[chartId]!.nodes)[0]!;
    first.name = 'Ampersand & <script>alert("x")</script>';
    const out = exportXml(nasty, { chartId });
    expect(out).not.toContain('<script>');
    expect(out).toContain('Ampersand &amp; &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });

  it('nests an anchored flow under the row it implements, after that row’s children', () => {
    const out = exportXml(anchored, { chartId });
    const task = out.indexOf('<task name="Task Activity 1 — it&#39;s &lt;anchored&gt;"');
    const flow = out.indexOf('<flow name="Cyber Incident Response (Tabletop)" status="final" mode="free" finalized="2026-03-05T09:00:00.000Z">');
    expect(task).toBeGreaterThan(-1);
    expect(flow).toBeGreaterThan(task);
    expect(out.indexOf('</task>', task)).toBeGreaterThan(flow);
    // The empty flow hangs off the first Portfolio row, below every program under it.
    expect(out).toContain('      </program>\n      <flow name="" status="draft" mode="free">\n      </flow>\n    </portfolio>\n');
    // Only flows anchored to THIS chart.
    expect(out).not.toContain('Anchored elsewhere');
  });

  it('writes a flow’s steps in the order it runs, then its handoffs', () => {
    const out = exportXml(anchored, { chartId });
    expect(out).toContain(
      '<step name="Detect &amp; Triage" roles="D&amp;HQ: A | C&amp;EW: R" parties="C&amp;EW → Cyber &quot;D&quot; (default)">\n' +
        '                <output deliverable="Triage Report"/>\n' +
        '              </step>\n',
    );
    expect(out).toContain(
      '<handoff from="Update risk register" to="?" condition="Residual risk accepted" deliverables="Incident Declaration"/>',
    );
  });

  it('traces a Chart-Linked step to its row, and marks a column it took back and says differently', () => {
    const out = exportXml(anchored, { chartId });
    const freeze = out.split('\n').find((l) => l.includes('<step name="Freeze the host"'))!;
    expect(freeze).toContain(
      'linkedRow="Portfolio: ASIC &lt;RACI&gt; &amp; &quot;Tool&quot; ’s demo › Strategic Portfolio Vision &amp; Objectives"',
    );
    // C&EW taken back as R where the row says C; Mission taken back and cleared; HQ taken back as
    // the A the row already says, so not marked.
    expect(freeze).toContain('roles="D&amp;HQ: A | CoS: R | Infra: C | C&amp;EW: R (override) | S&amp;S: C | CMO: I"');
    expect(out).toContain('<step name="Hand to legal" linkedRow="(linked row is missing)"');
    expect(out).toContain('<step name="Seal in evidence store" linkedRow="(not linked)"');
  });

  it('carries the chart’s status and signature, the registries and the roster', () => {
    const out = exportXml(anchored, { chartId });
    expect(out).toContain(
      '<raciTool title="ASIC &lt;RACI&gt; &amp; &quot;Tool&quot; ’s demo" status="final" finalized="2026-03-04T15:30:00.000Z">',
    );
    // Each producer once per handoff, as the legacy lists them.
    expect(out).toContain(
      '<artifact name="Triage Report" type="document" producers="Detect &amp; Triage, Detect &amp; Triage" consumers="Declare Incident, After-Action Review"/>',
    );
    expect(out).toContain(
      'namedBy="Cyber Incident Response (Tabletop) › Declare Incident"/>',
    );
    expect(out).toContain('<directorate key="cyber" label="Cyber &quot;D&quot;"');
    expect(out).toContain('      <division name="Vendor Division 9"></division>\n');
  });

  it('leaves the flows and the roster out of a free-form chart, and names its levels by depth', () => {
    const out = exportXml(freeform, { chartId: 'c_par_free' });
    expect(out).toContain('    <column key="legal" label="Party"/>\n');
    expect(out).toMatch(/<level5 name="Level-5 row 1"/);
    expect(out).not.toContain('<flow ');
    expect(out).not.toContain('<roster>');
  });

  it('is the chart in front — the first tab when none is named, or one that does not exist', () => {
    const first = chartsInTabOrder(freeform)[0]!.id;
    const want = exportXml(freeform, { chartId: first });
    expect(exportXml(freeform)).toBe(want);
    expect(exportXml(freeform, { chartId: 'c_nope' })).toBe(want);
  });

  it('is deterministic — the same workspace produces the same bytes', () => {
    expect(exportXml(workspace, { chartId })).toBe(xml);
  });

  describe('matches index.html byte for byte', () => {
    for (const name of cases) {
      it(name, async () => {
        const { workspace: ws } = importLegacy(inputs[name]);
        const want = golden.cases[name];
        expect(await sha256(exportXml(ws, { chartId: want.chartId }))).toBe(want.xml);
      });
    }
  });
});

describe('Mermaid — chart', () => {
  const mmd = exportChartMermaid(workspace, { chartId });

  it('starts with a comment header and a flowchart declaration', () => {
    expect(mmd.split('\n').slice(0, 2)).toEqual(['%% ASIC RACI Tool Demo — DRAFT', 'flowchart TD']);
  });

  it('emits a node per row and an edge per parent link', () => {
    const nodes = mmd.match(/^ {2}n\d+\[/gm) ?? [];
    const edges = mmd.match(/^ {2}n\d+ --> n\d+$/gm) ?? [];
    expect(nodes).toHaveLength(810);
    // Every row except the roots has exactly one parent edge.
    expect(edges).toHaveLength(810 - 11);
  });

  it('summarises only the owner and doer, not the whole matrix', () => {
    expect(mmd).toContain('  n0["Strategic Portfolio Vision & Objectives<br/>A: HQ<br/>R: CoS"]:::pf\n');
    // C and I would make the boxes unreadable at diagram scale.
    expect(mmd).not.toMatch(/<br\/>C: /);
  });

  it('strips quotes and newlines that would end the label early', () => {
    const nasty = structuredClone(workspace);
    const first = Object.values(nasty.charts[chartId]!.nodes)[0]!;
    first.name = 'Says "hello"\nand more';
    const out = exportChartMermaid(nasty, { chartId });
    expect(out).toContain('n0["Says &quot;hello&quot; and more<br/>');
  });

  it('prints the title as typed, and the signed date in the locale and zone asked for', () => {
    const header = (opts: { locale?: string; timeZone?: string }) =>
      exportChartMermaid(anchored, { chartId, ...opts }).split('\n')[0];
    expect(header(CAPTURED)).toBe('%% ASIC <RACI> & "Tool" ’s demo — FINAL (signed 3/4/2026)');
    expect(header({ locale: 'en-GB', timeZone: 'UTC' })).toContain('(signed 04/03/2026)');
  });

  it('abbreviates a free-form column with no short name the way the legacy does', () => {
    const out = exportChartMermaid(freeform, { chartId: 'c_par_free' });
    // "Program Office <PMO>" → the first letter of each word; a blank label reads "Party".
    expect(out).toContain('  n0["Initiative — Policy Refresh<br/>A: SPON<br/>R: PO<"]:::pf\n');
    expect(out).toContain('  n2["Blank-named level<br/>A: Party<br/>R: Party"]:::pj\n');
  });

  describe('matches index.html byte for byte', () => {
    for (const name of cases) {
      it(name, async () => {
        const { workspace: ws } = importLegacy(inputs[name]);
        const want = golden.cases[name];
        expect(await sha256(exportChartMermaid(ws, { chartId: want.chartId, ...CAPTURED }))).toBe(
          want.chartMermaid,
        );
      });
    }
  });
});

describe('Mermaid — flow', () => {
  const mmd = exportFlowMermaid(workspace, tabletopId);
  const line = (text: string, needle: string) => text.split('\n').find((l) => l.includes(needle))!;

  it('is a left-to-right graph, headed with its status and mode, signed off with the app', () => {
    const lines = mmd.split('\n');
    expect(lines.slice(0, 2)).toEqual([
      '%% Cyber Incident Response (Tabletop) — DRAFT · Free-Form',
      'flowchart LR',
    ]);
    expect(lines.at(-2)).toBe('  %% RACI flow — exported from ASIC RACI Tool (ver 0.39 alpha)');
  });

  it('declares the steps in the order they were drawn', () => {
    const ids = Object.values(workspace.flows[tabletopId]!.steps).map((s) => s.name);
    const declared = [...mmd.matchAll(/^ {2}s(\d+)[[{]"([^<"]*)/gm)].map((m) => [m[1], m[2]]);
    expect(declared).toEqual(ids.map((name, i) => [String(i), name]));
  });

  it('renders a decision point as a diamond, with the roles each step assigns', () => {
    // Detect & Triage branches into confirmed-incident and false-positive.
    expect(line(mmd, 'Detect')).toBe('  s0{"Detect & Triage<br/>HQ: A   C&EW: R"}:::dec');
    expect(line(mmd, 'Declare')).toBe('  s1["Declare Incident<br/>HQ: RA   CoS: C"]:::step');
  });

  it('draws a nested-flow box like any other step — two ways out make it a diamond', () => {
    expect(line(mmd, 'Preserve evidence')).toBe('  s6{"Preserve evidence"}:::dec');
  });

  it('labels an edge with its condition and the deliverables it carries', () => {
    expect(mmd).toContain('  s0 -->|Confirmed incident · Triage Report| s1\n');
    expect(mmd).toContain('  s1 -->|Incident Declaration| s2\n');
  });

  it('names the chart row a Chart-Linked step implements, and marks a column it overrides', () => {
    const out = exportFlowMermaid(anchored, evidenceId, { chartId });
    expect(line(out, 'Freeze the host')).toBe(
      '  s0["Freeze the host<br/>⛓ Strategic Portfolio Vision & Objectives<br/>D&HQ: A   CoS: R   Infra: C   C&EW: R (override)   S&S: C   CMO: I"]:::step',
    );
    // A bind to a row that is gone names nothing.
    expect(line(out, 'Hand to legal')).toBe('  s3["Hand to legal<br/>D&HQ: A   CoS: R"]:::step');
  });

  it('prints a signed flow’s date in the locale and zone asked for', () => {
    const header = (opts: { locale?: string; timeZone?: string }) =>
      exportFlowMermaid(anchored, tabletopId, opts).split('\n')[0];
    expect(header(CAPTURED)).toBe(
      '%% Cyber Incident Response (Tabletop) — FINAL · Free-Form (signed 3/5/2026)',
    );
    expect(header({ locale: 'en-GB', timeZone: 'UTC' })).toContain('(signed 05/03/2026)');
  });

  it('keeps every step even when the flow contains a loop', () => {
    // A rework loop is a real thing a process does; an exporter that silently dropped the looping
    // steps would be wrong in the worst way.
    const looped = structuredClone(workspace);
    const flow = looped.flows[tabletopId]!;
    const ids = Object.keys(flow.steps);
    flow.edges['e_loop'] = {
      id: 'e_loop', flowId: flow.id, from: ids[ids.length - 1]!, to: ids[0]!,
      fromPort: null, toPort: null, label: 'rework', artifactIds: [], via: [],
    };
    const out = exportFlowMermaid(looped, tabletopId);
    expect([...out.matchAll(/^ {2}s\d+[[{]/gm)]).toHaveLength(ids.length);
    expect(out).toContain(`  s${ids.length - 1} -->|rework| s0\n`);
  });

  it('draws the first flow for one that does not exist, as index.html’s abc() does', () => {
    expect(exportFlowMermaid(workspace, 'b_nope')).toBe(mmd);
    expect(exportFlowMermaid({ ...workspace, flows: {} }, 'b_nope').split('\n')[0]).toBe(
      '%% Untitled business case — DRAFT · Free-Form',
    );
  });

  it('is stable across exports, so a wiki diff does not churn', () => {
    expect(exportFlowMermaid(workspace, tabletopId)).toBe(mmd);
  });

  describe('matches index.html byte for byte, flow by flow', () => {
    for (const name of cases) {
      it(name, async () => {
        const { workspace: ws } = importLegacy(inputs[name]);
        const want = golden.cases[name];
        const got: Record<string, string> = {};
        for (const flowId of Object.keys(ws.flows)) {
          const text = exportFlowMermaid(ws, flowId, { chartId: want.chartId, ...CAPTURED });
          got[flowId] = (await sha256(text)).slice(0, 16);
        }
        expect(got).toEqual(want.flowMermaid);
      });
    }
  });
});
