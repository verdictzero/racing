/**
 * The Excel export — index.html's `xlsxBytes()`, out of the DOM.
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
 * THE LEGACY'S WORKBOOK, SHEET FOR SHEET. A Document sheet saying what the file is and whether it
 * is signed; the chart, one sheet per tier, each row repeating its ancestors (and on an organization
 * chart the roster units above it) so a sheet stands alone when it is filtered, sorted or pasted
 * somewhere else; the flows anchored to the chart, a step a row; and the two registries. People
 * keep the workbook index.html gave them beside this one, so the parity test holds every part of the
 * package to what index.html writes — the one byte-level difference in the .xlsx file is the ZIP
 * entry timestamp (see zip.ts). The tier sheets are the ones the PowerPoint deck is paginated from,
 * as they are in the legacy, and every cell's words come from document-text.ts.
 */

import {
  COLS,
  COL_LABELS_DEFAULT,
  ENTITY_KINDS,
  META_PRIORITY_LABELS,
  TIER_LABELS,
  entityKindMeta,
  framework,
} from '../constants.js';
import { stepLabel } from '../lint-context.js';
import {
  artifactsInOrder,
  entitiesInOrder,
  entityDisplayName,
  entityDisplayShort,
} from '../registry.js';
import { ancestorsOf } from '../tree.js';
import type { Chart, Workspace } from '../schema.js';
import {
  FLOW_MODE_NAMES,
  STATUS_TEXT,
  anchorContext,
  deliverableName,
  deliverableUses,
  documentChart,
  documentColumns,
  documentTags,
  entityNamings,
  escapeHtml as esc,
  flowStepOrder,
  flowsAnchoredTo,
  nestedFlowName,
  resolvedAnchor,
  signedOn,
  stepDeliverables,
  stepLinkText,
  stepNextText,
  stepPartiesText,
  stepRolesText,
  type DateStyle,
} from './document-text.js';
import { buildLevelSheets } from './pptx.js';
import { zipBytes, type ZipEntry } from './zip.js';

export interface Sheet {
  readonly name: string;
  readonly headers: readonly string[];
  readonly rows: ReadonlyArray<readonly string[]>;
}

/** A1, B1 … Z1, AA1 — `colLetter`. */
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

/** One worksheet: a header row, then the rows, every cell an inline string — `sheetXml`. */
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

/**
 * Every part of a workbook of these sheets, in the order the legacy writes them — `xlsxBytesFor`
 * short of the ZIP.
 *
 * A name that repeats one already taken gets " 2", " 3" … after it, exactly as the legacy guards a
 * free-form chart's user-named level against the fixed sheet names; making the names safe for Excel
 * in the first place is the tier sheets' job (see `buildLevelSheets`), as it is in the legacy.
 */
export function workbookParts(sheets: readonly Sheet[]): ZipEntry[] {
  const taken = new Set<string>();
  const named = sheets.map((sheet) => {
    let name = sheet.name;
    let n = 2;
    while (taken.has(name)) name = `${sheet.name} ${n++}`;
    taken.add(name);
    return { ...sheet, name };
  });

  return [
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
}

/** Assemble a workbook from sheets. Shared with the blank template, which has no content at all. */
export function writeWorkbook(sheets: readonly Sheet[]): Uint8Array<ArrayBuffer> {
  return zipBytes(workbookParts(sheets));
}

// ---- the sheets ----------------------------------------------------------------------------------

export const DOCUMENT_HEADERS = [
  'Kind', 'Name', 'Status', 'Signed', 'Customer', 'Priority', 'Budget', 'Tags', 'Description',
] as const;

export const FLOW_HEADERS = [
  'Chart task', 'Flow', 'Status', 'Mode', 'Step', 'Description', 'Linked chart row', 'Entry criteria',
  'Exit criteria', 'Roles', 'Responsible parties', 'Inputs', 'Outputs', 'Next / condition',
] as const;

export const DELIVERABLE_HEADERS = ['Deliverable', 'Type', 'Produced by', 'Consumed by'] as const;

export const ENTITY_HEADERS = [
  'Entity', 'Kind', 'Short', 'Lead', 'Description', 'Named by',
] as const;

/** One document's header row — `documentRow`. A draft says so; a signed one says when. */
function documentRow(
  kind: string,
  name: string,
  o: Pick<Chart, 'status' | 'finalizedAt' | 'meta'>,
  style: DateStyle,
): string[] {
  const m = o.meta;
  return [
    kind,
    name,
    STATUS_TEXT[o.status].name,
    signedOn(o, style),
    m.customer || '',
    META_PRIORITY_LABELS[m.priority] || '',
    m.budget || '',
    documentTags(m).join(', '),
    m.description || '',
  ];
}

/**
 * The Document sheet — `buildDocumentRows`: the chart, then every flow anchored to it, each with
 * its status, signature and metadata. A spreadsheet of a draft that says nothing about being a
 * draft is the paper version of the failure the status exists to prevent.
 */
export function buildDocumentRows(ws: Workspace, chart: Chart, style: DateStyle = {}): string[][] {
  return [
    documentRow('Chart', chart.title || 'Untitled chart', chart, style),
    ...flowsAnchoredTo(ws, chart.id).map((flow) =>
      documentRow('Flow', flow.name || 'Untitled', flow, style),
    ),
  ];
}

/**
 * The Flows sheet — `buildFlowRows`: one row per step, in the order each flow runs, across every
 * flow anchored to the chart. A nested-flow box is a pointer to the flow it stands for, whose own
 * rows export wherever that flow is anchored.
 */
export function buildFlowRows(ws: Workspace, chart: Chart): string[][] {
  const columns = documentColumns(chart);
  const rows: string[][] = [];
  for (const flow of flowsAnchoredTo(ws, chart.id)) {
    const anchor = resolvedAnchor(ws, flow);
    const context = anchorContext(ws, flow);
    const crumb = anchor
      ? [...ancestorsOf(chart.nodes, anchor.node.id).reverse(), anchor.node]
          .map((n) => n.name || '')
          .join(' › ')
      : '';
    for (const step of flowStepOrder(flow)) {
      const io = stepDeliverables(flow, step.id);
      const nested = step.kind === 'subflow';
      rows.push([
        crumb,
        flow.name || '',
        STATUS_TEXT[flow.status].name,
        FLOW_MODE_NAMES[flow.mode],
        (nested ? '⧉ ' : '') + stepLabel(ws, flow, step),
        nested
          ? `Nested flow → ${nestedFlowName(ws, flow, step)}${step.description ? ` — ${step.description}` : ''}`
          : step.description || '',
        stepLinkText(ws, flow, step, columns),
        step.entry || '',
        step.exit || '',
        stepRolesText(ws, flow, step, columns),
        stepPartiesText(ws, flow, context, step, columns),
        io.inputs.map((id) => deliverableName(ws, id)).join(', '),
        io.outputs.map((id) => deliverableName(ws, id)).join(', '),
        stepNextText(ws, flow, step),
      ]);
    }
  }
  return rows;
}

/**
 * The deliverable registry — `buildDeliverableRows`: each deliverable's type key, and every place
 * that produces or consumes it, as the legacy lists them (a step handing it on down two branches is
 * named once per handoff).
 */
export function buildDeliverableRows(ws: Workspace): string[][] {
  const uses = deliverableUses(ws);
  return artifactsInOrder(ws).map((a) => [
    a.name || 'Untitled deliverable',
    a.type,
    (uses.get(a.id)?.producers ?? []).join(', '),
    (uses.get(a.id)?.consumers ?? []).join(', '),
  ]);
}

/** The entity registry — `buildEntityRows`: each entity, and everywhere it is named as a party. */
export function buildEntityRows(ws: Workspace): string[][] {
  const namings = entityNamings(ws);
  return entitiesInOrder(ws).map((e) => [
    entityDisplayName(e),
    entityKindMeta(e.kind).label,
    entityDisplayShort(e),
    e.lead?.name || '',
    e.description || '',
    (namings.get(e.id) ?? []).map((u) => `${u.where} › ${u.name}`).join('; '),
  ]);
}

/**
 * Which chart to export, and how its signed date is written.
 *
 * The date on a Final chart's (or flow's) Document row prints the way index.html prints it, with
 * `toLocaleDateString()` in the reader's own locale and zone — see `DateStyle`.
 */
export interface XlsxOptions extends DateStyle {
  /** The chart tab in front of the person — index.html's `ac()`. Absent or unknown: the first tab. */
  readonly chartId?: string;
}

/** Every sheet of the chart's workbook, in order — what `xlsxBytes` hands the writer. */
export function workbookSheets(ws: Workspace, opts: XlsxOptions = {}): Sheet[] {
  const chart = documentChart(ws, opts.chartId);
  const sheets: Sheet[] = [
    { name: 'Document', headers: DOCUMENT_HEADERS, rows: buildDocumentRows(ws, chart, opts) },
    ...buildLevelSheets(ws, chart),
  ];
  // Anchored flows and the two registries ride along when there is anything in them.
  const flows = buildFlowRows(ws, chart);
  if (flows.length > 0) sheets.push({ name: 'Flows', headers: FLOW_HEADERS, rows: flows });
  if (artifactsInOrder(ws).length > 0) {
    sheets.push({ name: 'Deliverables', headers: DELIVERABLE_HEADERS, rows: buildDeliverableRows(ws) });
  }
  if (entitiesInOrder(ws).length > 0) {
    sheets.push({ name: 'Entities', headers: ENTITY_HEADERS, rows: buildEntityRows(ws) });
  }
  return sheets;
}

/** Every part of the chart's workbook, in the order the legacy writes them. */
export function xlsxParts(ws: Workspace, opts: XlsxOptions = {}): ZipEntry[] {
  return workbookParts(workbookSheets(ws, opts));
}

/** The chart's workbook, as bytes. */
export function exportXlsx(ws: Workspace, opts: XlsxOptions = {}): Uint8Array<ArrayBuffer> {
  return zipBytes(xlsxParts(ws, opts));
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
