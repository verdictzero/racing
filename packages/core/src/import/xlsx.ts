/**
 * Reading a workbook, and turning one into a chart.
 *
 * Two halves, kept apart on purpose:
 *
 *   `readWorkbook(bytes)` is I/O — unzip, inflate, parse XML — and is async.
 *   `importWorkbook(sheets)` is the rules, and is a pure function of a grid of strings.
 *
 * The split is what makes the interesting half testable without a file: every question this
 * importer has to answer well — where is the header row, which columns are the hierarchy, which are
 * parties, what does a row that skips a level mean — is a question about a grid, not about a ZIP.
 *
 * WHY IT IS FORGIVING. The file arrives from Excel, edited by a person who was not thinking about a
 * parser. Rows above the header, blank rows, extra columns, renamed party headers and stray
 * formatting are all normal, and a reader that rejected them would simply not be used. What it will
 * NOT do is guess: a row that skips a hierarchy level is counted and reported, never placed
 * somewhere plausible.
 */

import {
  COLS,
  ENTITY_KINDS,
  MAX_TIER,
  META_PRIORITIES,
  TIER_LABELS,
  type EntityKind,
} from '../constants.js';
import { newId } from '../ids.js';
import { keysBetween } from '../fractional.js';
import { normalizeRaci } from '../raci.js';
import { Chart, ChartNode, Entity, Meta } from '../schema.js';
import { findElements, textOf } from './xml.js';
import { unzip, ZipError } from './unzip.js';

export interface SheetGrid {
  readonly name: string;
  /** Every cell a trimmed string; ragged rows are normal. */
  readonly rows: string[][];
}

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();

/** "AB12" -> 27. */
export function columnFromRef(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const code = ref.charCodeAt(i);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

// ---- reading the file ----------------------------------------------------------------------------

/** Read a .xlsx into a grid of strings per sheet, in the workbook's own order. */
export async function readWorkbook(bytes: Uint8Array): Promise<SheetGrid[]> {
  const { files } = await unzip(bytes, (path) => path.endsWith('.xml') || path.endsWith('.rels'));
  const decoder = new TextDecoder();
  const text = (path: string) => {
    const raw = files.get(path);
    return raw ? decoder.decode(raw) : null;
  };

  const workbookXml = text('xl/workbook.xml');
  if (!workbookXml) throw new ZipError('Not a .xlsx workbook — xl/workbook.xml is missing.');

  // rId -> part path, so sheets are read in the workbook's declared order under their real names
  // rather than by assuming sheet3.xml is the third tab. Excel does not guarantee that.
  const rels = new Map<string, string>();
  const relsXml = text('xl/_rels/workbook.xml.rels');
  if (relsXml) {
    for (const rel of findElements(relsXml, 'Relationship')) {
      let target = rel.attrs.Target ?? '';
      if (target.startsWith('/')) target = target.slice(1);
      else if (!target.startsWith('xl/')) target = `xl/${target}`;
      if (rel.attrs.Id) rels.set(rel.attrs.Id, target);
    }
  }

  // A shared string may be one <t> or a run of several; concatenating is what Excel means by it.
  const shared: string[] = [];
  const sharedXml = text('xl/sharedStrings.xml');
  if (sharedXml) {
    for (const si of findElements(sharedXml, 'si')) {
      shared.push(
        findElements(sharedXml, 't', si.start, si.end)
          .map((t) => t.text)
          .join(''),
      );
    }
  }

  const sheets: SheetGrid[] = [];
  findElements(workbookXml, 'sheet').forEach((sheet, i) => {
    const rid = sheet.attrs['r:id'] ?? sheet.attrs.id ?? '';
    const path = rels.get(rid) ?? `xl/worksheets/sheet${i + 1}.xml`;
    const xml = text(path);
    if (!xml) return;

    const rows: string[][] = [];
    for (const row of findElements(xml, 'row')) {
      const cells: string[] = [];
      for (const cell of findElements(xml, 'c', row.start, row.end)) {
        const ref = cell.attrs.r ?? '';
        const at = ref ? columnFromRef(ref) : cells.length;
        const type = cell.attrs.t;

        let value: string;
        if (type === 'inlineStr') {
          value = textOf(xml.slice(cell.start, cell.end));
        } else {
          const v = findElements(xml, 'v', cell.start, cell.end)[0];
          const raw = v?.text ?? '';
          value = type === 's' ? (shared[Number.parseInt(raw, 10)] ?? '') : raw;
        }

        while (cells.length < at) cells.push('');
        cells[at] = value.trim();
      }

      // Rows carry their own index. A sparse sheet — Excel writes one when rows were deleted —
      // must not shift everything above the gap upward.
      const declared = Number.parseInt(row.attrs.r ?? '0', 10) - 1;
      const at = declared >= 0 ? declared : rows.length;
      while (rows.length < at) rows.push([]);
      rows[at] = cells;
    }

    sheets.push({ name: sheet.attrs.name ?? `Sheet${i + 1}`, rows });
  });

  return sheets;
}

// ---- finding the table ---------------------------------------------------------------------------

/**
 * Headers an export writes for context, sitting between the hierarchy columns and the party ones.
 *
 * They carry org names, not role letters, and feeding one to `normalizeRaci` would mine letters out
 * of prose — "DIRECTORATE C" contains a C — and shift every real party column along by one. This
 * list is therefore part of the file format, not a convenience: adding a context column to the
 * exporter without adding its header here silently corrupts every re-import.
 */
export const CONTEXT_HEADERS = [
  'division', 'branch', 'team', 'unit', 'org', 'org unit', 'organization', 'organisation',
  'notes', 'note',
] as const;

export function isContextHeader(header: string): boolean {
  return (CONTEXT_HEADERS as readonly string[]).includes(
    norm(header).replace(/\s*\(inherited\)\s*$/, '').trim(),
  );
}

export interface HeaderHit {
  readonly headerRow: number;
  /** Column indexes naming a hierarchy tier. */
  readonly pathCols: number[];
  /** Column indexes holding role letters. */
  readonly partyCols: number[];
}

/**
 * Find the header row: one naming at least one tier, followed by two or more party columns.
 *
 * Only the first 30 rows are searched. A title block, a logo and a note above the grid are all
 * normal in a spreadsheet a person has been keeping; thirty rows of preamble is not.
 */
export function findHeaderRow(
  rows: readonly string[][],
  tiers: readonly string[] = TIER_LABELS,
): HeaderHit | null {
  const wanted = tiers.map(norm);
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const row = rows[i] ?? [];
    const hits = row.map((cell, j) => (wanted.includes(norm(cell)) ? j : -1)).filter((j) => j >= 0);
    if (hits.length === 0) continue;

    const party: number[] = [];
    for (let j = hits[hits.length - 1]! + 1; j < row.length; j++) {
      const header = String(row[j] ?? '').trim();
      if (header && !isContextHeader(header)) party.push(j);
    }
    // Two is the threshold because one lone column to the right of a tier name is far more often a
    // stray note than a RACI matrix.
    if (party.length >= 2) return { headerRow: i, pathCols: hits, partyCols: party };
  }
  return null;
}

/** An abbreviation for a party column, the way the app derives one. */
export function deriveShort(label: string): string {
  const words = String(label ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 5);
  return words.map((w) => w[0]!.toUpperCase()).join('').slice(0, 4);
}

// ---- turning a grid into a chart ------------------------------------------------------------------

export interface ImportedWorkbook {
  readonly chart: Chart;
  readonly entities: Entity[];
  /** The workbook's own party names, to become the chart's column labels. */
  readonly labels: Record<string, string>;
  readonly shorts: Record<string, string>;
  readonly warnings: string[];
  readonly stats: {
    readonly sheets: string[];
    readonly rows: number;
    readonly nodes: number;
    readonly columns: number;
    readonly entities: number;
    readonly skipped: number;
  };
}

export class WorkbookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkbookError';
  }
}

function readEntities(sheets: readonly SheetGrid[]): Entity[] {
  const sheet = sheets.find((s) => norm(s.name) === 'entities');
  if (!sheet) return [];

  let header = -1;
  for (let i = 0; i < Math.min(sheet.rows.length, 20); i++) {
    if ((sheet.rows[i] ?? []).some((c) => norm(c) === 'entity')) {
      header = i;
      break;
    }
  }
  if (header < 0) return [];

  const columns = (sheet.rows[header] ?? []).map(norm);
  const at = (name: string) => columns.indexOf(name);
  const cName = at('entity');
  const cKind = at('kind');
  const cShort = at('short');
  const cLead = at('lead');
  const cDesc = at('description');

  const out: Entity[] = [];
  for (let i = header + 1; i < sheet.rows.length; i++) {
    const row = sheet.rows[i] ?? [];
    const name = String(row[cName] ?? '').trim();
    if (!name) continue;
    const kind = cKind >= 0 ? norm(row[cKind]) : 'other';
    const lead = cLead >= 0 ? String(row[cLead] ?? '').trim() : '';
    out.push(
      Entity.parse({
        id: newId('entity'),
        name,
        kind: (ENTITY_KINDS as readonly string[]).includes(kind) ? (kind as EntityKind) : 'other',
        short: cShort >= 0 ? String(row[cShort] ?? '').trim() : '',
        description: cDesc >= 0 ? String(row[cDesc] ?? '').trim() : '',
        lead: lead ? { id: newId('person'), name: lead } : null,
      }),
    );
  }
  return out;
}

function readDocumentSheet(
  sheets: readonly SheetGrid[],
): { title: string | null; meta: Meta } | null {
  const sheet = sheets.find((s) => norm(s.name) === 'document');
  if (!sheet) return null;

  let header = -1;
  for (let i = 0; i < Math.min(sheet.rows.length, 20); i++) {
    if ((sheet.rows[i] ?? []).some((c) => norm(c) === 'name')) {
      header = i;
      break;
    }
  }
  if (header < 0) return null;

  const columns = (sheet.rows[header] ?? []).map(norm);
  const row = sheet.rows[header + 1] ?? [];
  const value = (name: string) => {
    const j = columns.indexOf(name);
    return j >= 0 ? String(row[j] ?? '').trim() : '';
  };

  const title = value('name');
  const priority = norm(value('priority'));
  return {
    // The template ships "Untitled chart" as its placeholder; taking it literally would name every
    // imported chart after the placeholder nobody edited.
    title: title && norm(title) !== 'untitled chart' ? title : null,
    meta: Meta.parse({
      description: value('description'),
      customer: value('customer'),
      priority: (META_PRIORITIES as readonly string[]).includes(priority) ? priority : '',
      budget: value('budget'),
      tags: value('tags').split(',').map((t) => t.trim()).filter(Boolean),
    }),
  };
}

export interface ImportOptions {
  /** Used as the chart title when the Document sheet does not name one. */
  readonly fileName?: string;
}

/**
 * Build a chart from a workbook's sheets.
 *
 * EVERY recognizable sheet is read into ONE tree, not just the best one. An export writes a sheet
 * per tier and each tier's letters live only on its own sheet, so reading the deepest sheet alone
 * would rebuild the whole shape with every row above the bottom left blank.
 */
export function importWorkbook(
  sheets: readonly SheetGrid[],
  opts: ImportOptions = {},
): ImportedWorkbook {
  const warnings: string[] = [];
  const found = sheets
    .map((sheet) => ({ sheet, hit: findHeaderRow(sheet.rows) }))
    .filter((x): x is { sheet: SheetGrid; hit: HeaderHit } => x.hit !== null);

  if (found.length === 0) {
    throw new WorkbookError(
      'No RACI table found. Looked for a header row naming at least one of: ' +
        `${TIER_LABELS.join(', ')} — followed by two or more party columns. ` +
        'Download the Excel template to see the layout.',
    );
  }

  // Column labels come from the widest header seen; every sheet of an export repeats the same set,
  // but a hand-built workbook may have trimmed some on the shallower sheets.
  const widest = [...found].sort((a, b) => b.hit.partyCols.length - a.hit.partyCols.length)[0]!;
  const widestHeader = widest.sheet.rows[widest.hit.headerRow] ?? [];
  const partyLabels = widest.hit.partyCols.map((j) => String(widestHeader[j] ?? '').trim());
  const columnCount = Math.min(partyLabels.length, COLS.length);
  if (partyLabels.length > COLS.length) {
    warnings.push(
      `${partyLabels.length} party columns found; an org chart has ${COLS.length}, ` +
        `so the last ${partyLabels.length - COLS.length} were dropped.`,
    );
  }

  const chartId = newId('chart');
  const nodes: Record<string, ChartNode> = {};
  const byPath = new Map<string, string>();
  const childCount = new Map<string | null, number>();

  /** Make the row at `path`, creating any ancestor a child row named but no row of its own did. */
  const ensure = (path: readonly string[]): string => {
    // A separator no activity name can contain, so "A" + "B/C" and "A/B" + "C" stay distinct rows.
    const key = path.join('\u0001');
    const existing = byPath.get(key);
    if (existing) return existing;

    const parentId = path.length > 1 ? ensure(path.slice(0, -1)) : null;
    const id = newId('node');
    const n = childCount.get(parentId) ?? 0;
    childCount.set(parentId, n + 1);
    nodes[id] = ChartNode.parse({
      id,
      chartId,
      parentId,
      // One key per sibling position. Generated in bulk rather than bisected each time, because the
      // rows arrive in order and bisecting eight hundred of them builds a very long key.
      order: keysBetween(null, null, n + 1)[n]!,
      name: path[path.length - 1]!,
      raci: {},
    });
    byPath.set(key, id);
    return id;
  };

  let rowsRead = 0;
  let skipped = 0;
  const sheetsRead: string[] = [];

  for (const { sheet, hit } of found) {
    let mine = 0;
    for (let i = hit.headerRow + 1; i < sheet.rows.length; i++) {
      const row = sheet.rows[i] ?? [];
      const values = hit.pathCols.map((j) => String(row[j] ?? '').trim());
      const filled = values.filter(Boolean).length;

      const path: string[] = [];
      for (let k = 0; k < values.length && values[k]; k++) path.push(values[k]!);

      if (path.length === 0) {
        if (row.some((c) => String(c ?? '').trim())) skipped++;
        continue;
      }
      // A row that skips a level — Project filled, Program blank — cannot be placed anywhere
      // sensible. Excel users do this constantly, so it is counted and reported, never guessed at.
      if (filled !== path.length || path.length > MAX_TIER + 1) {
        skipped++;
        continue;
      }

      const id = ensure(path);
      hit.partyCols.slice(0, columnCount).forEach((j, k) => {
        const letters = normalizeRaci(String(row[j] ?? '').toUpperCase());
        // Only ever WRITE letters. A blank cell on one sheet must not wipe what another sheet set,
        // which is the whole reason every sheet can be read into one tree.
        if (letters) nodes[id]!.raci[COLS[k]!] = letters;
      });
      rowsRead++;
      mine++;
    }
    if (mine > 0) sheetsRead.push(sheet.name);
  }

  if (skipped > 0) {
    warnings.push(
      `${skipped} row${skipped === 1 ? '' : 's'} skipped — a row has to fill its hierarchy ` +
        'columns from the left with no gaps.',
    );
  }
  if (rowsRead === 0) {
    throw new WorkbookError(
      'Found a header but no usable rows. Every row needs a name in at least the first hierarchy column.',
    );
  }
  if (sheetsRead.length > 1) {
    warnings.push(
      'Letters are taken exactly as written. A workbook exported from here spells out the ' +
        'inherited owner on every row, so re-importing one makes that cascade explicit.',
    );
  }

  const labels: Record<string, string> = {};
  const shorts: Record<string, string> = {};
  partyLabels.slice(0, columnCount).forEach((label, k) => {
    labels[COLS[k]!] = label;
    shorts[COLS[k]!] = deriveShort(label);
  });

  const document = readDocumentSheet(sheets);
  const fallbackTitle = String(opts.fileName ?? '').replace(/\.xlsx$/i, '') || 'Imported chart';

  const chart = Chart.parse({
    id: chartId,
    title: document?.title ?? fallbackTitle,
    meta: document?.meta ?? Meta.parse({}),
    nodes,
  });

  const entities = readEntities(sheets);

  return {
    chart,
    entities,
    labels,
    shorts,
    warnings,
    stats: {
      sheets: sheetsRead,
      rows: rowsRead,
      nodes: Object.keys(nodes).length,
      columns: columnCount,
      entities: entities.length,
      skipped,
    },
  };
}

/** Read a .xlsx and build a chart from it. */
export async function importXlsx(
  bytes: Uint8Array,
  opts: ImportOptions = {},
): Promise<ImportedWorkbook> {
  return importWorkbook(await readWorkbook(bytes), opts);
}
