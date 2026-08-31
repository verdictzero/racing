import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import demo from '../__fixtures__/demo-workspace.json' with { type: 'json' };
import { importLegacy } from '../legacy.js';
import { exportXlsx, exportTemplate, writeWorkbook } from '../export/xlsx.js';
import { zipBytes } from '../export/zip.js';
import { unzip, ZipError } from './unzip.js';
import { decodeEntities, findElements, textOf } from './xml.js';
import {
  columnFromRef,
  deriveShort,
  findHeaderRow,
  importWorkbook,
  importXlsx,
  isContextHeader,
  readWorkbook,
  WorkbookError,
  type SheetGrid,
} from './xlsx.js';

const { workspace } = importLegacy(demo);

/** A grid, the way a person would lay one out. */
const grid = (name: string, rows: string[][]): SheetGrid => ({ name, rows });

const HEADER = ['Portfolio', 'Program', 'Project', 'Task', 'Ops', 'Legal', 'Finance'];
const simple = () =>
  grid('RACI', [
    HEADER,
    ['Alpha', '', '', '', 'A', 'R', 'C'],
    ['Alpha', 'Beta', '', '', '', 'A', 'R'],
    ['Alpha', 'Beta', 'Gamma', '', 'R', '', 'A'],
    ['Alpha', 'Beta', 'Gamma', 'Delta', 'AR', '', 'I'],
  ]);

describe('the XML scanner', () => {
  it('decodes the entities a real file actually contains', () => {
    // A party called "R&D" arrives as R&amp;D. Getting this wrong is silent and ugly.
    expect(decodeEntities('R&amp;D &lt;x&gt; &quot;q&quot; &apos;a&apos;')).toBe(`R&D <x> "q" 'a'`);
    expect(decodeEntities('&#65;&#x42;')).toBe('AB');
  });

  it('leaves an entity it does not know as written, rather than mangling it', () => {
    expect(decodeEntities('&nbsp;&#xZZ;')).toBe('&nbsp;&#xZZ;');
  });

  it('reads attributes in either quoting style', () => {
    const [el] = findElements(`<c r="A1" t='s'>x</c>`, 'c');
    expect(el!.attrs.r).toBe('A1');
    expect(el!.attrs.t).toBe('s');
  });

  it('handles a self-closing element', () => {
    const [el] = findElements('<c r="A1"/>', 'c');
    expect(el!.selfClosing).toBe(true);
    expect(el!.text).toBe('');
  });

  it('ignores a namespace prefix, because a writer may or may not use one', () => {
    expect(findElements('<x:row r="1"><x:c/></x:row>', 'row')).toHaveLength(1);
    expect(findElements('<row r="1"></row>', 'row')).toHaveLength(1);
  });

  it('does not treat a similarly-named element as a match', () => {
    expect(findElements('<rows/><row r="1"/>', 'row')).toHaveLength(1);
  });

  it('concatenates the text of nested runs', () => {
    expect(textOf('<is><t>Hello </t><t>world</t></is>')).toBe('Hello world');
  });
});

describe('the ZIP reader', () => {
  it('reads back what the writer wrote', async () => {
    const bytes = zipBytes([
      { path: 'a.xml', content: '<a/>' },
      { path: 'b/c.rels', content: '<r/>' },
    ]);
    const { files } = await unzip(bytes);
    expect(new TextDecoder().decode(files.get('a.xml')!)).toBe('<a/>');
    expect(files.has('b/c.rels')).toBe(true);
  });

  it('skips entries the caller does not want, before inflating them', async () => {
    const bytes = zipBytes([
      { path: 'keep.xml', content: '<a/>' },
      { path: 'media/huge.png', content: new Uint8Array(1000) },
    ]);
    const { files } = await unzip(bytes, (p) => p.endsWith('.xml'));
    expect([...files.keys()]).toEqual(['keep.xml']);
  });

  it('says what is wrong when the bytes are not a ZIP at all', async () => {
    await expect(unzip(new TextEncoder().encode('this is a CSV, actually'))).rejects.toThrow(ZipError);
    await expect(unzip(new TextEncoder().encode('nope'))).rejects.toThrow(/not a \.xlsx/i);
  });

  it('finds the directory even when a comment follows it', async () => {
    const base = zipBytes([{ path: 'a.xml', content: '<a/>' }]);
    // Rewrite the comment length and append one, the way some writers do.
    const withComment = new Uint8Array(base.length + 5);
    withComment.set(base);
    const view = new DataView(withComment.buffer);
    view.setUint16(base.length - 2, 5, true);
    withComment.set(new TextEncoder().encode('hello'), base.length);
    const { files } = await unzip(withComment);
    expect(files.has('a.xml')).toBe(true);
  });
});

describe('finding the table in a sheet', () => {
  it('finds a header naming tiers followed by party columns', () => {
    const hit = findHeaderRow(simple().rows)!;
    expect(hit.headerRow).toBe(0);
    expect(hit.pathCols).toEqual([0, 1, 2, 3]);
    expect(hit.partyCols).toEqual([4, 5, 6]);
  });

  it('looks past a title block, because a kept spreadsheet has one', () => {
    const rows = [['Cyber Directorate RACI'], [], ['Updated March 2026'], [], ...simple().rows];
    expect(findHeaderRow(rows)!.headerRow).toBe(4);
  });

  it('gives up rather than scanning a whole sheet for a header', () => {
    const rows = [...Array.from({ length: 40 }, () => ['filler']), ...simple().rows];
    expect(findHeaderRow(rows)).toBeNull();
  });

  it('needs two party columns — one stray column beside a tier is a note, not a matrix', () => {
    expect(findHeaderRow([['Portfolio', 'Comment'], ['x', 'y']])).toBeNull();
    expect(findHeaderRow([['Portfolio', 'Ops', 'Legal'], ['x', 'A', 'R']])).not.toBeNull();
  });

  it('skips the context columns, which carry org names and not letters', () => {
    // Feeding one to the letter parser would mine a C out of "DIRECTORATE C" and shift every real
    // party column along by one.
    for (const header of ['Division', 'Branch', 'Org unit', 'Organisation', 'Notes', 'Division (inherited)']) {
      expect(isContextHeader(header)).toBe(true);
    }
    expect(isContextHeader('Ops')).toBe(false);

    const hit = findHeaderRow([
      ['Portfolio', 'Org unit', 'Division (inherited)', 'Ops', 'Legal'],
      ['Alpha', 'DIRECTORATE C', 'Cyber', 'A', 'R'],
    ])!;
    expect(hit.partyCols).toEqual([3, 4]);
  });

  it('reads a cell reference back to a column index, past Z', () => {
    expect(columnFromRef('A1')).toBe(0);
    expect(columnFromRef('Z9')).toBe(25);
    expect(columnFromRef('AA1')).toBe(26);
    expect(columnFromRef('AAA1')).toBe(702);
  });

  it('derives an abbreviation the way the app does', () => {
    expect(deriveShort('Chief of Staff')).toBe('COS');
    expect(deriveShort('Ops')).toBe('Ops');
    expect(deriveShort('')).toBe('?');
  });
});

describe('building a chart from a grid', () => {
  it('nests rows by how far their path is filled', () => {
    const { chart, stats } = importWorkbook([simple()]);
    expect(stats.rows).toBe(4);
    expect(stats.nodes).toBe(4);
    const byName = Object.fromEntries(Object.values(chart.nodes).map((n) => [n.name, n]));
    expect(byName.Alpha!.parentId).toBeNull();
    expect(byName.Beta!.parentId).toBe(byName.Alpha!.id);
    expect(byName.Gamma!.parentId).toBe(byName.Beta!.id);
    expect(byName.Delta!.parentId).toBe(byName.Gamma!.id);
  });

  it('creates a parent that only a child row named', () => {
    // "A parent does not need its own row" — the template says so, so it has to be true.
    const { chart, stats } = importWorkbook([
      grid('RACI', [HEADER, ['Alpha', 'Beta', 'Gamma', '', 'A', 'R', '']]),
    ]);
    expect(stats.rows).toBe(1);
    expect(stats.nodes).toBe(3);
    expect(Object.values(chart.nodes).map((n) => n.name).sort()).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('normalizes the letters a person typed', () => {
    const { chart } = importWorkbook([
      grid('RACI', [HEADER, ['Alpha', '', '', '', ' ar ', 'xyz', 'c']]),
    ]);
    const node = Object.values(chart.nodes)[0]!;
    expect(node.raci.hq).toBe('RA'); // canonical order, matching index.html
    expect(node.raci.cos).toBeUndefined(); // nothing recognizable
    expect(node.raci.mission).toBe('C');
  });

  it('skips a row that leaves a gap in its hierarchy, and says how many', () => {
    // Excel users do this constantly. Guessing where it belongs would be worse than saying so.
    const { stats, warnings } = importWorkbook([
      grid('RACI', [
        HEADER,
        ['Alpha', '', '', '', 'A', 'R', ''],
        ['Alpha', '', 'Orphan', '', 'A', 'R', ''],
      ]),
    ]);
    expect(stats.rows).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(warnings.join(' ')).toMatch(/1 row skipped/);
  });

  it('ignores a wholly blank row without counting it as skipped', () => {
    const { stats } = importWorkbook([
      grid('RACI', [HEADER, ['Alpha', '', '', '', 'A', 'R', ''], [], ['', '', '', '', '', '', '']]),
    ]);
    expect(stats.skipped).toBe(0);
  });

  it('reads every recognizable sheet into ONE tree', () => {
    // An export writes a sheet per tier and each tier's letters live only on its own sheet.
    // Reading the deepest alone would rebuild the shape with every row above the bottom blank.
    const { chart, stats } = importWorkbook([
      grid('Portfolio', [['Portfolio', 'Ops', 'Legal'], ['Alpha', 'A', '']]),
      grid('Program', [['Portfolio', 'Program', 'Ops', 'Legal'], ['Alpha', 'Beta', '', 'A']]),
    ]);
    expect(stats.sheets).toEqual(['Portfolio', 'Program']);
    expect(stats.nodes).toBe(2);
    const byName = Object.fromEntries(Object.values(chart.nodes).map((n) => [n.name, n]));
    expect(byName.Alpha!.raci.hq).toBe('A');
    expect(byName.Beta!.raci.cos).toBe('A');
  });

  it('never lets a blank cell on one sheet wipe what another sheet set', () => {
    const { chart } = importWorkbook([
      grid('Portfolio', [['Portfolio', 'Ops', 'Legal'], ['Alpha', 'A', 'R']]),
      grid('Program', [['Portfolio', 'Program', 'Ops', 'Legal'], ['Alpha', 'Beta', '', '']]),
    ]);
    const alpha = Object.values(chart.nodes).find((n) => n.name === 'Alpha')!;
    expect(alpha.raci.hq).toBe('A');
    expect(alpha.raci.cos).toBe('R');
  });

  it('takes the workbook’s own party names as the column labels', () => {
    const { labels, shorts } = importWorkbook([simple()]);
    expect(labels.hq).toBe('Ops');
    expect(labels.cos).toBe('Legal');
    expect(shorts.cos).toBe('Legal');
  });

  it('drops party columns past what an org chart has, and says so', () => {
    const wide = ['Portfolio', ...Array.from({ length: 9 }, (_, i) => `P${i}`)];
    const { stats, warnings } = importWorkbook([
      grid('RACI', [wide, ['Alpha', ...Array.from({ length: 9 }, () => 'A')]]),
    ]);
    expect(stats.columns).toBe(7);
    expect(warnings.join(' ')).toMatch(/9 party columns found/);
  });

  it('explains itself when there is no table at all', () => {
    expect(() => importWorkbook([grid('Sheet1', [['a', 'b'], ['1', '2']])])).toThrow(WorkbookError);
    expect(() => importWorkbook([grid('Sheet1', [['a']])])).toThrow(/Download the Excel template/);
  });

  it('explains itself when there is a header but nothing under it', () => {
    expect(() => importWorkbook([grid('RACI', [HEADER])])).toThrow(/no usable rows/);
  });

  it('reads the Entities sheet when there is one', () => {
    const { entities } = importWorkbook([
      simple(),
      grid('Entities', [
        ['Entity', 'Kind', 'Short', 'Lead', 'Description'],
        ['Cyber Review Board', 'board', 'CRB', 'A. Person', 'Reviews incidents'],
        ['', '', '', '', ''],
        ['Some Vendor', 'nonsense-kind', '', '', ''],
      ]),
    ]);
    expect(entities).toHaveLength(2);
    expect(entities[0]!.short).toBe('CRB');
    expect(entities[0]!.lead!.name).toBe('A. Person');
    // An unrecognized kind becomes "other" rather than failing the import.
    expect(entities[1]!.kind).toBe('other');
  });

  it('takes the chart’s name and metadata from the Document sheet', () => {
    const { chart } = importWorkbook([
      simple(),
      grid('Document', [
        ['Kind', 'Name', 'Status', 'Signed', 'Customer', 'Priority', 'Budget', 'Tags', 'Description'],
        ['Chart', 'Cyber Response', 'Draft', '', 'J3', 'normal', '$1m', 'cyber, ir', 'A description'],
      ]),
    ]);
    expect(chart.title).toBe('Cyber Response');
    expect(chart.meta.customer).toBe('J3');
    expect(chart.meta.priority).toBe('normal');
    expect(chart.meta.tags).toEqual(['cyber', 'ir']);
  });

  it('does not name a chart after the template’s own placeholder', () => {
    const { chart } = importWorkbook(
      [simple(), grid('Document', [['Kind', 'Name'], ['Chart', 'Untitled chart']])],
      { fileName: 'ops-raci.xlsx' },
    );
    expect(chart.title).toBe('ops-raci');
  });

  it('falls back to the file name, minus its extension', () => {
    expect(importWorkbook([simple()], { fileName: 'Q3 plan.xlsx' }).chart.title).toBe('Q3 plan');
    expect(importWorkbook([simple()]).chart.title).toBe('Imported chart');
  });
});

describe('reading a real .xlsx', () => {
  it('reads back the workbook this package writes', async () => {
    const sheets = await readWorkbook(exportXlsx(workspace));
    expect(sheets.map((s) => s.name)).toEqual([
      'Document', 'Portfolio', 'Program', 'Project', 'Task', 'Deliverables', 'Entities',
    ]);
    expect(sheets.find((s) => s.name === 'Task')!.rows).toHaveLength(644);
  });

  it('round-trips the whole 810-row demo through Excel and back', async () => {
    // The workflow the stakeholder asked for: export, edit in Excel, load back. If this breaks,
    // the two halves have forked and neither of them says so.
    const result = await importXlsx(exportXlsx(workspace), { fileName: 'demo.xlsx' });
    expect(result.stats.rows).toBe(810);
    expect(result.stats.nodes).toBe(810);
    expect(result.stats.columns).toBe(7);
    expect(result.stats.skipped).toBe(0);
    expect(result.chart.title).toBe('ASIC RACI Tool Demo');
  });

  it('does not mistake the export’s Org unit column for a party', () => {
    // It carries org names. Read as letters it would mine a C out of "DIRECTORATE C" and shift
    // every real party column along by one — silently, and wrong on every row.
    const { labels } = importWorkbook([
      grid('Task', [
        ['Portfolio', 'Program', 'Project', 'Task', 'Org unit', 'Director / HQ', 'Chief of Staff'],
        ['Alpha', 'Beta', 'Gamma', 'Delta', 'DIRECTORATE C', 'A', 'R'],
      ]),
    ]);
    expect(labels.hq).toBe('Director / HQ');
    expect(labels.cos).toBe('Chief of Staff');
  });

  it('reads the blank template, which is what a person actually fills in', async () => {
    const result = await importXlsx(exportTemplate());
    // The template's four worked examples, one at each depth.
    expect(result.stats.rows).toBe(4);
    expect(result.stats.nodes).toBe(4);
    expect(result.entities).toHaveLength(1);
  });

  it('refuses a workbook with no worksheet part, in words a person can act on', async () => {
    const notAWorkbook = zipBytes([{ path: 'hello.xml', content: '<x/>' }]);
    await expect(readWorkbook(notAWorkbook)).rejects.toThrow(/xl\/workbook\.xml is missing/);
  });

  it('reads sheets under their real names, in the workbook’s own order', async () => {
    const sheets = await readWorkbook(
      writeWorkbook([
        { name: 'Second', headers: ['a'], rows: [['1']] },
        { name: 'First', headers: ['b'], rows: [['2']] },
      ]),
    );
    expect(sheets.map((s) => s.name)).toEqual(['Second', 'First']);
    expect(sheets[0]!.rows[1]).toEqual(['1']);
  });
});

describe('a workbook written by something else', () => {
  /**
   * Written by openpyxl — shared strings, deflate-compressed parts, and the extra parts Excel
   * includes. A reader tested only against our own output (inline strings, store-only) would pass
   * every test above and still be unable to open a single file a user actually has.
   */
  const foreign = new Uint8Array(
    readFileSync(fileURLToPath(new URL('../__fixtures__/foreign-workbook.xlsx', import.meta.url))),
  );

  it('inflates deflate-compressed parts', async () => {
    const sheets = await readWorkbook(foreign);
    expect(sheets.map((s) => s.name)).toEqual(['RACI', 'Entities', 'Document']);
  });

  it('resolves shared strings, decoding entities inside them', async () => {
    // "R&D" lives in the shared-string table as R&amp;D. Getting this wrong is silent and ugly.
    const sheets = await readWorkbook(foreign);
    expect(sheets[0]!.rows[2]).toContain('R&D');
    expect(sheets[1]!.rows[1]).toContain('Reviews & approves');
  });

  it('imports it end to end, the way a person’s own spreadsheet would', async () => {
    const result = await importXlsx(foreign, { fileName: 'foreign.xlsx' });

    expect(result.chart.title).toBe('Cyber Response');           // from the Document sheet
    expect(result.stats.rows).toBe(2);
    expect(result.stats.skipped).toBe(1);                        // the row with a gap
    expect(result.labels).toEqual({ hq: 'R&D', cos: 'Legal Ops' });

    const byName = Object.fromEntries(Object.values(result.chart.nodes).map((n) => [n.name, n]));
    expect(byName.Beta!.parentId).toBe(byName.Alpha!.id);
    expect(byName.Beta!.raci.hq).toBe('RA');                     // "ar" normalized
    expect(byName.Alpha!.raci.hq).toBe('A');                     // "Org unit" not read as a party

    expect(result.entities[0]!.short).toBe('CRB');
    expect(result.chart.meta.tags).toEqual(['cyber', 'ir']);
  });
});
