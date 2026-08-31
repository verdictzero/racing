import { describe, it, expect } from 'vitest';
import demo from '../__fixtures__/demo-workspace.json' with { type: 'json' };
import { importLegacy } from '../legacy.js';
import {
  buildChartSheets,
  buildDeliverableRows,
  buildEntityRows,
  buildFlowRows,
  buildTemplateSheets,
  columnLetter,
  exportTemplate,
  exportXlsx,
  sheetName,
  writeWorkbook,
} from './xlsx.js';
import { crc32, zipBytes } from './zip.js';

const { workspace } = importLegacy(demo);
const chartId = Object.keys(workspace.charts)[0]!;
const chart = workspace.charts[chartId]!;

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

  it('strips the characters that make Excel reject the whole workbook', () => {
    // Not the sheet — the workbook. A free-form chart's tier names are typed by a user, so this is
    // reachable in normal use and the failure is a file that will not open at all.
    const taken = new Set<string>();
    expect(sheetName('Plans / Ops [2026]:*?', taken)).not.toMatch(/[\\/?*[\]:]/);
  });

  it('caps a long name at what Excel allows', () => {
    const taken = new Set<string>();
    expect(sheetName('x'.repeat(80), taken).length).toBeLessThanOrEqual(31);
  });

  it('deduplicates names that collide only after sanitizing', () => {
    const taken = new Set<string>();
    const a = sheetName('Ops/Plans', taken);
    const b = sheetName('Ops[Plans', taken);
    expect(a).not.toBe(b);
  });

  it('falls back rather than emitting an empty name', () => {
    const taken = new Set<string>();
    expect(sheetName('///', taken, 'Sheet 3')).toBe('Sheet 3');
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

  it('has one sheet per tier plus the Document header', () => {
    const names = [...parts.get('xl/workbook.xml')!.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
    expect(names.slice(0, 5)).toEqual(['Document', 'Portfolio', 'Program', 'Project', 'Task']);
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

  it('returns a valid one-sheet workbook for a workspace with no charts', () => {
    const empty = exportXlsx({ ...workspace, charts: {} });
    expect(unzip(empty).has('xl/worksheets/sheet1.xml')).toBe(true);
  });
});

describe('what the sheets say', () => {
  const sheets = buildChartSheets(workspace, chart);

  it('writes the RESOLVED RACI, so an inherited owner still shows', () => {
    // A sheet printing only what each row states would drop the cascade — the entire point of a
    // nested chart — and be wrong in the way nobody notices until they act on it.
    const tasks = sheets[3]!;
    const ownerAt = tasks.headers.length - tasks.headers.slice(5).length;
    const withOwner = tasks.rows.filter((row) => row.slice(ownerAt).some((cell) => cell.includes('A')));
    expect(withOwner.length).toBe(tasks.rows.length);
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

  it('names the org unit each row is assigned to', () => {
    const programs = sheets[1]!;
    expect(programs.headers).toContain('Org unit');
    expect(programs.rows.some((row) => row[2] !== '')).toBe(true);
  });

  it('sizes each tier sheet to that tier', () => {
    expect(sheets.map((s) => s.rows.length)).toEqual([11, 39, 117, 643]);
    expect(sheets.map((s) => s.name)).toEqual(['Portfolio', 'Program', 'Project', 'Task']);
  });

  it('ships a Flows sheet only for flows anchored to this chart', () => {
    // The demo's flows are unanchored, so there is nothing to carry — and a Flows sheet of zero
    // rows would be worse than no sheet.
    expect(buildFlowRows(workspace, chart)).toEqual([]);

    const anchored = structuredClone(workspace);
    const leaf = Object.values(anchored.charts[chartId]!.nodes).find(
      (n) => !Object.values(anchored.charts[chartId]!.nodes).some((c) => c.parentId === n.id),
    )!;
    const flowId = Object.keys(anchored.flows)[0]!;
    anchored.flows[flowId]!.anchor = { chartId, nodeId: leaf.id };

    const rows = buildFlowRows(anchored, anchored.charts[chartId]!);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]![1]).toBe(anchored.flows[flowId]!.name);
    // Every step names the chart row the flow hangs under.
    for (const row of rows) expect(row[0]).toContain(leaf.name);
  });

  it('exports a nested-flow box as a pointer, not as work', () => {
    const anchored = structuredClone(workspace);
    const chartNodes = anchored.charts[chartId]!.nodes;
    const leaf = Object.values(chartNodes).find(
      (n) => !Object.values(chartNodes).some((c) => c.parentId === n.id),
    )!;
    const flowId = Object.entries(anchored.flows).find(([, f]) =>
      Object.values(f.steps).some((s) => s.kind === 'subflow'),
    )![0];
    anchored.flows[flowId]!.anchor = { chartId, nodeId: leaf.id };

    const rows = buildFlowRows(anchored, anchored.charts[chartId]!);
    const nested = rows.find((row) => row[4]!.startsWith('⧉ '))!;
    expect(nested).toBeDefined();
    expect(nested[5]).toContain('Nested flow →');
  });

  it('lists deliverables with both ends of each, deduplicated by place', () => {
    const rows = buildDeliverableRows(workspace);
    const triage = rows.find((row) => row[0] === 'Triage Report')!;
    expect(triage).toBeDefined();
    expect(triage[1]).toBe('Document');
    // "Detect & Triage" carries it away on two branches. It produces it ONCE — a cell naming the
    // step twice would read as two producers.
    expect(triage[2]).toBe('Detect & Triage');
    expect(triage[3]).toContain('Declare Incident');
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
