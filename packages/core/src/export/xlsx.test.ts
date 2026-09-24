import { describe, it, expect } from 'vitest';
import demo from '../__fixtures__/demo-workspace.json' with { type: 'json' };
// Digests of every part of the workbook index.html's own `xlsxBytes()` wrote for the demo and two
// variations of it, run headless in Chromium (en-US, UTC) by scripts/capture-legacy-parity.mjs —
// rerun it when index.html changes the export.
import golden from '../__fixtures__/legacy-parity.json' with { type: 'json' };
import { anchoredVariant, freeFormVariant } from '../__fixtures__/parity-variants.js';
import { importLegacy } from '../legacy.js';
import { buildLevelSheets } from './pptx.js';
import {
  buildDeliverableRows,
  buildDocumentRows,
  buildEntityRows,
  buildFlowRows,
  buildTemplateSheets,
  columnLetter,
  exportTemplate,
  exportXlsx,
  workbookParts,
  workbookSheets,
  writeWorkbook,
  xlsxParts,
} from './xlsx.js';
import { crc32, zipBytes } from './zip.js';

const { workspace } = importLegacy(demo);
const chartId = golden.cases.demo.chartId;
const chart = workspace.charts[chartId]!;
const anchored = importLegacy(anchoredVariant(demo)).workspace;
const freeform = importLegacy(freeFormVariant(demo)).workspace;

/** The locale and zone the golden capture ran in. */
const CAPTURED = { locale: 'en-US', timeZone: 'UTC' } as const;

async function sha256(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The sheet names a workbook's parts declare, in order. */
const sheetNames = (parts: ReadonlyArray<{ path: string; content: string | Uint8Array }>) => [
  ...(parts.find((p) => p.path === 'xl/workbook.xml')!.content as string).matchAll(
    /<sheet name="([^"]*)"/g,
  ),
].map((m) => m[1]);

/**
 * A minimal ZIP reader, so the tests read the archive back the way a consumer would rather than
 * trusting the writer's own idea of what it wrote. Store-only, which is all this writer emits.
 */
function unzip(bytes: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let at = 0;
  while (at + 4 <= bytes.length && view.getUint32(at, true) === 0x04034b50) {
    const compressed = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const extraLength = view.getUint16(at + 28, true);
    const nameAt = at + 30;
    const dataAt = nameAt + nameLength + extraLength;
    out.set(
      decoder.decode(bytes.subarray(nameAt, nameAt + nameLength)),
      decoder.decode(bytes.subarray(dataAt, dataAt + compressed)),
    );
    at = dataAt + compressed;
  }
  return out;
}

describe('the ZIP writer', () => {
  it('produces an archive that reads back entry for entry', () => {
    const bytes = zipBytes([
      { path: 'a.txt', content: 'hello' },
      { path: 'dir/b.xml', content: '<x/>' },
    ]);
    const back = unzip(bytes);
    expect(back.get('a.txt')).toBe('hello');
    expect(back.get('dir/b.xml')).toBe('<x/>');
  });

  it('writes a correct CRC for every entry', () => {
    // A wrong CRC is the failure mode where the file looks fine until something opens it.
    const bytes = zipBytes([{ path: 'a.txt', content: 'hello' }]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(14, true)).toBe(crc32(new TextEncoder().encode('hello')));
  });

  it('has a central directory the archive’s own header agrees with', () => {
    const bytes = zipBytes([{ path: 'a.txt', content: 'x' }, { path: 'b.txt', content: 'yy' }]);
    // End-of-central-directory is the last 22 bytes when there is no comment.
    const end = bytes.length - 22;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(2); // entries on this disk
    const size = view.getUint32(end + 12, true);
    const start = view.getUint32(end + 16, true);
    expect(start + size).toBe(end);
  });

  it('is byte-identical across runs — nothing here reads the clock', () => {
    // A timestamped archive makes every download a spurious diff and cannot be asserted on.
    const once = zipBytes([{ path: 'a.txt', content: 'hello' }]);
    const twice = zipBytes([{ path: 'a.txt', content: 'hello' }]);
    expect([...once]).toEqual([...twice]);
  });

  it('carries binary content through unchanged', () => {
    const payload = new Uint8Array([0, 1, 254, 255, 0x50, 0x4b]);
    const bytes = zipBytes([{ path: 'raw.bin', content: payload }]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const nameLength = view.getUint16(26, true);
    const dataAt = 30 + nameLength;
    expect([...bytes.subarray(dataAt, dataAt + payload.length)]).toEqual([...payload]);
  });
});

describe('spreadsheet mechanics', () => {
  it('numbers columns the way Excel does, past Z', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
    expect(columnLetter(51)).toBe('AZ');
    expect(columnLetter(701)).toBe('ZZ');
    expect(columnLetter(702)).toBe('AAA');
  });

  it('numbers a sheet name that is already taken, as the legacy writer does', () => {
    const sheet = (name: string) => ({ name, headers: ['x'], rows: [] });
    const parts = workbookParts([sheet('Document'), sheet('Level'), sheet('Document'), sheet('Document')]);
    expect(sheetNames(parts)).toEqual(['Document', 'Level', 'Document 2', 'Document 3']);
  });

  it('names a free-form chart’s sheets so Excel will open the workbook', () => {
    // Not the sheet — the workbook: Excel rejects the whole file over one bad name, and a free-form
    // chart's level names are typed by a user. `\ / ? * [ ] :` go, and a name that collides after
    // that — or with one of the fixed sheets — is numbered.
    expect(sheetNames(xlsxParts(freeform, { chartId: 'c_par_free' }))).toEqual([
      'Document',
      'Initiative',
      'Work stream   phase',
      'Level 3',
      'Initiative 2',
      'Level 5',
      'Flows',
      'Deliverables',
      'Entities',
    ]);
  });
});

describe('the workbook', () => {
  const bytes = exportXlsx(workspace, { chartId });
  const parts = unzip(bytes);

  it('contains every part a reader needs to open it', () => {
    expect([...parts.keys()]).toEqual(
      expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels']),
    );
  });

  it('declares exactly as many sheets as it ships', () => {
    const declared = [...(parts.get('xl/workbook.xml')!.matchAll(/<sheet /g))].length;
    const files = [...parts.keys()].filter((p) => p.startsWith('xl/worksheets/')).length;
    const overrides = [...(parts.get('[Content_Types].xml')!.matchAll(/worksheets\/sheet/g))].length;
    const rels = [...(parts.get('xl/_rels/workbook.xml.rels')!.matchAll(/worksheets\/sheet/g))].length;
    expect(files).toBe(declared);
    expect(overrides).toBe(declared);
    expect(rels).toBe(declared);
  });

  it('is the Document sheet, one sheet per tier, then the flows and the registries', () => {
    const names = [...parts.get('xl/workbook.xml')!.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
    // The demo's flows hang off no chart row, so it has no Flows sheet.
    expect(names).toEqual([
      'Document', 'Portfolio', 'Program', 'Project', 'Task', 'Deliverables', 'Entities',
    ]);
    expect(sheetNames(xlsxParts(anchored, { chartId }))).toEqual([
      'Document', 'Portfolio', 'Program', 'Project', 'Task', 'Flows', 'Deliverables', 'Entities',
    ]);
  });

  it('carries every one of the 810 rows across its four tier sheets', () => {
    let rows = 0;
    for (const [path, xml] of parts) {
      if (!path.startsWith('xl/worksheets/')) continue;
      const name = path.match(/sheet(\d)/)![1]!;
      if (!['2', '3', '4', '5'].includes(name)) continue;
      rows += [...xml.matchAll(/<row /g)].length - 1; // less the header
    }
    expect(rows).toBe(810);
  });

  it('escapes markup in a cell rather than emitting it', () => {
    const nasty = structuredClone(workspace);
    const node = Object.values(nasty.charts[chartId]!.nodes)[0]!;
    node.name = 'Tom & Jerry </t></is></c><script>';
    const xml = unzip(exportXlsx(nasty, { chartId })).get('xl/worksheets/sheet2.xml')!;
    expect(xml).not.toContain('<script>');
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&lt;/t&gt;');
  });

  it('is deterministic — the same workspace produces the same bytes', () => {
    expect([...exportXlsx(workspace, { chartId })]).toEqual([...exportXlsx(workspace, { chartId })]);
  });

  it('prints the empty Untitled chart index.html makes for a workspace with no charts', () => {
    const sheets = workbookSheets({ ...workspace, charts: {}, chartOrder: {} });
    expect(sheets.map((s) => s.name)).toEqual([
      'Document', 'Portfolio', 'Program', 'Project', 'Task', 'Deliverables', 'Entities',
    ]);
    expect(sheets[0]!.rows).toEqual([['Chart', 'Untitled chart', 'Draft', '', '', '', '', '', '']]);
    expect(sheets.slice(1, 5).map((s) => s.rows.length)).toEqual([0, 0, 0, 0]);
  });

  it('is the chart in front — the first tab when none is named, or one that does not exist', () => {
    const want = workbookSheets(freeform, { chartId: 'c_53jst3no' });
    expect(workbookSheets(freeform)).toEqual(want);
    expect(workbookSheets(freeform, { chartId: 'c_nope' })).toEqual(want);
  });
});

describe('matches index.html part for part', () => {
  const inputs = { demo, anchored: anchoredVariant(demo), freeform: freeFormVariant(demo) } as const;
  for (const name of Object.keys(inputs) as Array<keyof typeof inputs>) {
    it(`${name}: every part of the workbook is the one index.html writes, in its order`, async () => {
      const want = golden.cases[name];
      const { workspace: ws } = importLegacy(inputs[name]);
      const got: Record<string, string> = {};
      for (const part of xlsxParts(ws, { chartId: want.chartId, ...CAPTURED })) {
        got[part.path] = (await sha256(part.content as string)).slice(0, 16);
      }
      // Compared as entries, so the part ORDER is held to the legacy's too.
      expect(Object.entries(got)).toEqual(Object.entries(want.xlsx));
    });
  }
});

describe('what the sheets say', () => {
  const sheets = buildLevelSheets(workspace, chart);

  it('writes the RESOLVED line, so an inherited owner still shows and a blank reads as Informed', () => {
    // A sheet printing only what each row states would drop the cascade — the entire point of a
    // nested chart — and be wrong in the way nobody notices until they act on it. "Blank-named
    // level" is R for legal only, and inherits its owner there from its parent's primary doer; the
    // parent of "Inherits nothing" has two doers and no primary, so the owner the row above THAT
    // passes down comes through instead.
    const level3 = buildLevelSheets(freeform, freeform.charts['c_par_free']!)[2]!;
    expect(level3.headers).toEqual([
      'Initiative', 'Work/stream: *phase*', 'Level 3', 'Executive Sponsor', 'Program Office <PMO>', 'Party',
    ]);
    expect(level3.rows).toEqual([
      ['Initiative — Policy Refresh', 'Workstream — Draft Directive', 'Blank-named level', 'I', 'I', 'RA'],
      ['Initiative — Policy Refresh', 'Two doers, no primary', 'Inherits nothing', 'I', 'AC', 'I'],
    ]);
  });

  it('repeats every ancestor on each row, so a sheet stands alone when filtered', () => {
    const tasks = sheets[3]!;
    expect(tasks.headers.slice(0, 4)).toEqual(['Portfolio', 'Program', 'Project', 'Task']);
    for (const row of tasks.rows.slice(0, 20)) {
      expect(row[0]).toBeTruthy();
      expect(row[1]).toBeTruthy();
      expect(row[2]).toBeTruthy();
    }
  });

  it('names the division and branch above each row, carried down to the rows below them', () => {
    expect(sheets[1]!.headers.slice(0, 3)).toEqual(['Portfolio', 'Program', 'Division']);
    expect(sheets[1]!.rows[0]![2]).toBe('DIRECTORATE A › Division A1 · Chief: Karen Anderson');
    expect(sheets[3]!.headers.slice(4, 6)).toEqual(['Division (inherited)', 'Branch (inherited)']);
    expect(sheets[3]!.rows[0]!.slice(4, 6)).toEqual([
      'DIRECTORATE A › Division A1 · Chief: Karen Anderson',
      'DIRECTORATE A › Division A1 › Branch A1.1 · Chief: Joshua Sanchez',
    ]);
  });

  it('sizes each tier sheet to that tier', () => {
    expect(sheets.map((s) => s.rows.length)).toEqual([11, 39, 117, 643]);
    expect(sheets.map((s) => s.name)).toEqual(['Portfolio', 'Program', 'Project', 'Task']);
  });

  it('says on the Document sheet what the file is, and when it was signed, in the locale asked for', () => {
    const rows = buildDocumentRows(anchored, anchored.charts[chartId]!, CAPTURED);
    expect(rows.map((r) => r.slice(0, 4))).toEqual([
      ['Chart', 'ASIC <RACI> & "Tool" ’s demo', 'Final', '3/4/2026'],
      ['Flow', 'Cyber Incident Response (Tabletop)', 'Final', '3/5/2026'],
      ['Flow', 'Evidence Preservation (procedure)', 'Draft', ''],
      ['Flow', 'Untitled', 'Draft', ''],
    ]);
    const british = buildDocumentRows(anchored, anchored.charts[chartId]!, {
      locale: 'en-GB',
      timeZone: 'UTC',
    });
    expect(british[0]![3]).toBe('04/03/2026');
  });

  it('ships a Flows sheet only for flows anchored to this chart', () => {
    // The demo's flows are unanchored, so there is nothing to carry — and a Flows sheet of zero
    // rows would be worse than no sheet.
    expect(buildFlowRows(workspace, chart)).toEqual([]);

    const rows = buildFlowRows(anchored, anchored.charts[chartId]!);
    expect([...new Set(rows.map((r) => r[1]))]).toEqual([
      'Cyber Incident Response (Tabletop)',
      'Evidence Preservation (procedure)',
    ]);
    // Every step names the chart row its flow hangs under, ancestors first.
    expect(rows[0]![0]).toBe(
      "Strategic Portfolio Vision & Objectives › Program Activity 1.1 › Project Activity 1.1.1 › Task Activity 1 — it's <anchored>",
    );
  });

  it('writes a step’s roles, parties, deliverables and next steps as the legacy does', () => {
    const rows = buildFlowRows(anchored, anchored.charts[chartId]!);
    const detect = rows.find((r) => r[4] === 'Detect & Triage')!;
    expect(detect.slice(9)).toEqual([
      'D&HQ: A | C&EW: R',
      'C&EW → Cyber "D" (default)',
      '',
      'Triage Report',
      '→ Declare Incident (Confirmed incident) [Triage Report]; → After-Action Review (False positive) [Triage Report]',
    ]);
    // A step with no name is "Untitled task" here, and "?" where another step points at it.
    expect(rows.find((r) => r[4] === 'Update risk register')![13]).toBe(
      '→ ? (Residual risk accepted) [Incident Declaration]',
    );
    expect(rows.some((r) => r[4] === 'Untitled task')).toBe(true);
  });

  it('traces a Chart-Linked step to its row, and marks a column it took back and says differently', () => {
    const rows = buildFlowRows(anchored, anchored.charts[chartId]!);
    const freeze = rows.find((r) => r[4] === 'Freeze the host')!;
    expect(freeze[3]).toBe('Chart-Linked');
    expect(freeze[6]).toBe(
      'Portfolio: ASIC <RACI> & "Tool" ’s demo › Strategic Portfolio Vision & Objectives',
    );
    expect(freeze[9]).toBe('D&HQ: A | CoS: R | Infra: C | C&EW: R (override) | S&S: C | CMO: I');
    expect(rows.find((r) => r[4] === 'Hand to legal')![6]).toBe('(linked row is missing)');
    expect(rows.find((r) => r[4] === 'Seal in evidence store')![6]).toBe('(not linked)');
  });

  it('exports a nested-flow box as a pointer, not as work', () => {
    const rows = buildFlowRows(anchored, anchored.charts[chartId]!);
    const nested = rows.find((row) => row[4]!.startsWith('⧉ '))!;
    expect(nested.slice(4, 6)).toEqual([
      '⧉ Preserve evidence',
      'Nested flow → Evidence Preservation (procedure) — Runs alongside containment — the same procedure every incident uses.',
    ]);
    expect(nested.slice(9, 11)).toEqual(['', '']);
  });

  it('lists each deliverable’s type and both ends of it, once per handoff, as the legacy does', () => {
    const rows = buildDeliverableRows(workspace);
    // "Detect & Triage" carries it away on two branches, and the legacy names it for each.
    expect(rows.find((row) => row[0] === 'Triage Report')).toEqual([
      'Triage Report',
      'document',
      'Detect & Triage, Detect & Triage',
      'Declare Incident, After-Action Review',
    ]);
  });

  it('lists entities with everywhere they are named', () => {
    const wired = structuredClone(workspace);
    const entity = Object.values(wired.entities)[0]!;
    const flow = Object.values(wired.flows)[0]!;
    const step = Object.values(flow.steps).find((s) => s.kind === 'step')!;
    step.parties = { hq: { entityId: entity.id } };

    const row = buildEntityRows(wired).find((r) => r[0] === entity.name)!;
    expect(row[1]).toBeTruthy();
    expect(row[5]).toContain(step.name);
    expect(row[5]).toContain(flow.name);
  });
});

describe('the blank template', () => {
  const sheets = buildTemplateSheets();

  it('writes a workbook with headers and no data', () => {
    const bytes = writeWorkbook([{ name: 'Portfolio', headers: ['Portfolio', 'A', 'B'], rows: [] }]);
    const xml = unzip(bytes).get('xl/worksheets/sheet1.xml')!;
    expect([...xml.matchAll(/<row /g)]).toHaveLength(1);
    expect(xml).toContain('Portfolio');
  });

  it('leads with instructions, because every rule in them is one the importer enforces silently', () => {
    expect(sheets[0]!.name).toBe('Instructions');
    const text = sheets[0]!.rows.flat().join('\n');
    expect(text).toContain('ONE ROW PER ACTIVITY');
    expect(text).toContain('repeat its parents to its left');
    // The gap rule is the one that loses rows without saying so.
    expect(text).toMatch(/Do not leave a gap/);
  });

  it('names the grid sheet what the importer looks for', () => {
    // Renaming this breaks the round trip, which is why it is a constant and not a label.
    expect(sheets[1]!.name).toBe('RACI');
  });

  it('has the same shape the export writes — four tiers then the party columns', () => {
    expect(sheets[1]!.headers.slice(0, 4)).toEqual(['Portfolio', 'Program', 'Project', 'Task']);
    expect(sheets[1]!.headers.length).toBe(4 + 7);
    for (const row of sheets[1]!.rows) expect(row).toHaveLength(4 + 7);
  });

  it('shows a worked example at each depth', () => {
    // The "repeat the parents to the left" rule is much faster to see than to read.
    const filled = sheets[1]!.rows.slice(0, 4);
    expect(filled.map((r) => r.slice(0, 4).filter(Boolean).length)).toEqual([1, 2, 3, 4]);
  });

  it('leaves blank rows to type into', () => {
    const blanks = sheets[1]!.rows.filter((r) => r.every((c) => c === ''));
    expect(blanks.length).toBeGreaterThan(10);
  });

  it('takes the party column names from the workspace, so a renamed chart gets its own template', () => {
    const renamed = structuredClone(workspace);
    renamed.columnLabels['hq'] = 'Head Office';
    expect(buildTemplateSheets(renamed)[1]!.headers).toContain('Head Office');
  });

  it('tells you what an entity Kind may be, next to where you type it', () => {
    const entities = buildTemplateSheets().find((s) => s.name === 'Entities')!;
    expect(entities.rows[0]![4]).toContain('board');
    expect(entities.rows[0]![4]).toContain('vendor');
  });

  it('packs into a workbook a reader can open', () => {
    const parts = unzip(exportTemplate());
    expect(parts.has('xl/workbook.xml')).toBe(true);
    const names = [...parts.get('xl/workbook.xml')!.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(['Instructions', 'RACI', 'Entities', 'Document']);
  });
});
