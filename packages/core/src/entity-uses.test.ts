import { describe, it, expect } from 'vitest';
import demo from './__fixtures__/demo-workspace.json' with { type: 'json' };
import { importLegacy } from './legacy.js';
import { entityUsesInOrder } from './entity-uses.js';
import { keyBetween } from './fractional.js';
import type { ChartNode, Workspace } from './schema.js';

const { workspace } = importLegacy(demo);
const entityId = Object.values(workspace.entities)[0]!.id;
const chartId = Object.keys(workspace.charts)[0]!;
const tabletopId = Object.entries(workspace.flows).find(([, f]) => /Tabletop/.test(f.name))![0];

/** Rows of the demo chart in the order the tree shows them. */
function treeOrder(ws: Workspace): ChartNode[] {
  const nodes = Object.values(ws.charts[chartId]!.nodes);
  const out: ChartNode[] = [];
  const visit = (parentId: string | null) => {
    for (const n of nodes.filter((x) => x.parentId === parentId).sort((a, b) => (a.order < b.order ? -1 : 1))) {
      out.push(n);
      visit(n.id);
    }
  };
  visit(null);
  return out;
}

describe('entityUsesInOrder — index.html’s entityUses', () => {
  it('finds nothing for an entity nothing names (the demo’s two)', () => {
    for (const e of Object.values(workspace.entities)) expect(entityUsesInOrder(workspace, e.id)).toEqual([]);
  });

  it('counts a step once per column that names the entity, as the source does', () => {
    const ws = structuredClone(workspace);
    const step = Object.values(ws.flows[tabletopId]!.steps).find((s) => s.kind === 'step')!;
    step.parties = { hq: { entityId }, cos: { entityId }, cyber: { actor: 'cyber' } };
    const uses = entityUsesInOrder(ws, entityId);
    expect(uses).toHaveLength(2);
    expect(uses.every((u) => u.kind === 'flowStep' && u.stepId === step.id)).toBe(true);
    expect(uses[0]!.where).toMatch(/Tabletop/);
  });

  it('walks chart rows depth-first in tree order, not record order', () => {
    const ws = structuredClone(workspace);
    const rows = treeOrder(ws);
    const deep = rows[3]!;
    const first = rows[0]!;
    // Name the deep row first and the root row second, so record order and tree order disagree.
    ws.charts[chartId]!.nodes[deep.id]!.org = { entityId };
    ws.charts[chartId]!.nodes[first.id]!.org = { entityId };
    expect(entityUsesInOrder(ws, entityId).map((u) => u.nodeId)).toEqual([first.id, deep.id]);
  });

  it('uses the source’s fallbacks for unnamed places', () => {
    const ws = structuredClone(workspace);
    const chart = ws.charts[chartId]!;
    chart.title = '';
    const row = treeOrder(ws)[0]!;
    chart.nodes[row.id]!.name = '';
    chart.nodes[row.id]!.org = { entityId };
    const flow = ws.flows[tabletopId]!;
    flow.name = '';
    const step = Object.values(flow.steps).find((s) => s.kind === 'step')!;
    step.name = '';
    step.parties = { hq: { entityId } };
    const art = Object.values(ws.artifacts)[0]!;
    art.ownerRef = { entityId };

    const lines = entityUsesInOrder(ws, entityId).map((u) => `${u.where} › ${u.name}`);
    expect(lines).toEqual([
      'Untitled chart › (untitled)',
      'Untitled flow › (untitled step)',
      `Deliverables › ${art.name}`,
    ]);
  });

  it('lists charts in tab order', () => {
    const ws = structuredClone(workspace);
    const second = structuredClone(ws.charts[chartId]!);
    second.id = 'c_second';
    second.title = 'Second';
    for (const n of Object.values(second.nodes)) n.chartId = 'c_second';
    // Insert the new chart FIRST in record order but AFTER the demo chart in tab order.
    ws.charts = { c_second: second, ...ws.charts };
    ws.chartOrder = { ...ws.chartOrder, c_second: keyBetween(ws.chartOrder[chartId]!, null) };
    const row = treeOrder(ws)[0]!;
    ws.charts[chartId]!.nodes[row.id]!.org = { entityId };
    second.nodes[row.id]!.org = { entityId };
    expect(entityUsesInOrder(ws, entityId).map((u) => u.chartId)).toEqual([chartId, 'c_second']);
  });
});
