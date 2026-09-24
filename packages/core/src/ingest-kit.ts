/**
 * The LLM Data Ingest Kit.
 *
 * People arrive with a RACI in a spreadsheet, a slide, an email thread, a page of meeting notes —
 * and Load only accepts this tool's own JSON. Rather than write a parser per source format, the
 * kit hands the FORMAT to a language model: one self-contained Markdown briefing (the output
 * contract, the full schema, the rules the linter checks, a worked example) plus THIS workspace's
 * live vocabulary — column keys, directorate keys, roster ids, the charts, flows and deliverables
 * already there — so the model maps onto what exists instead of inventing parallel copies. The
 * person pastes it into any chat beside their raw material, and the reply is a file Load or Merge
 * accepts.
 *
 * This is index.html's `ingestKitMarkdown`, word for word, and the test holds it to the legacy's
 * own output byte for byte. The one input that is not the workspace is the date in the header,
 * which the legacy reads off the clock; here it is `opts.now`, so a test is not a clock test.
 *
 * The text describes the LEGACY file format on purpose: the reply is loaded through `importLegacy`,
 * and a model told about the flat model would write a file nothing reads.
 */

import {
  ACTOR_LABELS_DEFAULT,
  ACTORS,
  APP_NAME,
  APP_STAGE,
  APP_VERSION,
  ARTIFACT_TYPES,
  COLS,
  COL_LABELS_DEFAULT,
  COL_SHORT_DEFAULT,
  ENTITY_KINDS,
  FLOW_GROUP_COLORS,
  FRAMEWORKS,
  META_PRIORITIES,
  TIER_LABELS,
} from './constants.js';
import { rootsOf } from './tree.js';
import type { Workspace } from './schema.js';
import {
  actorLabel,
  chartsInTabOrder,
  columnLabel,
  columnShort,
  freeFormShape,
  resolvedAnchor,
} from './export/document-text.js';

const MD_FENCE = '```';

/** index.html's `defaultColumnActor`: a column that shares a directorate's key maps to it. */
function defaultColumnActor(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const k of COLS) out[k] = (ACTORS as readonly string[]).includes(k) ? k : null;
  return out;
}

/**
 * The worked example: every structure the importer understands, at least once.
 *
 * Built from the default label tables rather than the workspace's, so a column renamed here never
 * contradicts the schema section above it. Key order matters — it is serialized into the kit.
 */
function ingestExample(): Record<string, unknown> {
  return {
    _notes:
      'Optional scratchpad: assumptions made, source rows that could not be mapped. Unknown top-level keys are carried through untouched.',
    charts: [
      {
        id: 'c_org',
        title: 'EXAMPLE — Org RACI chart',
        framework: 'raci',
        custom: null,
        drillPath: [],
        chartZoom: 1,
        chartSize: null,
        chartPos: {},
        activities: [
          {
            id: 'n_pf1',
            name: 'Portfolio — Modernize Logistics',
            raci: {
              hq: 'A',
              cos: 'C',
              mission: 'I',
              infra: 'I',
              cyber: 'I',
              sw: 'R',
              contacts: 'I',
            },
            status: 'doing',
            description:
              'Tier 1. Exactly one A. The R on this row cascades down as the next tier’s A.',
            inputs: [],
            outputs: ['a_brief'],
            documents: [],
            children: [
              {
                id: 'n_prog1',
                name: 'Program — Inventory Platform',
                raci: {
                  hq: 'I',
                  cos: 'I',
                  mission: 'R',
                  infra: 'C',
                  cyber: 'I',
                  sw: 'R',
                  contacts: 'I',
                },
                status: 'doing',
                primaryR: 'sw',
                description: 'Two R’s on one row: primaryR names which R becomes the children’s A.',
                org: { actor: 'sw', divisionId: 'd_sw_sus' },
                inputs: [],
                outputs: [],
                documents: [],
                children: [
                  {
                    id: 'n_proj1',
                    name: 'Project — Barcode Scanning',
                    raci: {
                      hq: 'I',
                      cos: 'I',
                      mission: 'C',
                      infra: 'I',
                      cyber: 'C',
                      sw: 'R',
                      contacts: 'I',
                    },
                    status: 'todo',
                    description:
                      'Project rows sit on a Branch — one level deeper than the Program’s Division.',
                    org: { actor: 'sw', divisionId: 'd_sw_sus', branchId: 'br_sw_scan' },
                    inputs: [],
                    outputs: [],
                    documents: [],
                    children: [
                      {
                        id: 'n_task1',
                        name: 'Task — Integrate scanner SDK',
                        raci: {
                          hq: 'I',
                          cos: 'I',
                          mission: 'I',
                          infra: 'I',
                          cyber: 'C',
                          sw: 'R',
                          contacts: 'I',
                        },
                        status: 'doing',
                        description:
                          'Deepest org-chart tier, and the anchor target of the flow below.',
                        inputs: ['a_sdk'],
                        outputs: ['a_test'],
                        documents: [],
                        children: [],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        id: 'c_free',
        title: 'EXAMPLE — Free-form chart (source’s own parties)',
        framework: 'rasci',
        custom: {
          cols: [
            { key: 'sponsor', label: 'Executive Sponsor', short: 'SPON' },
            { key: 'pmo', label: 'Program Office', short: 'PMO' },
            { key: 'legal', label: 'Legal Review', short: 'LEG' },
          ],
          tiers: ['Initiative', 'Workstream', 'Action'],
        },
        drillPath: [],
        chartZoom: 1,
        chartSize: null,
        chartPos: {},
        activities: [
          {
            id: 'nf_1',
            name: 'Initiative — Policy Refresh',
            raci: { sponsor: 'A', pmo: 'R', legal: 'C' },
            status: 'todo',
            description: 'Free-form charts key raci by custom.cols keys and nest to any depth.',
            inputs: [],
            outputs: [],
            documents: [],
            children: [
              {
                id: 'nf_2',
                name: 'Workstream — Draft Directive',
                raci: { sponsor: 'I', pmo: 'A', legal: 'RS' },
                status: 'doing',
                description: 'RASCI adds S (Support); a cell may hold several letters.',
                inputs: [],
                outputs: [],
                documents: [],
                children: [],
              },
            ],
          },
        ],
      },
    ],
    activeChartId: 'c_org',
    bizCases: [
      {
        id: 'b_sdk',
        name: 'EXAMPLE — SDK Integration (anchored flow)',
        description:
          'Anchored to a Task row: the chart’s owner cascades in and flow health rolls up onto that row.',
        framework: 'raci',
        anchor: { chartId: 'c_org', nodeId: 'n_task1' },
        showTable: false,
        view: { panX: 0, panY: 0, zoom: 1 },
        tasks: [
          {
            id: 't_req',
            name: 'Request vendor SDK',
            raci: { hq: '', cos: '', mission: '', infra: '', cyber: '', sw: 'I', contacts: 'R' },
            parties: { contacts: { actor: 'vendor', divisionId: 'd_ven_primes' } },
            description: 'No explicit A — the anchor row’s owner is inherited and shown dashed.',
            entry: 'Contract vehicle in place',
            exit: 'SDK package received',
            status: 'done',
            x: 40,
            y: 60,
          },
          {
            id: 't_sec',
            name: 'Security review',
            raci: { hq: '', cos: '', mission: '', infra: '', cyber: 'R', sw: 'A', contacts: '' },
            parties: { cyber: { actor: 'cyber', divisionId: 'd_cyb_soc', branchId: 'br_cyb_ir' } },
            description:
              'Decision point — its two outgoing edges carry the branch conditions. The explicit A sits on the column the anchor row cascades down, so it confirms the inherited owner rather than overriding it.',
            entry: 'SDK package received',
            exit: 'Security memo signed',
            status: 'doing',
            x: 380,
            y: 60,
          },
          {
            id: 't_int',
            name: 'Integrate & test',
            raci: { hq: '', cos: '', mission: '', infra: '', cyber: 'C', sw: 'R', contacts: '' },
            parties: { sw: { actor: 'sw', divisionId: 'd_sw_sus', branchId: 'br_sw_scan' } },
            description: '',
            entry: 'Security memo signed',
            exit: 'Test suites green',
            status: 'todo',
            x: 720,
            y: 60,
          },
        ],
        edges: [
          { id: 'e1', from: 't_req', to: 't_sec', label: '', artifactIds: ['a_sdk'] },
          { id: 'e2', from: 't_sec', to: 't_int', label: 'approved', artifactIds: ['a_memo'] },
          {
            id: 'e3',
            from: 't_sec',
            to: 't_req',
            label: 'rejected — rework',
            artifactIds: ['a_memo'],
          },
        ],
      },
    ],
    activeBizCaseId: 'b_sdk',
    artifacts: [
      {
        id: 'a_sdk',
        name: 'SDK package',
        type: 'document',
        ownerRef: null,
        description: 'Vendor-delivered bundle.',
        doc: null,
      },
      {
        id: 'a_memo',
        name: 'Security memo',
        type: 'approval',
        ownerRef: { actor: 'cyber', divisionId: 'd_cyb_soc' },
        description: '',
        doc: null,
      },
      {
        id: 'a_test',
        name: 'Test report',
        type: 'data',
        ownerRef: null,
        description: '',
        doc: null,
      },
      {
        id: 'a_brief',
        name: 'Portfolio brief',
        type: 'briefing',
        ownerRef: null,
        description: '',
        doc: null,
      },
    ],
    directorates: {
      ocio: {
        lead: { id: 'L_ocio', name: 'Lead Example' },
        divisions: [{ id: 'd_ocio_gov', name: 'Governance Division', chief: null, branches: [] }],
      },
      mission: { lead: null, divisions: [] },
      infra: { lead: null, divisions: [] },
      cyber: {
        lead: null,
        divisions: [
          {
            id: 'd_cyb_soc',
            name: 'SOC Division',
            chief: null,
            branches: [
              {
                id: 'br_cyb_ir',
                name: 'Incident Response Branch',
                chief: null,
                teams: [
                  {
                    id: 'tm_ir_watch',
                    name: 'Watch Floor Team',
                    chief: null,
                    people: [{ id: 'p_ir_1', name: 'Person Example', title: 'IR Lead' }],
                  },
                ],
              },
            ],
          },
        ],
      },
      sw: {
        lead: null,
        divisions: [
          {
            id: 'd_sw_sus',
            name: 'Sustainment Systems Division',
            chief: { id: 'ch_sw', name: 'Chief Example' },
            branches: [{ id: 'br_sw_scan', name: 'Scanning Branch', chief: null, teams: [] }],
          },
        ],
      },
      vendor: {
        lead: null,
        divisions: [
          { id: 'd_ven_primes', name: 'Prime Contractors Division', chief: null, branches: [] },
        ],
      },
    },
    actorLabels: { ...ACTOR_LABELS_DEFAULT },
    columnLabels: { ...COL_LABELS_DEFAULT },
    columnShort: { ...COL_SHORT_DEFAULT },
    columnActor: defaultColumnActor(),
    viewMode: 'chart',
    showLegend: false,
    rosterMode: 'explore',
    collapsedDirectorates: {},
    workScope: null,
  };
}

/**
 * The roster as an id crib sheet — `ingestRosterOutline`. Capped, so a deep org does not swamp the
 * model's context; people are left out because an org ref never points at a person.
 */
function rosterOutline(ws: Workspace): string[] {
  const CAP = { div: 8, br: 5, tm: 4 };
  const out: string[] = [];
  const more = (list: readonly unknown[], cap: number, what: string, pad: string) => {
    if (list.length > cap) out.push(`${pad}… and ${list.length - cap} more ${what}`);
  };
  for (const a of ACTORS) {
    const d = ws.roster[a];
    const lead = d?.lead && d.lead.name ? ` — lead: ${d.lead.name}` : '';
    out.push(`- **${a}** · "${actorLabel(ws, a)}"${lead}`);
    const divs = d?.divisions ?? [];
    if (!divs.length) {
      out.push('    (no divisions yet)');
      continue;
    }
    for (const div of divs.slice(0, CAP.div)) {
      out.push(`    - divisionId \`${div.id}\` · ${div.name || '(unnamed)'}`);
      for (const br of div.branches.slice(0, CAP.br)) {
        out.push(`        - branchId \`${br.id}\` · ${br.name || '(unnamed)'}`);
        for (const tm of br.teams.slice(0, CAP.tm)) {
          out.push(`            - teamId \`${tm.id}\` · ${tm.name || '(unnamed)'}`);
        }
        more(br.teams, CAP.tm, 'teams', '            ');
      }
      more(div.branches, CAP.br, 'branches', '        ');
    }
    more(divs, CAP.div, 'divisions', '    ');
  }
  return out;
}

/**
 * The raw column → directorate mapping as the kit prints it: the stored value, or the legacy's
 * default for a column the workspace does not mention (see `columnDirectorate` for why).
 */
function mappedDirectorate(ws: Workspace, column: string): string | null {
  if (Object.hasOwn(ws.columnActor, column)) return ws.columnActor[column] || null;
  return defaultColumnActor()[column] ?? null;
}

export interface IngestKitOptions {
  /** When the kit was generated — printed in its header. Defaults to now. */
  readonly now?: Date;
}

/** The kit, as the Markdown text index.html downloads as `raci-ingest-kit.md`. */
export function ingestKitMarkdown(ws: Workspace, opts: IngestKitOptions = {}): string {
  const F = MD_FENCE;
  const L: string[] = [];
  const p = (...xs: string[]) => {
    for (const x of xs) L.push(x);
  };
  const fw2 = (k: string) => {
    const f = FRAMEWORKS[k]!;
    return `${f.name} (${f.roles.join(' ')}) — owner ${f.owner}, doer ${f.doer}`;
  };
  const today = (opts.now ?? new Date()).toISOString().slice(0, 10);

  p(
    `# ${APP_NAME} — LLM Data Ingest Kit`,
    '',
    `Generated by ${APP_NAME} ver ${APP_VERSION} ${APP_STAGE} on ${today}.`,
    '',
    'This one file is everything a language model needs to turn loose source material — a',
    'spreadsheet, a slide, an email thread, a page of meeting notes, an existing RACI table — into',
    'a JSON file this app can open.',
    '',
    '---',
    '',
    '## How to use it',
    '',
    '1. Open any LLM chat. Attach or paste **this entire file**.',
    '2. Attach or paste **your source material** in whatever shape it is already in.',
    '3. Send the prompt below.',
    '4. Save the reply as `my-raci.json`.',
    `5. Back in ${APP_NAME}: **📂 Load** to replace the workspace, or **⧉ Merge** to add it alongside`,
    '   what you already have.',
    '',
    '### The prompt',
    '',
    F,
    'Convert the attached source material into one import file for the ASIC RACI Tool, using the',
    'Data Ingest Kit as your schema reference. Follow its output contract exactly: reply with the',
    'JSON document and nothing else. Prefer the ids and column/directorate keys the kit lists as',
    'already existing in the workspace over inventing new ones. Do not invent responsibilities the',
    'source does not state — leave a cell empty rather than guessing, and list anything you could',
    'not map in the _notes field.',
    F,
    '',
    '---',
    '',
    '## 1. Output contract',
    '',
    '- Emit **exactly one JSON object**. No prose before or after, no markdown code fence, no',
    '  trailing commentary, no comments inside the JSON (`//` and `/* */` are not valid JSON).',
    '- Every top-level section is **optional**. Anything omitted is filled in with defaults, so a',
    '  file containing only `charts` is a perfectly valid import.',
    '- **Ids are free-form strings** and only need to be unique and consistent *within this file*.',
    '  The app re-keys nothing; it just resolves the references you write.',
    '- **Never invent facts.** If the source does not say who is Accountable, leave the cell `""`.',
    '  An empty cell renders as Informed and is flagged by the linter for a human to fix — that is',
    '  the correct outcome, and far better than a confident wrong owner.',
    '- Unknown top-level keys are carried through untouched, so `_notes` is a safe place to record',
    '  assumptions, ambiguities, and source rows you could not map.',
    '- Dangling references never break an import: unknown artifact ids are dropped, unknown org',
    '  refs and anchors degrade gracefully (the flow simply becomes standalone).',
    '',
    '---',
    '',
    '## 2. The model in one paragraph',
    '',
    'A **chart** is a nested responsibility matrix: rows are activities, columns are parties, cells',
    'hold role letters. Rows nest, and ownership **cascades** — the party marked *Responsible* on a',
    'row becomes *Accountable* for that row’s children, which is what makes the matrix a hierarchy',
    'rather than a flat table. A **business case** is a task-flow graph of steps and directed',
    'handoffs, optionally *anchored* to one deepest-tier chart row ("this flow is how that task',
    'actually gets done"). An **artifact** is a named real-world deliverable, referenced by id from',
    'chart-row inputs/outputs and from the handoffs that carry it. The **directorates** block is the',
    'org roster that chart rows and flow steps point at to name the executing unit.',
    '',
    '---',
    '',
    '## 3. Schema reference',
    '',
    '### 3.1 `charts[]`',
    '',
    'Two kinds, distinguished by `custom`:',
    '',
    '**Org chart** (`custom: null`) — fixed 4 tiers, `' +
      TIER_LABELS.join(' → ') +
      '`, expressed as',
    'nested `children[]`. Deeper levels are trimmed on import. `raci` is keyed by the seven fixed',
    'org column keys: `' + COLS.join('`, `') + '`.',
    '',
    '**Free-form chart** (`custom: {...}`) — organization-agnostic. `custom.cols` is',
    '`[{key,label,short}]` and `raci` is keyed by **those** keys; `custom.tiers` names the levels',
    '(sparse; missing entries auto-name "Level N"); nesting depth is unlimited. Free-form rows carry',
    'no org refs and never appear in the Tasks view.',
    '',
    'Chart fields: `id`, `title`, `framework` (`raci` | `rasci`), `custom`, `activities[]`, plus',
    'optional view state `drillPath` (node-id chain to open drilled), `chartZoom` (0.4–2.5),',
    '`chartSize` (`{w,h}` | null), `chartPos` (`{tierIndex:{x,y}}` for dragged panes).',
    '',
    '**Node fields** — `name`, `raci`, `children[]` carry the structure; everything else optional:',
    '',
    '| Field | Meaning |',
    '| --- | --- |',
    '| `name` | Row label. |',
    '| `raci` | `{columnKey: "letters"}`. A cell is a **string**, and may hold several letters (`"RA"`, `"CI"`). Blank/missing reads as Informed. |',
    '| `children[]` | Rows one tier down. |',
    '| `description` | Free text shown in the Details rail. |',
    '| `status` | `todo` \\| `doing` \\| `done`. |',
    '| `primaryR` | Column key. **Required whenever a row has 2+ doers** — names which one cascades down as the children’s owner. |',
    '| `org` | `{actor, divisionId, branchId?, teamId?}` — the executing unit badge. `divisionId` is required or the ref is dropped. Org charts only. |',
    '| `inputs` / `outputs` | Arrays of artifact ids — what the row consumes and produces. |',
    '| `documents` | `[{id,name,type,size,dataUrl}]` with a base64 `dataUrl`. Usually leave `[]`. |',
    '',
    '**Legacy shape:** a file with top-level `{title, activities}` and no `charts[]` still loads — it',
    'is wrapped into `charts[0]` automatically. Prefer `charts[]` for anything new.',
    '',
    '### 3.2 `bizCases[]` — business case task flows',
    '',
    'Fields: `id`, `name`, `description`, `framework` (always `raci` — omit it), `mode`,',
    '`sourceChartId`, `anchor`, `tasks[]`, `edges[]`, `groups[]`, `view {panX,panY,zoom}`, `showTable`.',
    '',
    '- `mode` is `"free"` or `"linked"` and decides what the steps are allowed to say. Omit it and',
    '  the flow loads as `"free"`. **Default to `"free"` unless the source material really does map',
    '  each step onto a chart row** — a half-linked flow is worse than an honest free-form one.',
    '- `anchor: {chartId, nodeId}` ties the flow to one deepest-tier chart row — owner and default',
    '  parties then cascade in, and flow health rolls up onto that row. `anchor: null` keeps it a',
    '  standalone tabletop exercise. Independent of `mode`: `anchor` is about the WHOLE flow,',
    '  `bind` (below) is about ONE step.',
    '- `tasks[]` are the step boxes: `raci` keyed by the **seven org column keys** (flows always use',
    '  those, even when anchored to a free-form chart); `parties` maps a column key → a roster ref',
    '  `{actor, divisionId?, branchId?, teamId?}` naming who executes that column’s role;',
    '  `description` / `entry` / `exit` are the card’s three text blocks; `status`; `x`/`y` canvas',
    '  position in pixels (space steps ~300–350 apart so edges stay readable).',
    '',
    '**Chart-Linked mode.** When `mode: "linked"`, every step should carry',
    '`bind: {chartId, nodeId}` — the org-chart row it implements. The step then READS that row’s',
    'RACI instead of declaring its own, so **leave its `raci` cells empty**: whatever you write',
    'there is ignored unless the column is also listed in `bindOverrides`. A step with no `bind` in',
    'a linked flow is flagged as an error in the app.',
    '',
    '- The row may sit at **any tier** — Portfolio, Program, Project or Task — and the tier is the',
    '  point: a Portfolio row leaves the step’s parties at directorate depth, a Project row',
    '  carrying a Branch narrows the same columns to that Branch. Pick the tier that matches how',
    '  specifically the source material assigns the work.',
    '- `bind.chartId` must name an **organization** chart (one with no `custom` block). Free-form',
    '  charts define their own party columns and cannot be linked to.',
    '- `bindOverrides: []` lists column keys the step takes back from the row. A listed column reads',
    '  `raci[col]` verbatim — including `""`, which means “this step deliberately has no role here,',
    '  whatever the row says”. Use it sparingly: every override is a warning in the app, because it',
    '  is a place where the flow no longer matches the chart.',
    '- `sourceChartId` is the chart the row picker offers by default. Set it to the same chart the',
    '  binds use. It is a convenience only — the binds are self-describing.',
    '- `edges[]` are directed handoffs `{id, from, to, label, artifactIds, fromPort, toPort}`',
    '  between task ids. `label` is the branch condition on a decision point (`"Yes"`,',
    '  `"rejected — rework"`); `artifactIds` names what changes hands. Self-loops are dropped, and',
    '  duplicates are judged on `from`+`fromPort`+`to`+`toPort` — two handoffs between the same two',
    '  boxes are distinct when they use different mating points. A step’s own IO is **derived**',
    '  from its edges — never store it on the task.',
    '',
    '**Nested flows.** A task with `kind: "subflow"` is not a step — it is a *reference* to another',
    'business case: `{kind:"subflow", refId, ports:{in:[],out:[]}, name, description, x, y, groupId}`.',
    'It carries no `raci` of its own (the roles live in the referenced flow, and a copy here would',
    'drift). `refId` is another `bizCases[].id`; a reference loop (A nests B nests A) is rejected.',
    '`ports.in` / `ports.out` are step ids **inside the referenced flow** — which of its entry and',
    'exit points this host exposes as mating points. Leave them `[]` for “all of them”, which is',
    'also what keeps the box following the referenced flow as it gains entries and exits. Edges',
    'name the specific one through `fromPort` / `toPort`.',
    '',
    '**Groups.** `groups[]` are labelled frames around steps that stay in this flow:',
    '`{id, name, color, collapsed, x, y}` with `color` one of `' +
      FLOW_GROUP_COLORS.join('` | `') +
      '`.',
    'Membership is one field on the step — `task.groupId` — and a step belongs to at most one frame.',
    'An expanded frame is drawn from its members’ bounding box, so `x`/`y` only matter while it is',
    'collapsed. A collapsed frame’s sockets are derived from the edges that actually cross its',
    'boundary; there is nothing to store for them.',
    '',
    '### 3.3 `artifacts[]` — the deliverable registry',
    '',
    'One entry per real-world deliverable, referenced by id everywhere else.',
    '`{id, name, type, ownerRef, description, doc}` with `type` one of',
    '`' + ARTIFACT_TYPES.join('` | `') + '`. `ownerRef` is a roster ref or null.',
    'On **Merge**, artifacts dedupe by `name` + `type`, so reusing an existing deliverable’s exact',
    'name is how you connect a new flow to work that is already in the workspace.',
    '',
    '### 3.4 `entities[]` — non-person parties',
    '',
    'Parties that are neither people nor directorates: boards, committees, vendors, standing teams.',
    '`{id, name, kind, short, description, lead}` with `kind` one of',
    '`' + ENTITY_KINDS.join('` | `') + '`, and `lead` either `{id,name}` or null.',
    'Flat by design — an entity has no divisions and no people under it.',
    'Browsed and edited in the **Object Gallery**, alongside `artifacts[]`.',
    'Anywhere a party can be named (`org` on a chart row, `parties[col]` on a step, `workScope`,',
    'an artifact `ownerRef`) a ref of the form `{entityId: "e_…"}` is accepted in place of a roster ref.',
    'A ref to an id that is not in `entities[]` is kept and renders as “(missing entity)”.',
    '',
    '### 3.5 `meta` — chart and flow metadata',
    '',
    'Charts and business cases each carry the same block:',
    '`{description, customer, priority, budget, tags: []}` with `priority` one of',
    '`' + META_PRIORITIES.filter(Boolean).join('` | `') + '` or `""`.',
    'Every field is matched by the filter boxes and carried into the XML and Excel exports.',
    'A pre-0.36 business case with a top-level `description` string has it folded into',
    '`meta.description` on load.',
    '',
    '### 3.6 `directorates` — the roster',
    '',
    'Exactly these six keys: `' + ACTORS.join('`, `') + '`. Each is',
    '`{lead: {id,name} | null, divisions: [...]}`, a division is',
    '`{id, name, chief, branches: [...]}`, a branch is `{id, name, chief, teams: [...]}`, a team is',
    '`{id, name, chief, people: [{id, name, title}]}`. Depth is optional at every level — divisions',
    'may have no branches, branches no teams.',
    '',
    '### 3.7 The Excel route',
    '',
    'A chart can arrive as a workbook instead of JSON. **📗 Import Excel** in the toolbar offers both',
    'directions: import a filled-in workbook, or download the blank template to fill in first.',
    'One sheet holds the tree: the first columns are named for the tiers',
    '(`' + TIER_LABELS.join('`, `') + '`), the columns after them are the parties, and each row',
    'repeats its ancestors with the deepest filled cell naming the row being defined. Naming a',
    "parent on a child row creates it. Party headers become the chart's column labels.",
    'Optional `Entities` and `Document` sheets carry the entity registry and the metadata block.',
    'A workbook always lands as a NEW chart tab, so Load and Merge do the same thing with one.',
    '',
    '### 3.8 Labels, mappings and view preferences',
    '',
    '- `actorLabels` — display name per directorate key.',
    '- `columnLabels` / `columnShort` — full and abbreviated header per org column key. **This is how',
    '  you fit source parties onto an org chart without a free-form chart.**',
    '- `columnActor` — org column key → directorate key (or null); powers roster-linked defaults.',
    '- `viewMode` (`chart`|`roster`|`bizcase`|`work`|`help`), `activeChartId`, `activeBizCaseId`,',
    '  `showLegend`, `rosterMode` (`explore`|`full`), `collapsedDirectorates`, `workScope`.',
    '',
    '---',
    '',
    '## 4. Choosing the chart kind',
    '',
    'Read the source’s party columns first, then pick **one**:',
    '',
    '- The source’s parties **map cleanly onto the seven org columns** (roughly: a headquarters, a',
    '  chief of staff, four delivery directorates, a contracting office) → build an **org chart** and',
    '  rename the headers via `columnLabels` / `columnShort`. You keep the roster links, the org',
    '  badges, the Tasks view, and the anchored-flow machinery.',
    '- The source’s parties are **something else entirely** (vendors, committees, IPTs, agencies, or',
    '  simply a different count) → build a **free-form chart** with `custom.cols`. You give up roster',
    '  links and org badges, and gain arbitrary columns and unlimited depth.',
    '- Do not squeeze eight parties into seven columns, and do not leave columns labelled for units',
    '  the source never mentions. Either is worse than a free-form chart.',
    '',
    '---',
    '',
    '## 5. Frameworks and role letters',
    '',
    'Charts: `raci` or `rasci`. Flows: always `raci`.',
    '',
  );
  for (const k of Object.keys(FRAMEWORKS)) p(`- \`${k}\` — ${fw2(k)}. ${FRAMEWORKS[k]!.blurb}`);
  p(
    '',
    'Letters are uppercase; a cell may hold more than one (`"RA"`). Letters outside the chosen',
    'framework are preserved on import but flagged by the linter, so stick to that framework’s set.',
    '',
    '---',
    '',
    '## 6. Rules the app checks on load',
    '',
    'These are the linter’s actual checks. Satisfy them in the file you produce and the import lands',
    'clean; a violation is flagged for a human, never blocked.',
    '',
    '**Chart rows**',
    '',
    '1. **One owner per row.** Two or more `A` cells on a row is an *error* — the only hard error.',
    '2. **Every row has an owner**, explicit or inherited from the cascade above it.',
    '3. **2+ doers need `primaryR`**, or the children inherit no owner.',
    '4. `primaryR` must point at a column that actually holds the doer letter on that row.',
    '5. **Leaf rows need a doer** — a row with no children and no `R` is work nobody does.',
    '6. **Don’t over-consult.** More than half the columns marked `C` is flagged as a sign-off',
    '   bottleneck. Consulted means genuine two-way input, not "was in the room".',
    '7. **Declared inputs need a producer** — some row or handoff somewhere must output that',
    '   artifact id.',
    '',
    '**Flow steps**',
    '',
    '8. One owner per step (2+ is an error); a step with none and no cascade inherited is flagged.',
    '9. Every step needs a doer, and every doer column needs a `parties` entry (or an inheritable',
    '   default from the anchor).',
    '10. A step with 2+ outgoing edges is a decision point — **label every branch**.',
    '11. Every handoff should carry at least one artifact id.',
    '12. In a flow of 2+ steps, no step may be left disconnected.',
    '',
    '---',
    '',
    '## 7. This workspace’s live vocabulary',
    '',
    'Reuse these keys and ids wherever the source material refers to the same thing — that is what',
    'makes a **⧉ Merge** land on top of existing work instead of creating parallel duplicates.',
    '',
    '### Org chart columns',
    '',
    '| Key | Header | Short | Mapped directorate |',
    '| --- | --- | --- | --- |',
  );
  for (const k of COLS) {
    const mapped = mappedDirectorate(ws, k);
    p(
      `| \`${k}\` | ${columnLabel(ws, k)} | ${columnShort(ws, k)} | ${mapped ? '`' + mapped + '`' : '—'} |`,
    );
  }
  p('', '### Directorates and roster ids', '');
  p(...rosterOutline(ws));
  p('', '### Charts already in the workspace', '');
  for (const c of chartsInTabOrder(ws)) {
    const free = freeFormShape(c);
    p(
      `- \`${c.id}\` · "${c.title || 'Untitled'}" · ${c.framework}` +
        (free
          ? ` · free-form, columns: ${free.cols.map((x) => x.key).join(', ')}`
          : ' · org chart') +
        ` · ${rootsOf(c.nodes).length} top-tier row(s)`,
    );
  }
  p('', '### Business cases already in the workspace', '');
  const flows = Object.values(ws.flows);
  if (!flows.length) p('- (none)');
  for (const b of flows) {
    const steps = Object.values(b.steps);
    const nSub = steps.filter((t) => t.kind === 'subflow').length;
    const nGrp = Object.keys(b.groups).length;
    const nBound = steps.filter((t) => t.kind !== 'subflow' && t.bind).length;
    // The legacy loader drops a source chart that is missing or free-form, and turns a flow whose
    // anchor row is gone standalone; the kit describes the workspace as index.html would hold it.
    const source = b.sourceChartId ? ws.charts[b.sourceChartId] : undefined;
    const sourceChartId = source && !freeFormShape(source) ? source.id : null;
    const anchored = resolvedAnchor(ws, b) ? b.anchor : null;
    p(
      `- \`${b.id}\` · "${b.name || 'Untitled'}" · ${b.framework} · ${b.mode}` +
        (b.mode === 'linked'
          ? ` (${nBound}/${steps.length - nSub} steps linked to rows of \`${sourceChartId || '?'}\`)`
          : '') +
        ` · ${steps.length - nSub} step(s)` +
        (nSub ? ` · ${nSub} nested flow(s)` : '') +
        (nGrp ? ` · ${nGrp} group(s)` : '') +
        ` · ${anchored ? 'anchored to ' + anchored.nodeId : 'standalone'}`,
    );
  }
  p('', '### Deliverables already registered', '');
  const artifacts = Object.values(ws.artifacts);
  if (!artifacts.length) p('- (none — name new ones freely)');
  for (const a of artifacts) p(`- \`${a.id}\` · "${a.name || 'Untitled deliverable'}" · ${a.type}`);
  p(
    '',
    '---',
    '',
    '## 8. Worked example — a valid import file',
    '',
    'Every structure above appears at least once here. Mirror its shape; replace its content.',
    '',
    F + 'json',
    JSON.stringify(ingestExample(), null, 2),
    F,
    '',
    '---',
    '',
    '## 9. Pre-flight checklist',
    '',
    'Before replying, verify:',
    '',
    '- [ ] The reply is one JSON object and nothing else — it parses with a plain JSON parser.',
    '- [ ] Every row has exactly one owner letter, or deliberately none where the source is silent.',
    '- [ ] Every row with two or more doers has `primaryR`.',
    '- [ ] Every `raci` key is a real column key for that chart (org keys, or that chart’s',
    '      `custom.cols` keys) — no stray keys, no missing ones.',
    '- [ ] Every `org` / `parties` / `ownerRef` ref names a directorate key from the six, with a',
    '      `divisionId` that exists in `directorates`.',
    '- [ ] Every artifact id in `inputs`, `outputs` and `artifactIds` exists in `artifacts[]`.',
    '- [ ] Every `anchor` names a real `chartId` + `nodeId`, and every edge `from`/`to` a real task id.',
    '- [ ] Org-chart rows nest no deeper than four tiers.',
    '- [ ] Nothing was invented. Unmapped or ambiguous source content is recorded in `_notes`.',
    '',
  );
  return L.join('\n');
}
