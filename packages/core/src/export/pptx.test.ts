import { describe, it, expect } from 'vitest';
import demo from '../__fixtures__/demo-workspace.json' with { type: 'json' };
// Digests of what index.html's own `pptxBytes()` wrote for the demo and two variations of it, run
// headless in Chromium (en-US, UTC) by scripts/capture-legacy-parity.mjs — rerun it when index.html
// changes the export.
import golden from '../__fixtures__/legacy-parity.json' with { type: 'json' };
import { anchoredVariant, freeFormVariant } from '../__fixtures__/parity-variants.js';
import { importLegacy } from '../legacy.js';
import { unzip } from '../import/unzip.js';
import { buildLevelSheets, chartFileBase, chartToPptx, pptxParts } from './pptx.js';

/** The locale and zone the golden capture ran in — the only inputs besides the workspace. */
const CAPTURED = { locale: 'en-US', timeZone: 'UTC' } as const;

const FIXED_PARTS = [
  '[Content_Types].xml',
  '_rels/.rels',
  'ppt/presentation.xml',
  'ppt/_rels/presentation.xml.rels',
  'ppt/slideMasters/slideMaster1.xml',
  'ppt/slideMasters/_rels/slideMaster1.xml.rels',
  'ppt/slideLayouts/slideLayout1.xml',
  'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
  'ppt/theme/theme1.xml',
];

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function sha256(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The heading a table slide carries. */
const heading = (xml: string) => /name="Heading".*?<a:t>(.*?)<\/a:t>/.exec(xml)?.[1] ?? null;

/** A table slide's rows, as cell texts. */
const tableRows = (xml: string) =>
  [...xml.matchAll(/<a:tr h="\d+">(.*?)<\/a:tr>/g)].map((m) =>
    [...m[1]!.matchAll(/<a:t>(.*?)<\/a:t>/g)].map((c) => c[1]!),
  );

describe('the PowerPoint export', () => {
  const { workspace } = importLegacy(demo);
  const chartId = golden.cases.demo.chartId;

  it('is a package of the legacy parts, in the legacy order', async () => {
    const { files } = await unzip(chartToPptx(workspace, chartId));
    const paths = [...files.keys()];
    expect(paths.slice(0, FIXED_PARTS.length)).toEqual(FIXED_PARTS);
    const slides = (paths.length - FIXED_PARTS.length) / 2;
    expect(paths.slice(FIXED_PARTS.length)).toEqual(
      Array.from({ length: slides }, (_, i) => [
        `ppt/slides/slide${i + 1}.xml`,
        `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      ]).flat(),
    );
  });

  it('is a title slide, then each tier thirteen rows a slide — 64 slides for the demo', async () => {
    // 11 portfolios, 39 programs, 117 projects, 643 tasks: 1 + 1 + 3 + 9 + 50.
    const { files } = await unzip(chartToPptx(workspace, chartId));
    const headings = [...files.keys()]
      .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
      .map((p) => heading(decode(files.get(p)!)));
    expect(headings).toHaveLength(64);
    expect(headings[0]).toBeNull(); // the title slide has a Title box, not a Heading
    expect(headings.slice(1, 6)).toEqual([
      'Portfolio',
      'Program  (1/3)',
      'Program  (2/3)',
      'Program  (3/3)',
      'Project  (1/9)',
    ]);
    expect(headings.at(-1)).toBe('Task  (50/50)');

    const presentation = decode(files.get('ppt/presentation.xml')!);
    expect(presentation.match(/<p:sldId /g)).toHaveLength(64);
    expect(presentation).toContain('<p:sldSz cx="12192000" cy="6858000"/>');
    const types = decode(files.get('[Content_Types].xml')!);
    expect(types.match(/presentationml\.slide\+xml/g)).toHaveLength(64);
    const rels = decode(files.get('ppt/_rels/presentation.xml.rels')!);
    expect(rels).toContain(
      '<Relationship Id="rId65" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide64.xml"/>',
    );
  });

  it('writes the status on the title slide, both ways, as the legacy does', async () => {
    const { files } = await unzip(chartToPptx(workspace, chartId));
    const title = decode(files.get('ppt/slides/slide1.xml')!);
    expect(title).toContain('<a:t>DRAFT — ASIC RACI Tool Demo</a:t>');
    expect(title).toContain('<a:t>RACI responsibility matrix · Draft</a:t>');
  });

  it('prints each row with its ancestors, its roster unit and its resolved line', async () => {
    const { files } = await unzip(chartToPptx(workspace, chartId));
    const [header, first] = tableRows(decode(files.get('ppt/slides/slide2.xml')!));
    expect(header).toEqual([
      'Portfolio',
      'Director / HQ',
      'Chief of Staff',
      'Mission Mgmt Dir.',
      'Infrastructure Dir.',
      'Cyber &amp; EW Dir.',
      'Software &amp; Support Dir. (HQ)',
      'Contract Management Office',
    ]);
    expect(first).toEqual([
      'Strategic Portfolio Vision &amp; Objectives',
      'A',
      'R',
      'C',
      'C',
      'C',
      'C',
      'I',
    ]);
    // A Program row names its division — with its chief, as the legacy's label does.
    const [programHeader, program] = tableRows(decode(files.get('ppt/slides/slide3.xml')!));
    expect(programHeader!.slice(0, 3)).toEqual(['Portfolio', 'Program', 'Division']);
    expect(program![2]).toMatch(/^DIRECTORATE A › Division A1 · Chief: /);
  });

  it('is deterministic', () => {
    const [a, b] = [chartToPptx(workspace, chartId), chartToPptx(workspace, chartId)];
    // Compared by hand: a structural diff of two 4 MB arrays takes the test runner seconds.
    expect(a.length).toBe(b.length);
    expect(a.findIndex((byte, i) => byte !== b[i])).toBe(-1);
  });

  it('refuses a chart the workspace does not have', () => {
    expect(() => chartToPptx(workspace, 'c_nope')).toThrow(/no such chart/);
  });

  it('names the file the way index.html does', () => {
    expect(chartFileBase({ title: 'ASIC RACI Tool Demo' })).toBe('ASIC_RACI_Tool_Demo');
    expect(chartFileBase({ title: '' })).toBe('raci');
  });

  describe('matches index.html part for part', () => {
    const inputs = {
      demo,
      anchored: anchoredVariant(demo),
      freeform: freeFormVariant(demo),
    } as const;
    for (const name of Object.keys(inputs) as Array<keyof typeof inputs>) {
      it(`${name}: every slide, and every other part, is the one index.html writes`, async () => {
        const want = golden.cases[name];
        const { workspace: ws } = importLegacy(inputs[name]);
        const parts = pptxParts(ws, want.chartId, CAPTURED);
        expect(parts).toHaveLength(want.parts);

        const isSlide = (path: string) => /^ppt\/slides\/slide\d+\.xml$/.test(path);
        const slides: Record<string, string> = {};
        for (const part of parts.filter((p) => isSlide(p.path))) {
          slides[part.path] = (await sha256(part.content as string)).slice(0, 16);
        }
        expect(slides).toEqual(want.slides);

        const others = parts
          .filter((p) => !isSlide(p.path))
          .map((p) => `${p.path}\n${p.content as string}`)
          .join('\n\u0000\n');
        expect(await sha256(others)).toBe(want.otherParts);
        expect(chartFileBase(ws.charts[want.chartId]!)).toBe(want.fileBase);
      });
    }
  });

  describe('anchored flows', () => {
    const { workspace: ws } = importLegacy(anchoredVariant(demo));
    const flowSlides = () =>
      pptxParts(ws, chartId, CAPTURED)
        .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p.path))
        .map((p) => p.content as string)
        .filter((xml) => heading(xml)?.includes('Flow ('));

    it('follow the tiers, eight steps a slide, and only the flows anchored to THIS chart', () => {
      const titles = flowSlides().map(heading);
      expect(titles).toEqual([
        '[FINAL] Flow (Free-Form) — Cyber Incident Response (Tabletop)  (⚓ Task Activity 1 — it&#39;s &lt;anchored&gt;)  (1/2)',
        '[FINAL] Flow (Free-Form) — Cyber Incident Response (Tabletop)  (⚓ Task Activity 1 — it&#39;s &lt;anchored&gt;)  (2/2)',
        '[DRAFT] Flow (Chart-Linked) — Evidence Preservation (procedure)  (⚓ Task Activity 2)',
        '[DRAFT] Flow (Free-Form) — Untitled  (⚓ Strategic Portfolio Vision &amp; Objectives)',
      ]);
    });

    it('show a linked step the chart row it implements, and say when it has none', () => {
      const linked = tableRows(flowSlides()[2]!);
      expect(linked[0]).toEqual([
        'Step',
        'Linked chart row',
        'Roles',
        'Responsible parties',
        'Inputs',
        'Outputs',
        'Next / condition',
      ]);
      const link = Object.fromEntries(linked.slice(1).map((r) => [r[0], r[1]]));
      expect(link['Freeze the host']).toMatch(/^Portfolio: ASIC &lt;RACI&gt;/);
      expect(link['Capture disk image']).toMatch(/^Program: .* › Program Activity 1\.1$/);
      expect(link['Hand to legal']).toBe('(linked row is missing)');
      expect(link['Seal in evidence store']).toBe('(not linked)');
    });

    it('name explicit parties plainly and defaulted ones as defaults', () => {
      const rows = tableRows(flowSlides()[0]!);
      const parties = Object.fromEntries(rows.slice(1).map((r) => [r[0], r[2]]));
      expect(parties['Declare Incident']).toBe('D&amp;HQ → Board: Cyber Review Board');
      expect(parties['Detect &amp; Triage']).toBe('C&amp;EW → Cyber &quot;D&quot; (default)');
    });

    it('print the signed date in the locale and zone asked for', () => {
      const title = (opts: { locale?: string; timeZone?: string }) =>
        pptxParts(ws, chartId, opts).find((p) => p.path === 'ppt/slides/slide1.xml')!
          .content as string;
      expect(title(CAPTURED)).toContain('Final, signed 3/4/2026');
      expect(title({ locale: 'en-GB', timeZone: 'UTC' })).toContain('Final, signed 04/03/2026');
      // Signed at 15:30 UTC — already the next day fourteen hours east.
      expect(title({ locale: 'en-US', timeZone: 'Pacific/Kiritimati' })).toContain(
        'Final, signed 3/5/2026',
      );
    });
  });

  describe('free-form charts', () => {
    const { workspace: ws } = importLegacy(freeFormVariant(demo));
    const sheets = buildLevelSheets(ws, ws.charts['c_par_free']!);

    it('get one table per depth, named so a spreadsheet would accept them', () => {
      expect(sheets.map((s) => s.name)).toEqual([
        'Initiative',
        'Work stream   phase',
        'Level 3',
        'Initiative 2',
        'Level 5',
      ]);
      expect(sheets[0]!.headers).toEqual([
        'Initiative',
        'Executive Sponsor',
        'Program Office <PMO>',
        'Party',
      ]);
    });

    it('cascade the doer, and print a blank cell as Informed', () => {
      // nf_2 names legal as its primary doer, so nf_3 inherits the owner there.
      const row = sheets[2]!.rows.find((r) => r[2] === 'Blank-named level')!;
      expect(row.slice(3)).toEqual(['I', 'I', 'RA']);
    });
  });
});
