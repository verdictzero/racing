import { describe, it, expect } from 'vitest';
import demo from './__fixtures__/demo-workspace.json' with { type: 'json' };
import { anchoredVariant } from './__fixtures__/parity-variants.js';
import { importLegacy } from './legacy.js';
import { legacySections, mergeLegacy, mergeToast, mergeWorkspace } from './merge.js';
import type { Workspace } from './schema.js';

/** The workspace after `additions` are loaded on top — what `loadWorkspace` leaves in the document. */
function applied(current: Workspace, additions: Workspace): Workspace {
  return {
    ...current,
    charts: { ...current.charts, ...additions.charts },
    chartOrder: { ...current.chartOrder, ...additions.chartOrder },
    flows: { ...current.flows, ...additions.flows },
    artifacts: { ...current.artifacts, ...additions.artifacts },
  };
}

/** Every id a workspace stores a record under, of every kind. */
function recordIds(ws: Workspace): string[] {
  const flows = Object.values(ws.flows);
  return [
    ...Object.keys(ws.charts),
    ...Object.values(ws.charts).flatMap((c) => Object.keys(c.nodes)),
    ...flows.map((f) => f.id),
    ...flows.flatMap((f) => [
      ...Object.keys(f.steps),
      ...Object.keys(f.edges),
      ...Object.keys(f.groups),
    ]),
    ...Object.keys(ws.artifacts),
  ];
}

/** Every reference in the workspace that does not land on a record of the right kind. */
function dangling(ws: Workspace): string[] {
  const out: string[] = [];
  const row = (ref: { chartId: string; nodeId: string }) =>
    !!ws.charts[ref.chartId]?.nodes[ref.nodeId];
  for (const chart of Object.values(ws.charts)) {
    for (const node of Object.values(chart.nodes)) {
      if (node.chartId !== chart.id) out.push(`node ${node.id} chartId`);
      if (node.parentId !== null && !chart.nodes[node.parentId]) out.push(`node ${node.id} parent`);
      for (const id of [...node.inputs, ...node.outputs])
        if (!ws.artifacts[id]) out.push(`node ${node.id} io ${id}`);
    }
  }
  for (const flow of Object.values(ws.flows)) {
    if (flow.anchor && !row(flow.anchor)) out.push(`flow ${flow.id} anchor`);
    if (flow.sourceChartId && !ws.charts[flow.sourceChartId])
      out.push(`flow ${flow.id} source chart`);
    for (const step of Object.values(flow.steps)) {
      if (step.flowId !== flow.id) out.push(`step ${step.id} flowId`);
      if (step.groupId && !flow.groups[step.groupId]) out.push(`step ${step.id} group`);
      if (step.bind && !row(step.bind)) out.push(`step ${step.id} bind`);
      if (step.kind === 'subflow') {
        const ref = step.refId ? ws.flows[step.refId] : undefined;
        if (!ref) out.push(`step ${step.id} refId`);
        for (const p of [...step.ports.in, ...step.ports.out])
          if (!ref?.steps[p]) out.push(`step ${step.id} port ${p}`);
      }
    }
    for (const edge of Object.values(flow.edges)) {
      if (edge.flowId !== flow.id) out.push(`edge ${edge.id} flowId`);
      if (!flow.steps[edge.from] || !flow.steps[edge.to]) out.push(`edge ${edge.id} ends`);
      for (const [end, port] of [
        [edge.from, edge.fromPort],
        [edge.to, edge.toPort],
      ] as const) {
        if (!port) continue;
        const ref = ws.flows[flow.steps[end]?.refId ?? ''];
        if (!ref?.steps[port]) out.push(`edge ${edge.id} port ${port}`);
      }
      for (const id of edge.artifactIds)
        if (!ws.artifacts[id]) out.push(`edge ${edge.id} artifact ${id}`);
    }
    for (const group of Object.values(flow.groups))
      if (group.flowId !== flow.id) out.push(`group ${group.id} flowId`);
  }
  return out;
}

describe('Merge', () => {
  const { workspace } = importLegacy(demo);

  describe('the demo into itself', () => {
    const result = mergeLegacy(workspace, demo);
    const merged = applied(workspace, result.additions);

    it('adds a second copy of every chart and flow, and says so as index.html does', () => {
      expect(result.summary).toEqual({ charts: 1, flows: 2 });
      expect(mergeToast(result.summary)).toBe(
        'Merged 1 chart(s) and 2 business case(s) into your workspace.',
      );
      expect(Object.keys(merged.charts)).toHaveLength(2);
      expect(Object.keys(merged.flows)).toHaveLength(4);
      const rows = (ws: Workspace) =>
        Object.values(ws.charts).reduce((n, c) => n + Object.keys(c.nodes).length, 0);
      expect(rows(merged)).toBe(2 * rows(workspace));
      const steps = (ws: Workspace) =>
        Object.values(ws.flows).reduce((n, f) => n + Object.keys(f.steps).length, 0);
      expect(steps(merged)).toBe(2 * steps(workspace));
    });

    it('re-mints EVERY id, rows and steps included, so nothing already stored is overwritten', () => {
      const before = new Set(recordIds(workspace));
      const added = recordIds(result.additions);
      expect(added.filter((id) => before.has(id))).toEqual([]);
      expect(new Set(added).size).toBe(added.length);
    });

    it('leaves every reference landing on a record', () => {
      expect(dangling(merged)).toEqual([]);
    });

    it('brings the merged chart to the front, in a new tab after the others', () => {
      const [chartId] = Object.keys(result.additions.charts);
      expect(result.activeChartId).toBe(chartId);
      const last = Object.values(workspace.chartOrder).sort().at(-1)!;
      expect(result.additions.chartOrder[chartId!]! > last).toBe(true);
    });

    it('maps each deliverable onto the one already registered, rather than adding a twin', () => {
      expect(result.additions.artifacts).toEqual({});
      const carried = Object.values(result.additions.flows).flatMap((f) =>
        Object.values(f.edges).flatMap((e) => e.artifactIds),
      );
      expect(carried.length).toBeGreaterThan(0);
      for (const id of carried) expect(workspace.artifacts[id]).toBeDefined();
    });

    it('points a nested-flow box at the COPY of the flow it references, sockets and all', () => {
      const flows = Object.values(result.additions.flows);
      const host = flows.find((f) => f.name === 'Cyber Incident Response (Tabletop)')!;
      const evidence = flows.find((f) => f.name === 'Evidence Preservation (procedure)')!;
      const box = Object.values(host.steps).find((s) => s.kind === 'subflow')!;
      expect(box.refId).toBe(evidence.id);
      // The handoffs into and out of the box name mating points inside the referenced flow, so
      // they have to follow its steps to their new ids too.
      const ported = Object.values(host.edges).filter((e) => e.fromPort || e.toPort);
      expect(ported).toHaveLength(3);
      for (const edge of ported) {
        for (const port of [edge.fromPort, edge.toPort])
          if (port) expect(evidence.steps[port]).toBeDefined();
      }
    });

    it('keeps the current labels and never touches the roster', () => {
      expect(result.additions.roster).toEqual({});
      expect(result.additions.entities).toEqual({});
      expect(result.additions.columnLabels).toEqual(workspace.columnLabels);
      expect(result.additions.actorLabels).toEqual(workspace.actorLabels);
    });

    it('can be merged again, beside the first copy rather than over it', () => {
      const again = mergeLegacy(merged, demo);
      const twice = applied(merged, again.additions);
      expect(Object.keys(twice.charts)).toHaveLength(3);
      expect(Object.keys(twice.flows)).toHaveLength(6);
      const stored = new Set(recordIds(merged));
      expect(recordIds(again.additions).filter((id) => stored.has(id))).toEqual([]);
      expect(dangling(twice)).toEqual([]);
    });
  });

  it('matches deliverables by trimmed, case-folded name AND type', () => {
    const file = {
      bizCases: [],
      artifacts: [
        { id: 'x1', name: '  triage REPORT ', type: 'document' }, // the demo's a_triage
        { id: 'x2', name: 'Triage Report', type: 'data' }, // same name, different type: new
        { id: 'x3', name: 'Brand new', type: 'data' },
        { id: 'x4', name: 'brand new', type: 'data' }, // the file's own twin: registered once
      ],
    };
    const { workspace: incoming } = importLegacy(file);
    const { additions } = mergeWorkspace(workspace, incoming, legacySections(file));
    const added = Object.values(additions.artifacts);
    expect(added.map((a) => [a.name, a.type])).toEqual([
      ['Triage Report', 'data'],
      ['Brand new', 'data'],
    ]);
    expect(added.every((a) => !['x2', 'x3', 'x4'].includes(a.id))).toBe(true);
  });

  it('carries an anchor to a chart the file did not bring only if it resolves in this workspace', () => {
    const chart = Object.values(workspace.charts)[0]!;
    const row = Object.values(chart.nodes).find((n) => n.parentId !== null)!;
    const flow = (id: string, anchor: { chartId: string; nodeId: string }) => ({
      id,
      name: id,
      anchor,
      tasks: [],
      edges: [],
    });
    const file = {
      bizCases: [
        flow('here', { chartId: chart.id, nodeId: row.id }),
        flow('gone-row', { chartId: chart.id, nodeId: 'no-such-row' }),
        flow('gone-chart', { chartId: 'c_elsewhere', nodeId: row.id }),
      ],
    };
    const result = mergeLegacy(workspace, file);
    // The file had no charts: importLegacy's placeholder is not merged.
    expect(result.summary).toEqual({ charts: 0, flows: 3 });
    expect(result.additions.charts).toEqual({});
    expect(result.activeChartId).toBeNull();
    const byName = Object.fromEntries(
      Object.values(result.additions.flows).map((f) => [f.name, f.anchor]),
    );
    expect(byName).toEqual({
      here: { chartId: chart.id, nodeId: row.id },
      'gone-row': null,
      'gone-chart': null,
    });
  });

  describe('a file whose flows hang off its own chart', () => {
    const variant = anchoredVariant(demo);
    const { workspace: current } = importLegacy(variant);
    const result = mergeLegacy(current, variant);
    const [copyId] = Object.keys(result.additions.charts).filter(
      (id) => result.additions.charts[id]!.title === current.charts['c_53jst3no']!.title,
    );
    const copy = result.additions.charts[copyId!]!;
    const flows = Object.values(result.additions.flows);

    it('anchors each merged flow to the matching row of the COPY', () => {
      const original = current.flows['b_080aooen']!.anchor!;
      const merged = flows.find((f) => f.name === 'Cyber Incident Response (Tabletop)')!.anchor!;
      expect(merged.chartId).toBe(copyId);
      expect(copy.nodes[merged.nodeId]!.name).toBe(
        current.charts[original.chartId]!.nodes[original.nodeId]!.name,
      );
      // The flow anchored to the file's OTHER chart follows that chart's copy instead.
      const elsewhere = flows.find((f) => f.name === 'Anchored elsewhere')!;
      expect(result.additions.charts[elsewhere.anchor!.chartId]!.title).toBe('Another chart');
    });

    it('rebinds Chart-Linked steps to the copy, keeping a broken bind broken rather than dropping it', () => {
      const linked = flows.find((f) => f.mode === 'linked')!;
      expect(linked.sourceChartId).toBe(copyId);
      const binds = Object.values(linked.steps).map((s) => s.bind);
      const resolved = binds.filter((b) => b && copy.nodes[b.nodeId]);
      expect(resolved).toHaveLength(3);
      expect(
        binds.filter((b) => b && b.chartId === copyId && b.nodeId === 'no-such-row'),
      ).toHaveLength(1);
      expect(binds.filter((b) => b === null)).toHaveLength(1);
    });

    it('leaves nothing else dangling', () => {
      const merged = applied(current, result.additions);
      expect(dangling(merged).filter((d) => !d.endsWith(' bind'))).toEqual([]);
    });
  });

  it('merges only the sections the file carried', () => {
    const chartsOnly = { charts: demo.charts };
    expect(legacySections(chartsOnly)).toEqual({ charts: true, flows: false, artifacts: false });
    expect(mergeLegacy(workspace, chartsOnly).summary).toEqual({ charts: 1, flows: 0 });
    // A pre-multi-chart file carries one chart at the top level.
    expect(legacySections({ title: 'Old', activities: [] }).charts).toBe(true);
    expect(legacySections({ charts: [], bizCases: [], artifacts: [] })).toEqual({
      charts: false,
      flows: false,
      artifacts: false,
    });
  });

  it('changes neither workspace it was given', () => {
    const { workspace: incoming } = importLegacy(demo);
    const before = JSON.stringify([workspace, incoming]);
    mergeWorkspace(workspace, incoming);
    expect(JSON.stringify([workspace, incoming])).toBe(before);
  });
});
