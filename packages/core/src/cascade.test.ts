import { describe, it, expect } from 'vitest';
import demo from './__fixtures__/demo-workspace.json' with { type: 'json' };
import { importLegacy } from './legacy.js';
import { cascadeCrumbs, pathToOpen, resolveCascade } from './cascade.js';
import { childrenOf, rootsOf } from './tree.js';
import { displayRaci, primaryDoerColumn } from './raci.js';
import { framework, COLS } from './constants.js';
import type { Chart } from './schema.js';

const { workspace } = importLegacy(demo);
const chart = Object.values(workspace.charts)[0]!;
const fw = framework('raci');

const root = rootsOf(chart.nodes)[0]!;
const program = childrenOf(chart.nodes, root.id)[0]!;
const project = childrenOf(chart.nodes, program.id)[0]!;
const task = childrenOf(chart.nodes, project.id)[0]!;

describe('the pane stack', () => {
  it('always has a top pane, even for a chart with no rows', () => {
    const empty = { ...chart, nodes: {} } as Chart;
    const cascade = resolveCascade(empty, []);
    expect(cascade.panes).toHaveLength(1);
    expect(cascade.panes[0]!.rows).toEqual([]);
    expect(cascade.panes[0]!.parent).toBeNull();
  });

  it('adds one pane per step of the drill path', () => {
    expect(resolveCascade(chart, []).panes).toHaveLength(1);
    expect(resolveCascade(chart, [root.id]).panes).toHaveLength(2);
    expect(resolveCascade(chart, [root.id, program.id]).panes).toHaveLength(3);
    expect(resolveCascade(chart, [root.id, program.id, project.id]).panes).toHaveLength(4);
  });

  it('marks the drilled row open on the pane it lives in, not the one it opens', () => {
    // The caret belongs on the row you clicked. Putting it on the new pane would leave the row
    // you opened looking closed.
    const cascade = resolveCascade(chart, [root.id, program.id]);
    expect(cascade.panes[0]!.openId).toBe(root.id);
    expect(cascade.panes[1]!.openId).toBe(program.id);
    expect(cascade.panes[2]!.openId).toBeNull();
  });

  it('shows each pane the children of the row above', () => {
    const cascade = resolveCascade(chart, [root.id]);
    expect(cascade.panes[0]!.rows.map((r) => r.id)).toEqual(rootsOf(chart.nodes).map((r) => r.id));
    expect(cascade.panes[1]!.parent!.id).toBe(root.id);
    expect(cascade.panes[1]!.rows.map((r) => r.id)).toEqual(
      childrenOf(chart.nodes, root.id).map((r) => r.id),
    );
  });

  it('stops at the chart’s depth limit rather than drilling past it', () => {
    // An org chart bottoms out at Task and continues into an anchored flow instead.
    const cascade = resolveCascade(chart, [root.id, program.id, project.id, task.id]);
    expect(cascade.panes).toHaveLength(4);
    expect(cascade.panes[3]!.isLeafTier).toBe(true);
    expect(cascade.trimmed).toBe(true);
  });

  it('drills without limit on a free-form chart', () => {
    const free = structuredClone(chart);
    free.custom = { cols: COLS.map((k) => ({ key: k, label: k, short: k })), tiers: [] } as never;
    const cascade = resolveCascade(free, [root.id, program.id, project.id, task.id]);
    expect(cascade.panes.length).toBeGreaterThan(4);
    expect(cascade.panes[3]!.isLeafTier).toBe(false);
  });
});

describe('a path that no longer resolves', () => {
  it('drops a step naming a row that is gone, and says it did', () => {
    // Someone else can delete the row you have open. A path still pointing at it would render an
    // empty pane under a live breadcrumb.
    const cascade = resolveCascade(chart, [root.id, 'n_deleted', project.id]);
    expect(cascade.path).toEqual([root.id]);
    expect(cascade.panes).toHaveLength(2);
    expect(cascade.trimmed).toBe(true);
  });

  it('reports the path it honoured, so a caller can write it back', () => {
    const good = resolveCascade(chart, [root.id, program.id]);
    expect(good.path).toEqual([root.id, program.id]);
    expect(good.trimmed).toBe(false);
  });

  it('survives a row whose parent points at itself', () => {
    const looped = structuredClone(chart);
    looped.nodes[program.id]!.parentId = program.id;
    expect(() => resolveCascade(looped, [root.id])).not.toThrow();
  });
});

describe('what cascades down', () => {
  it('carries the owner column from each drilled row’s primary doer', () => {
    const cascade = resolveCascade(chart, [root.id]);
    expect(cascade.panes[0]!.inheritedOwnerColumn).toBeNull(); // nothing above the top
    expect(cascade.panes[1]!.inheritedOwnerColumn).toBe(
      primaryDoerColumn(root, COLS, fw),
    );
  });

  it('passes the ancestor’s column through a row that designates no primary doer', () => {
    // Breaking the chain there would leave every row below unowned, which is the opposite of what
    // "the cascade continues from the nearest unambiguous row" means.
    const ws = structuredClone(chart);
    ws.nodes[root.id]!.raci = { hq: 'R' };
    ws.nodes[root.id]!.primaryR = null;
    ws.nodes[program.id]!.raci = { cos: 'R', mission: 'R' }; // two doers, none designated
    ws.nodes[program.id]!.primaryR = null;

    const cascade = resolveCascade(ws, [root.id, program.id]);
    expect(cascade.panes[1]!.inheritedOwnerColumn).toBe('hq');
    expect(cascade.panes[2]!.inheritedOwnerColumn).toBe('hq');
  });

  it('lets a deeper row replace the column it inherited', () => {
    const ws = structuredClone(chart);
    ws.nodes[root.id]!.raci = { hq: 'R' };
    ws.nodes[root.id]!.primaryR = null;
    ws.nodes[program.id]!.raci = { cyber: 'R' };
    ws.nodes[program.id]!.primaryR = null;

    const cascade = resolveCascade(ws, [root.id, program.id]);
    expect(cascade.panes[1]!.inheritedOwnerColumn).toBe('hq');
    expect(cascade.panes[2]!.inheritedOwnerColumn).toBe('cyber');
  });

  it('carries a division down, and lets a branch join it', () => {
    const ws = structuredClone(chart);
    const division = workspace.roster.cyber!.divisions[0]!;
    const branch = division.branches[0]!;
    ws.nodes[root.id]!.org = { actor: 'cyber', divisionId: division.id };
    ws.nodes[program.id]!.org = { actor: 'cyber', divisionId: division.id, branchId: branch.id };

    const cascade = resolveCascade(ws, [root.id, program.id]);
    expect(cascade.panes[0]!.inheritedOrg).toEqual({ division: null, branch: null });
    expect(cascade.panes[1]!.inheritedOrg.division).toEqual(ws.nodes[root.id]!.org);
    expect(cascade.panes[1]!.inheritedOrg.branch).toBeNull();
    // The branch joins; the division it sits in stays.
    expect(cascade.panes[2]!.inheritedOrg.branch).toEqual(ws.nodes[program.id]!.org);
    expect(cascade.panes[2]!.inheritedOrg.division).toEqual(ws.nodes[root.id]!.org);
  });

  it('ignores an entity ref — an entity is not a place in the org tree', () => {
    const ws = structuredClone(chart);
    ws.nodes[root.id]!.org = { entityId: 'ent_board' };
    const cascade = resolveCascade(ws, [root.id]);
    expect(cascade.panes[1]!.inheritedOrg).toEqual({ division: null, branch: null });
  });
});

describe('navigation helpers', () => {
  it('names the rows drilled through, top down', () => {
    const crumbs = cascadeCrumbs(resolveCascade(chart, [root.id, program.id]));
    expect(crumbs.map((c) => c.id)).toEqual([root.id, program.id]);
    expect(crumbs.map((c) => c.name)).toEqual([root.name, program.name]);
    expect(crumbs.map((c) => c.tier)).toEqual([0, 1]);
  });

  it('has no crumbs at the top', () => {
    expect(cascadeCrumbs(resolveCascade(chart, []))).toEqual([]);
  });

  it('builds the path that opens a given row — its ancestors, not itself', () => {
    // Opening a row means showing the pane its PARENT breaks down, with the row marked open.
    expect(pathToOpen(chart, task.id)).toEqual([root.id, program.id, project.id]);
    expect(pathToOpen(chart, root.id)).toEqual([]);
  });

  it('actually opens the row it was built for', () => {
    const cascade = resolveCascade(chart, pathToOpen(chart, task.id));
    const last = cascade.panes[cascade.panes.length - 1]!;
    expect(last.rows.map((r) => r.id)).toContain(task.id);
    expect(cascade.trimmed).toBe(false);
  });

  it('returns nothing for a row that is not there', () => {
    expect(pathToOpen(chart, 'n_nope')).toEqual([]);
  });
});

describe('the pane and the cells agree', () => {
  /**
   * The integration point most likely to drift.
   *
   * `resolveCascade` decides which column a pane's rows inherit their owner on; `displayRaci`
   * decides what each cell prints. They compute it independently, and if they ever disagree the
   * chart shows a dashed A in a column the breadcrumb says is owned by someone else — which looks
   * like data corruption and is not.
   *
   * The demo cannot exercise this: all 810 of its rows state an owner of their own, so nothing
   * there ever inherits one. It has to be built.
   */
  const inheriting = () => {
    const ws = structuredClone(chart);
    const r = rootsOf(ws.nodes)[0]!;
    const kid = childrenOf(ws.nodes, r.id)[0]!;
    ws.nodes[r.id]!.raci = { hq: 'A', cyber: 'R' };
    ws.nodes[r.id]!.primaryR = null;
    ws.nodes[kid.id]!.raci = { sw: 'C' }; // says nothing about ownership
    return { ws, rootId: r.id, kidId: kid.id };
  };

  it('prints the inherited owner in the column the pane says it cascades on', () => {
    const { ws, rootId, kidId } = inheriting();
    const pane = resolveCascade(ws, [rootId]).panes[1]!;
    expect(pane.inheritedOwnerColumn).toBe('cyber');

    const cells = displayRaci(ws, ws.nodes, kidId);
    expect(cells[pane.inheritedOwnerColumn!]!.letters).toContain(fw.owner);
    expect(cells[pane.inheritedOwnerColumn!]!.source).toBe('inherited');
  });

  it('keeps the row’s own letters explicit, and defaults the rest', () => {
    const { ws, kidId } = inheriting();
    const cells = displayRaci(ws, ws.nodes, kidId);
    expect(cells.sw!.letters).toBe('C');
    expect(cells.sw!.source).toBe('explicit');
    // Everything untouched reads as the Informed default — dimmed, not dashed.
    expect(COLS.filter((k) => cells[k]!.source === 'default')).toHaveLength(COLS.length - 2);
  });

  it('does not inherit onto a row that names an owner of its own', () => {
    // The commonest case in the demo, and the one that would look most wrong: a dashed A appearing
    // beside the row's own solid one.
    const { ws, rootId, kidId } = inheriting();
    ws.nodes[kidId]!.raci = { sw: 'A' };
    const cells = displayRaci(ws, ws.nodes, kidId);
    expect(cells.sw!.source).toBe('explicit');
    expect(COLS.filter((k) => cells[k]!.source === 'inherited')).toHaveLength(0);
    expect(resolveCascade(ws, [rootId]).panes[1]!.inheritedOwnerColumn).toBe('cyber');
  });
});
