import { describe, it, expect } from 'vitest';
import demo from '../__fixtures__/demo-workspace.json' with { type: 'json' };
import { importLegacy } from '../legacy.js';
import { exportXml, stepIo } from './xml.js';
import { exportChartMermaid, exportFlowMermaid } from './mermaid.js';

const { workspace } = importLegacy(demo);
const chartId = Object.keys(workspace.charts)[0]!;
const tabletopId = Object.entries(workspace.flows).find(([, f]) => /Tabletop/.test(f.name))![0];

describe('XML export', () => {
  const xml = exportXml(workspace, { now: new Date('2026-08-31T00:00:00Z') });

  it('is well-formed enough to parse', () => {
    // No DOMParser in Node, so check the structural invariants that actually break consumers:
    // a declaration, one root, and balanced tags.
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml.match(/<raci\b/g)).toHaveLength(1);
    expect(xml.match(/<\/raci>/g)).toHaveLength(1);

    const opens = [...xml.matchAll(/<([a-z]+)(?:\s[^>]*?)?(?<!\/)>/g)].map((m) => m[1]);
    const closes = [...xml.matchAll(/<\/([a-z]+)>/g)].map((m) => m[1]);
    expect(opens.filter((t) => t !== 'xml').sort()).toEqual(closes.sort());
  });

  it('carries every row of the real 810-row demo', () => {
    const rows =
      (xml.match(/<portfolio\b/g)?.length ?? 0) +
      (xml.match(/<program\b/g)?.length ?? 0) +
      (xml.match(/<project\b/g)?.length ?? 0) +
      (xml.match(/<task\b/g)?.length ?? 0);
    expect(rows).toBe(810);
  });

  it('writes the resolved RACI, not just what the row states', () => {
    // A child that inherits its owner must still show it — the cascade is the whole point of the
    // chart, and an export that dropped it would be wrong in the way people would not notice.
    const chart = workspace.charts[chartId]!;
    const child = Object.values(chart.nodes).find((n) => n.parentId !== null && !n.raci.hq)!;
    expect(child).toBeDefined();
    const single = exportXml(workspace, { chartId });
    expect(single).toContain('<program');
  });

  it('escapes markup in names rather than emitting it', () => {
    const nasty = structuredClone(workspace);
    const chart = nasty.charts[chartId]!;
    const first = Object.values(chart.nodes)[0]!;
    first.name = 'Ampersand & <script>alert("x")</script>';
    const out = exportXml(nasty, { chartId });
    expect(out).not.toContain('<script>');
    expect(out).toContain('&amp;');
    expect(out).toContain('&lt;script&gt;');
  });

  it('nests an anchored flow under the row it implements', () => {
    const anchored = structuredClone(workspace);
    const chart = anchored.charts[chartId]!;
    const leaf = Object.values(chart.nodes).find(
      (n) => !Object.values(chart.nodes).some((c) => c.parentId === n.id),
    )!;
    anchored.flows[tabletopId]!.anchor = { chartId, nodeId: leaf.id };

    const out = exportXml(anchored, { chartId });
    expect(out).toContain('<flow name="Cyber Incident Response (Tabletop)"');
    expect(out).toContain('<step name="Detect &amp; Triage"');
    expect(out).toContain('<handoff ');
  });

  it('names the deliverables a handoff carries', () => {
    const anchored = structuredClone(workspace);
    const chart = anchored.charts[chartId]!;
    const leaf = Object.values(chart.nodes).find(
      (n) => !Object.values(chart.nodes).some((c) => c.parentId === n.id),
    )!;
    anchored.flows[tabletopId]!.anchor = { chartId, nodeId: leaf.id };
    const out = exportXml(anchored, { chartId });
    expect(out).toContain('Triage Report');
  });

  it('includes both registries', () => {
    expect(xml).toContain('<deliverables>');
    expect(xml).toContain('name="Incident Declaration"');
    expect(xml).toContain('<entities>');
    expect(xml).toContain('name="Cyber Review Board"');
  });

  it('is deterministic — the same workspace produces the same bytes', () => {
    const now = new Date('2026-08-31T00:00:00Z');
    expect(exportXml(workspace, { now })).toEqual(exportXml(workspace, { now }));
  });

  it('exports one chart when asked', () => {
    const single = exportXml(workspace, { chartId });
    expect(single.match(/<chart\b/g)).toHaveLength(1);
  });
});

describe('step IO derivation', () => {
  it('reads a step’s inputs and outputs off its handoffs, not off the step', () => {
    const flow = workspace.flows[tabletopId]!;
    const detect = Object.values(flow.steps).find((s) => s.name === 'Detect & Triage')!;
    const io = stepIo(flow, detect.id);
    // Detect produces the Triage Report on both its outgoing branches, and consumes nothing.
    expect(io.inputs).toEqual([]);
    expect(io.outputs.length).toBeGreaterThan(0);
    const names = io.outputs.map((a) => workspace.artifacts[a]!.name);
    expect(names).toContain('Triage Report');
  });

  it('deduplicates a deliverable carried on two edges out of one step', () => {
    const flow = workspace.flows[tabletopId]!;
    const detect = Object.values(flow.steps).find((s) => s.name === 'Detect & Triage')!;
    const io = stepIo(flow, detect.id);
    expect(new Set(io.outputs).size).toBe(io.outputs.length);
  });
});

describe('Mermaid — chart', () => {
  const mmd = exportChartMermaid(workspace, { chartId });

  it('starts with a comment header and a flowchart declaration', () => {
    expect(mmd.split('\n')[0]).toMatch(/^%% ASIC RACI Tool Demo — DRAFT/);
    expect(mmd.split('\n')[1]).toBe('flowchart TD');
  });

  it('emits a node per row and an edge per parent link', () => {
    const nodes = mmd.match(/^ {2}n\d+\[/gm) ?? [];
    const edges = mmd.match(/^ {2}n\d+ --> n\d+$/gm) ?? [];
    expect(nodes).toHaveLength(810);
    // Every row except the roots has exactly one parent edge.
    expect(edges).toHaveLength(810 - 11);
  });

  it('summarises only the owner and doer, not the whole matrix', () => {
    expect(mmd).toMatch(/A: /);
    expect(mmd).toMatch(/R: /);
    // C and I would make the boxes unreadable at diagram scale.
    expect(mmd).not.toMatch(/<br\/>C: /);
  });

  it('strips quotes and newlines that would end the label early', () => {
    const nasty = structuredClone(workspace);
    const first = Object.values(nasty.charts[chartId]!.nodes)[0]!;
    first.name = 'Says "hello"\nand more';
    const out = exportChartMermaid(nasty, { chartId });
    const line = out.split('\n').find((l) => l.includes('hello'))!;
    expect(line).toContain('&quot;hello&quot;');
    expect(line).not.toContain('\n and more');
  });

  it('can leave the palette out for a wiki with its own theme', () => {
    expect(exportChartMermaid(workspace, { chartId, includeStyles: false })).not.toContain('classDef');
  });
});

describe('Mermaid — flow', () => {
  const mmd = exportFlowMermaid(workspace, tabletopId);

  it('is a left-to-right graph', () => {
    expect(mmd.split('\n')[1]).toBe('flowchart LR');
  });

  it('renders a decision point as a diamond', () => {
    // Detect & Triage branches into confirmed-incident and false-positive.
    expect(mmd).toMatch(/s\d+\{"Detect &quot;?&amp;?.*?\}:::dec|s\d+\{"Detect/);
  });

  it('labels an edge with its condition and the deliverable it carries', () => {
    expect(mmd).toMatch(/-->\|"Confirmed incident — Triage Report"\|/);
  });

  it('is stable across exports, so a wiki diff does not churn', () => {
    expect(exportFlowMermaid(workspace, tabletopId)).toEqual(exportFlowMermaid(workspace, tabletopId));
  });

  it('returns an empty diagram rather than throwing for an unknown flow', () => {
    expect(exportFlowMermaid(workspace, 'b_nope')).toContain('flowchart LR');
  });
});

describe('shared step ordering', () => {
  it('declares steps in dependency order, so the source reads the way the flow runs', () => {
    const mmd = exportFlowMermaid(workspace, tabletopId);
    // Detect & Triage has no incoming handoff, so it must come first.
    const firstLine = mmd.split('\n').find((l) => l.startsWith('  s0'))!;
    expect(firstLine).toContain('Detect');
  });

  it('renders a nested flow as a subroutine, not a decision', () => {
    // "Preserve evidence" has two exits, so the plain out-degree rule would call it a decision.
    // It is a subroutine — it stands in for another whole flow — and the shape should say so.
    const mmd = exportFlowMermaid(workspace, tabletopId);
    const line = mmd.split('\n').find((l) => l.includes('Preserve evidence'))!;
    expect(line).toMatch(/\[\[".*"\]\]:::sub/);
    expect(line).not.toContain(':::dec');
  });

  it('still renders a real decision point as a diamond', () => {
    const mmd = exportFlowMermaid(workspace, tabletopId);
    const line = mmd.split('\n').find((l) => l.includes('Detect'))!;
    expect(line).toContain(':::dec');
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
    const mmd = exportFlowMermaid(looped, tabletopId);
    expect([...mmd.matchAll(/^ {2}s\d+[[{]/gm)]).toHaveLength(ids.length);
  });
});
