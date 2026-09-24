/**
 * Variations on the demo workspace, for the parity tests against index.html.
 *
 * The demo as shipped exercises the chart half of the document exports and none of the flow half:
 * both of its flows are standalone, so a PowerPoint deck built from it has no flow slides at all,
 * and its roster never overflows the Ingest Kit's crib-sheet caps. These builders bend it into the
 * shapes that DO reach that code — anchored flows, a Chart-Linked flow bound at three tiers, a
 * signed chart, a free-form chart with hostile level names — so the same file can be opened in
 * index.html and imported here, and the two outputs compared.
 *
 * Plain data in, plain data out, and erasable TypeScript only: the headless capture script that
 * drives index.html imports this file directly with Node's type stripping, so the fixture a test
 * compares against is built by exactly the code the test runs.
 */

interface LegacyNode {
  id: string;
  name: string;
  raci: Record<string, string>;
  primaryR?: string;
  org?: Record<string, string>;
  children: LegacyNode[];
  [key: string]: unknown;
}

interface LegacyTask {
  id: string;
  name: string;
  kind?: string;
  raci: Record<string, string>;
  parties: Record<string, Record<string, string>>;
  bind?: { chartId: string; nodeId: string } | null;
  [key: string]: unknown;
}

interface LegacyFlow {
  id: string;
  name: string;
  mode?: string;
  status?: string;
  finalizedAt?: string | null;
  sourceChartId?: string | null;
  anchor: { chartId: string; nodeId: string } | null;
  tasks: LegacyTask[];
  edges: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

interface LegacyChart {
  id: string;
  title: string;
  framework?: string;
  status?: string;
  finalizedAt?: string | null;
  custom?: unknown;
  activities: LegacyNode[];
  [key: string]: unknown;
}

interface LegacyDivision {
  id: string;
  name: string;
  chief: { id: string; name: string } | null;
  branches: Array<{ id: string; name: string; chief: unknown; teams: unknown[] }>;
}

interface LegacyFile {
  charts: LegacyChart[];
  activeChartId?: string;
  bizCases: LegacyFlow[];
  artifacts: Array<Record<string, unknown>>;
  entities: Array<{ id: string; name: string; [key: string]: unknown }>;
  directorates: Record<string, { lead: unknown; divisions: LegacyDivision[] }>;
  columnLabels: Record<string, string>;
  columnShort: Record<string, string>;
  actorLabels: Record<string, string>;
  [key: string]: unknown;
}

const clone = (demo: unknown): LegacyFile => JSON.parse(JSON.stringify(demo)) as LegacyFile;

const blankRaci = (): Record<string, string> => ({
  hq: '',
  cos: '',
  mission: '',
  infra: '',
  cyber: '',
  sw: '',
  contacts: '',
});

function step(id: string, name: string, raci: Record<string, string>, x: number): LegacyTask {
  return {
    id,
    kind: 'task',
    name,
    raci: { ...blankRaci(), ...raci },
    parties: {},
    description: '',
    entry: '',
    exit: '',
    bind: null,
    bindOverrides: [],
    status: 'todo',
    x,
    y: 900,
    groupId: null,
  };
}

function edge(id: string, from: string, to: string, label: string, artifactIds: string[]) {
  return { id, from, to, label, artifactIds, fromPort: null, toPort: null, via: [] };
}

/**
 * The org chart signed and carrying flows: the tabletop anchored to a Task row and paginated past
 * one slide, the evidence procedure Chart-Linked and bound at Portfolio, Program and Project, an
 * empty flow, and one anchored to a different chart that must NOT appear.
 */
export function anchoredVariant(demo: unknown): LegacyFile {
  const s = clone(demo);
  const chart = s.charts[0]!;
  chart.title = 'ASIC <RACI> & "Tool" ’s demo';
  chart.status = 'final';
  chart.finalizedAt = '2026-03-04T15:30:00.000Z';

  const portfolio = chart.activities[0]!;
  const program = portfolio.children[0]!;
  const project = program.children[0]!;
  const task = project.children[0]!;
  const otherTask = project.children[1]!;
  task.name = "Task Activity 1 — it's <anchored>";

  // Labels a slide has to escape, and a directorate renamed away from its default.
  s.columnLabels.hq = 'Director & HQ <Ops>';
  s.columnShort.hq = 'D&HQ';
  s.actorLabels.cyber = 'Cyber "D"';

  const cyber = s.directorates.cyber!.divisions[0]!;
  const [board] = s.entities;

  const tabletop = s.bizCases[0]!;
  tabletop.anchor = { chartId: chart.id, nodeId: task.id };
  tabletop.status = 'final';
  tabletop.finalizedAt = '2026-03-05T09:00:00.000Z';
  const byName = (name: string) => tabletop.tasks.find((t) => t.name === name)!;
  // One explicit party at branch depth, one naming an entity, one at directorate depth only.
  byName('Contain').parties = {
    cyber: { actor: 'cyber', divisionId: cyber.id, branchId: cyber.branches[0]!.id },
  };
  byName('Declare Incident').parties = { hq: { entityId: board!.id } };
  byName('Recover').parties = { infra: { actor: 'infra' } };
  // Three more steps take the flow past the eight rows one slide holds.
  const aar = byName('After-Action Review');
  tabletop.tasks.push(
    step('t_par_notify', 'Notify stakeholders', { cos: 'R', hq: 'A', mission: 'I' }, 2300),
    step('t_par_risk', 'Update risk register', { mission: 'R', cos: 'C' }, 2600),
    step('t_par_close', '', { hq: 'RA' }, 2900),
  );
  tabletop.edges.push(
    edge('e_par_1', aar.id, 't_par_notify', 'Lessons agreed', ['a_rpt', 'a_scope']),
    edge('e_par_2', 't_par_notify', 't_par_risk', '', []),
    edge('e_par_3', 't_par_risk', 't_par_close', 'Residual risk accepted', ['a_decl']),
  );

  const evidence = s.bizCases[1]!;
  evidence.mode = 'linked';
  evidence.sourceChartId = chart.id;
  evidence.anchor = { chartId: chart.id, nodeId: otherTask.id };
  const [freeze, image, chain, hand] = evidence.tasks;
  freeze!.bind = { chartId: chart.id, nodeId: portfolio.id };
  image!.bind = { chartId: chart.id, nodeId: program.id };
  chain!.bind = { chartId: chart.id, nodeId: project.id };
  hand!.bind = { chartId: chart.id, nodeId: 'no-such-row' };
  // The fifth step stays unbound: "(not linked)".

  s.bizCases.push({
    id: 'b_par_empty',
    name: '',
    framework: 'raci',
    mode: 'free',
    status: 'draft',
    finalizedAt: null,
    anchor: { chartId: chart.id, nodeId: portfolio.id },
    tasks: [],
    edges: [],
    groups: [],
  });

  // A second chart, with a flow anchored to it: exporting the FIRST chart must leave it out.
  s.charts.push({
    id: 'c_par_other',
    title: 'Another chart',
    framework: 'raci',
    status: 'draft',
    finalizedAt: null,
    custom: null,
    drillPath: [],
    chartZoom: 1,
    chartSize: null,
    chartPos: {},
    activities: [
      {
        id: 'n_par_other',
        name: 'Elsewhere',
        raci: { ...blankRaci(), hq: 'A', cos: 'R' },
        children: [],
      },
    ],
  });
  s.bizCases.push({
    id: 'b_par_elsewhere',
    name: 'Anchored elsewhere',
    framework: 'raci',
    mode: 'free',
    anchor: { chartId: 'c_par_other', nodeId: 'n_par_other' },
    tasks: [step('t_par_else', 'Somewhere else', { hq: 'A', cos: 'R' }, 0)],
    edges: [],
    groups: [],
  });

  // Enough roster to overflow every cap the Ingest Kit's crib sheet applies.
  const vendor = s.directorates.vendor!;
  for (let i = vendor.divisions.length; i < 10; i++) {
    vendor.divisions.push({
      id: `dv_par_${i}`,
      name: i === 7 ? '' : `Vendor Division ${i}`,
      chief: null,
      branches: [],
    });
  }
  const wide = vendor.divisions[0]!;
  for (let i = wide.branches.length; i < 7; i++) {
    wide.branches.push({ id: `br_par_${i}`, name: `Vendor Branch ${i}`, chief: null, teams: [] });
  }
  const deep = wide.branches[0]!;
  for (let i = deep.teams.length; i < 6; i++) {
    deep.teams.push({
      id: `tm_par_${i}`,
      name: i === 5 ? '' : `Vendor Team ${i}`,
      chief: null,
      people: [],
    });
  }
  return s;
}

/**
 * A free-form RASCI chart in front: user-named levels that Excel would reject as sheet names, a
 * name that collides after sanitizing, a blank level, nesting past the named levels, a column with
 * no label, and a flow anchored into it.
 */
export function freeFormVariant(demo: unknown): LegacyFile {
  const s = clone(demo);
  const cols = [
    { key: 'sponsor', label: 'Executive Sponsor', short: 'SPON' },
    { key: 'pmo', label: 'Program Office <PMO>', short: '' },
    { key: 'legal', label: '', short: '' },
  ];
  const tiers = ['Initiative', 'Work/stream: *phase*', '   ', 'Initiative'];
  const node = (
    id: string,
    name: string,
    raci: Record<string, string>,
    children: LegacyNode[] = [],
    extra: Record<string, unknown> = {},
  ): LegacyNode => ({
    id,
    name,
    raci: { sponsor: '', pmo: '', legal: '', ...raci },
    children,
    ...extra,
  });

  const leaves: LegacyNode[] = [];
  for (let i = 1; i <= 15; i++) {
    leaves.push(
      node(`nf_leaf_${i}`, `Level-5 row ${i}`, i % 3 === 0 ? { legal: 'RS' } : { pmo: 'C' }),
    );
  }
  const activities = [
    node('nf_1', 'Initiative — Policy Refresh', { sponsor: 'A', pmo: 'R', legal: 'C' }, [
      node(
        'nf_2',
        'Workstream — Draft Directive',
        { pmo: 'RA', legal: 'RS' },
        [
          node('nf_3', 'Blank-named level', { legal: 'R' }, [
            node('nf_4', 'Fourth level', { sponsor: 'I' }, leaves),
          ]),
        ],
        { primaryR: 'legal' },
      ),
      node('nf_2b', 'Two doers, no primary', { sponsor: 'R', legal: 'R' }, [
        node('nf_3b', 'Inherits nothing', { pmo: 'C' }),
      ]),
    ]),
    node('nf_5', 'Initiative — Nobody owns this', { pmo: 'I' }),
  ];

  s.charts.push({
    id: 'c_par_free',
    title: 'Free-form <parity>',
    framework: 'rasci',
    status: 'draft',
    finalizedAt: null,
    custom: { cols, tiers },
    drillPath: [],
    chartZoom: 1,
    chartSize: null,
    chartPos: {},
    activities,
  });
  s.activeChartId = 'c_par_free';

  const evidence = s.bizCases[1]!;
  evidence.anchor = { chartId: 'c_par_free', nodeId: 'nf_3' };
  evidence.tasks[0]!.parties = { cyber: { entityId: 'e_does_not_exist' } };
  return s;
}
