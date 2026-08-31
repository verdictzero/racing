/**
 * The Excel export.
 *
 * "Most folks responsible for updating, developing and maintaining RACIs would prefer Excel" was
 * the stakeholder note that put this in the product, and it is still the format the chart most
 * often has to leave in.
 *
 * WRITTEN BY HAND, deliberately. A .xlsx is a ZIP of XML parts, and the subset needed for a grid of
 * text — inline strings, no styles, no shared-string table — is small enough to emit directly. That
 * buys: no dependency, no WASM, identical behaviour in a browser and on a server, and output that
 * is deterministic to the byte so it can be asserted on. The legacy app reached the same conclusion
 * for the same reasons; this is that writer, out of the DOM and under test.
 *
 * ONE SHEET PER TIER, not one sheet with a level column. A reader who wants "all the projects" gets
 * a sheet of projects, and each row repeats its ancestors so the sheet stands alone when it is
 * filtered, sorted or pasted somewhere else. It is also the shape the importer reads back, which is
 * what makes the round trip through Excel work at all.
 */

import { chartColumns, type Chart, type Workspace } from '../schema.js';
import {
  COLS,
  COL_LABELS_DEFAULT,
  ENTITY_KINDS,
  META_PRIORITY_LABELS,
  TIER_LABELS,
  framework,
  type MetaPriority,
} from '../constants.js';
import { effectiveRaci } from '../raci.js';
import { childIndex, childrenIn, pathTo } from '../tree.js';
import { orgLabel } from '../org.js';
import { computeArtifactUses, computeEntityUses } from '../registry.js';
import { entityKindMeta, artifactTypeMeta } from '../constants.js';
import { tierLabel } from '../legacy.js';
import { topologicalOrder } from './order.js';
import { stepIo } from './xml.js';
import { zipBytes, type ZipEntry } from './zip.js';

export interface Sheet {
  readonly name: string;
  readonly headers: readonly string[];
  readonly rows: ReadonlyArray<readonly string[]>;
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A1, B1 … Z1, AA1. */
export function columnLetter(index: number): string {
  let out = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * Make a sheet name Excel will actually accept.
 *
 * Excel rejects the whole workbook — not the sheet, the workbook — over a name longer than 31
 * characters or containing any of `\ / ? * [ ] :`. A free-form chart's tier names are typed by a
 * user, so this is reachable in normal use, and the failure is a file that simply will not open.
 * Names are also deduplicated, since two sanitized names can collide even when the originals did not.
 */
export function sheetName(raw: string, taken: Set<string>, fallback = 'Sheet'): string {
  const base = raw.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 28) || fallback;
  let name = base;
  let n = 2;
  while (taken.has(name.toLowerCase())) name = `${base} ${n++}`;
  taken.add(name.toLowerCase());
  return name;
}

function sheetXml(sheet: Sheet): string {
  const row = (cells: readonly string[], r: number) =>
    `<row r="${r}">${cells
      .map(
        (value, c) =>
          `<c r="${columnLetter(c)}${r}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`,
      )
      .join('')}</row>`;

  const body = [row(sheet.headers, 1), ...sheet.rows.map((cells, i) => row(cells, i + 2))].join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`
  );
}

/** Assemble a workbook from sheets. Shared with the blank template, which has no content at all. */
export function writeWorkbook(sheets: readonly Sheet[]): Uint8Array<ArrayBuffer> {
  const taken = new Set<string>();
  const named = sheets.map((sheet, i) => ({
    ...sheet,
    name: sheetName(sheet.name, taken, `Sheet ${i + 1}`),
  }));

  const entries: ZipEntry[] = [
    {
      path: '[Content_Types].xml',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        named
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join('') +
        '</Types>',
    },
    {
      path: '_rels/.rels',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    },
    {
      path: 'xl/workbook.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        named
          .map((sheet, i) => `<sheet name="${esc(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
          .join('') +
        '</sheets></workbook>',
    },
    {
      path: 'xl/_rels/workbook.xml.rels',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        named
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join('') +
        '</Relationships>',
    },
    ...named.map((sheet, i) => ({ path: `xl/worksheets/sheet${i + 1}.xml`, content: sheetXml(sheet) })),
  ];

  return zipBytes(entries);
}

// ---- the sheets ----------------------------------------------------------------------------------

export const DOCUMENT_HEADERS = [
  'Kind', 'Name', 'Status', 'Signed', 'Customer', 'Priority', 'Budget', 'Tags', 'Description',
] as const;

export const FLOW_HEADERS = [
  'Chart task', 'Flow', 'Status', 'Mode', 'Step', 'Description', 'Entry criteria', 'Exit criteria',
  'Roles', 'Responsible parties', 'Inputs', 'Outputs', 'Next / condition',
] as const;

const statusName = (status: string) => (status === 'final' ? 'Final' : 'Draft');

function documentRow(
  kind: string,
  name: string,
  o: { status: string; finalizedAt: string | null; meta: { customer: string; priority: string; budget: string; tags: string[]; description: string } },
): string[] {
  return [
    kind,
    name,
    statusName(o.status),
    o.finalizedAt ?? '',
    o.meta.customer,
    META_PRIORITY_LABELS[o.meta.priority as MetaPriority] ?? '',
    o.meta.budget,
    o.meta.tags.join(', '),
    o.meta.description,
  ];
}

/**
 * One sheet per tier, each row carrying its ancestors.
 *
 * The RACI written is the RESOLVED one — a child that inherits its owner shows it. A sheet that
 * printed only what each row states would be missing the cascade, which is the entire point of a
 * nested chart, and would be wrong in the way nobody notices until they act on it.
 */
export function buildChartSheets(ws: Workspace, chart: Chart): Sheet[] {
  const columns = chartColumns(chart);
  const columnHeaders = columns.map(
    (key) =>
      chart.custom?.cols.find((c) => c.key === key)?.label ??
      ws.columnLabels[key] ??
      COL_LABELS_DEFAULT[key as keyof typeof COL_LABELS_DEFAULT] ??
      key,
  );

  const index = childIndex(chart.nodes);
  const byDepth: Array<{ name: string; rows: string[][] }> = [];
  const org = (nodeId: string) => orgLabel(ws, chart.nodes[nodeId]?.org)?.full ?? '';

  const walk = (parentId: string | null, depth: number, ancestors: string[]) => {
    for (const node of childrenIn(index, parentId)) {
      const level = (byDepth[depth] ??= { name: tierLabel(chart, depth), rows: [] });
      const effective = effectiveRaci(chart, chart.nodes, node.id);
      level.rows.push([
        ...ancestors,
        node.name,
        org(node.id),
        ...columns.map((key) => effective[key]?.letters ?? ''),
      ]);
      walk(node.id, depth + 1, [...ancestors, node.name]);
    }
  };
  walk(null, 0, []);

  return byDepth.filter(Boolean).map((level, depth) => {
    const lead: string[] = [];
    for (let i = 0; i <= depth; i++) lead.push(tierLabel(chart, i));
    return { name: level.name, headers: [...lead, 'Org unit', ...columnHeaders], rows: level.rows };
  });
}

/**
 * The flows this chart's workbook carries: the ones anchored to a row in it.
 *
 * Anchor only, matching `flowsForChart` in index.html. A Chart-Linked flow also records a
 * `sourceChartId` — the chart it was generated from — and arguably belongs to that chart just as
 * much, but the legacy export does not include it and both apps are shipping. Widening it here
 * would mean the same workspace exported from the two apps produced different files, with nothing
 * to tell a reader which was right. Settle it with the flow canvas (PORTING.md slice 3), where
 * linked flows are actually built and there is something to test against.
 */
function flowsForChart(ws: Workspace, chartId: string) {
  return Object.values(ws.flows).filter((f) => f.anchor?.chartId === chartId);
}

export function buildFlowRows(ws: Workspace, chart: Chart): string[][] {
  const rows: string[][] = [];
  const artifactName = (id: string) => ws.artifacts[id]?.name ?? '(missing deliverable)';

  for (const flow of flowsForChart(ws, chart.id)) {
    const anchorCrumb = flow.anchor
      ? pathTo(chart.nodes, flow.anchor.nodeId).map((n) => n.name || '(untitled)').join(' › ')
      : '';

    for (const stepId of topologicalOrder(flow)) {
      const step = flow.steps[stepId];
      if (!step) continue;
      const io = stepIo(flow, step.id);
      const roles = Object.entries(step.raci)
        .filter(([, letters]) => letters)
        .map(([column, letters]) => `${column}: ${letters}`)
        .join(', ');
      const parties = Object.entries(step.parties)
        .map(([column, ref]) => `${column}: ${orgLabel(ws, ref)?.short ?? ''}`)
        .filter((s) => !s.endsWith(': '))
        .join(', ');
      const next = Object.values(flow.edges)
        .filter((e) => e.from === step.id)
        .map((e) => `${flow.steps[e.to]?.name ?? '?'}${e.label ? ` (${e.label})` : ''}`)
        .join('; ');

      rows.push([
        anchorCrumb,
        flow.name,
        statusName(flow.status),
        flow.mode === 'linked' ? 'Chart-linked' : 'Free-form',
        (step.kind === 'subflow' ? '⧉ ' : '') + (step.name || '(untitled step)'),
        step.kind === 'subflow'
          ? `Nested flow → ${ws.flows[step.refId ?? '']?.name ?? '(missing)'}${step.description ? ` — ${step.description}` : ''}`
          : step.description,
        step.entry,
        step.exit,
        roles,
        parties,
        io.inputs.map(artifactName).join(', '),
        io.outputs.map(artifactName).join(', '),
        next,
      ]);
    }
  }
  return rows;
}

export const DELIVERABLE_HEADERS = [
  'Deliverable', 'Type', 'Produced by', 'Consumed by', 'Description',
] as const;

export const ENTITY_HEADERS = [
  'Entity', 'Kind', 'Short', 'Lead', 'Description', 'Named by',
] as const;

/**
 * The deliverable registry.
 *
 * Each end is de-duplicated by place: a deliverable carried away from one step on two branches is
 * produced there once, and a cell naming the step twice would read as two producers.
 */
export function buildDeliverableRows(ws: Workspace): string[][] {
  const uses = computeArtifactUses(ws);
  return Object.values(ws.artifacts).map((a) => [
    a.name,
    artifactTypeMeta(a.type).label,
    [...new Set((uses.get(a.id)?.producers ?? []).map((u) => u.name))].join(', '),
    [...new Set((uses.get(a.id)?.consumers ?? []).map((u) => u.name))].join(', '),
    a.description,
  ]);
}

export function buildEntityRows(ws: Workspace): string[][] {
  return Object.values(ws.entities).map((e) => [
    e.name,
    entityKindMeta(e.kind).label,
    e.short,
    e.lead?.name ?? '',
    e.description,
    computeEntityUses(ws, e.id).map((u) => `${u.where} › ${u.name}`).join('; '),
  ]);
}

export interface XlsxOptions {
  /** Which chart to export. Defaults to the first. */
  readonly chartId?: string;
}

/** The workbook, as bytes. */
export function exportXlsx(ws: Workspace, opts: XlsxOptions = {}): Uint8Array<ArrayBuffer> {
  const chart = opts.chartId ? ws.charts[opts.chartId] : Object.values(ws.charts)[0];
  if (!chart) return writeWorkbook([{ name: 'Document', headers: DOCUMENT_HEADERS, rows: [] }]);

  const sheets: Sheet[] = [
    {
      name: 'Document',
      headers: DOCUMENT_HEADERS,
      rows: [
        documentRow('Chart', chart.title, chart),
        ...flowsForChart(ws, chart.id).map((flow) => documentRow('Flow', flow.name, flow)),
      ],
    },
    ...buildChartSheets(ws, chart),
  ];

  const flowRows = buildFlowRows(ws, chart);
  if (flowRows.length > 0) sheets.push({ name: 'Flows', headers: FLOW_HEADERS, rows: flowRows });

  const deliverables = buildDeliverableRows(ws);
  if (deliverables.length > 0) {
    sheets.push({ name: 'Deliverables', headers: DELIVERABLE_HEADERS, rows: deliverables });
  }

  const entities = buildEntityRows(ws);
  if (entities.length > 0) {
    sheets.push({ name: 'Entities', headers: ENTITY_HEADERS, rows: entities });
  }

  return writeWorkbook(sheets);
}

// ---- the blank template --------------------------------------------------------------------------

/** The sheet the importer reads. Renaming it breaks the round trip, so it is a constant. */
export const TEMPLATE_SHEET = 'RACI';

/**
 * A blank workbook shaped exactly like the export.
 *
 * "Most folks would prefer Excel" cuts both ways: the export was only half the ask. This is the
 * other half, and it is deliberately the SAME shape the export writes, so the workflow people
 * actually have — export, edit in Excel, load back — works without anyone learning a second layout.
 *
 * The Instructions sheet is not padding. Every rule it states is one the importer enforces silently,
 * and a person who does not know them produces a file that loads with rows missing and no
 * explanation. Writing them next to the grid is cheaper than any error message.
 */
export function buildTemplateSheets(ws?: Workspace): Sheet[] {
  const tiers = [...TIER_LABELS];
  const columnHeaders = COLS.map(
    (key) => ws?.columnLabels[key] || COL_LABELS_DEFAULT[key as keyof typeof COL_LABELS_DEFAULT] || key,
  );
  const letters = framework('raci').roles.join(' / ');
  const blank = () => [...tiers.map(() => ''), ...COLS.map(() => '')];

  return [
    {
      name: 'Instructions',
      headers: ['How to fill this in'],
      rows: [
        [`Fill in the "${TEMPLATE_SHEET}" sheet, then use Load or Merge in the tool and pick this file.`],
        [''],
        ['ONE ROW PER ACTIVITY.'],
        [`The first ${tiers.length} columns are the hierarchy: ${tiers.join(' → ')}.`],
        ['Put the activity name in the column for its level, and repeat its parents to its left.'],
        ['The deepest filled column is the row being defined.'],
        [''],
        [`  ${tiers[0]} alone → a top-level activity.`],
        [`  ${tiers[0]} + ${tiers[1]} → a ${tiers[1]!.toLowerCase()} under that ${tiers[0]!.toLowerCase()}.`],
        [`  All four → a ${tiers[3]!.toLowerCase()} at the bottom of that path.`],
        [''],
        ['A parent does not need its own row. Naming one on a child row creates it.'],
        [`Do not leave a gap: a row with ${tiers[2]} filled but ${tiers[1]} blank is skipped.`],
        [''],
        ['THE PARTY COLUMNS.'],
        [`Put responsibility letters in them: ${letters}.`],
        ['More than one letter in a cell is fine — write them together, e.g. "AR".'],
        ['Leave a cell blank where a party has no role. Case does not matter.'],
        ['Anything that is not a role letter is ignored.'],
        [''],
        ['RENAMING THE PARTY COLUMNS.'],
        ['Rename the headers to your own parties if you like. They are matched by position, and'],
        ['whatever you type becomes the column label in the tool.'],
        [''],
        ['THE OTHER SHEETS ARE OPTIONAL.'],
        ['Entities — parties that are neither people nor directorates (boards, vendors, teams).'],
        ['Document — the name and metadata for the chart this becomes.'],
        ['Delete either sheet if you do not need it.'],
        [''],
        ['Rows above the header line, blank rows and extra columns are all ignored.'],
      ],
    },
    {
      name: TEMPLATE_SHEET,
      headers: [...tiers, ...columnHeaders],
      rows: [
        // Worked examples at each depth, because the "repeat the parents to the left" rule is much
        // faster to see than to read.
        ['Example portfolio activity', '', '', '', 'A', '', 'R', 'C', '', 'I', ''],
        ['Example portfolio activity', 'Example program', '', '', '', 'A', 'R', '', 'C', '', 'I'],
        ['Example portfolio activity', 'Example program', 'Example project', '', '', '', 'A', 'R', 'C', '', ''],
        ['Example portfolio activity', 'Example program', 'Example project', 'Example task', '', '', '', 'AR', '', 'C', 'I'],
        ...Array.from({ length: 14 }, blank),
      ],
    },
    {
      name: 'Entities',
      headers: ['Entity', 'Kind', 'Short', 'Lead', 'Description'],
      rows: [
        ['Example Review Board', 'board', 'ERB', '', `Kind is one of: ${ENTITY_KINDS.join(', ')}`],
        ...Array.from({ length: 9 }, () => ['', '', '', '', '']),
      ],
    },
    {
      name: 'Document',
      headers: DOCUMENT_HEADERS,
      rows: [['Chart', 'Untitled chart', 'Draft', '', '', '', '', '', '']],
    },
  ];
}

/** The blank template, as bytes. */
export function exportTemplate(ws?: Workspace): Uint8Array<ArrayBuffer> {
  return writeWorkbook(buildTemplateSheets(ws));
}
