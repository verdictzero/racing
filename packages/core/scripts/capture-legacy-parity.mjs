#!/usr/bin/env node
/**
 * Re-capture what index.html itself writes, for the parity tests.
 *
 * The document exports, the Ingest Kit and Save are held to the legacy app's OWN output, not to a
 * description of it: this opens index.html in headless Chromium with the demo workspace (and the
 * variations in src/__fixtures__/parity-variants.ts) in its localStorage, calls its `pptxBytes()`,
 * `xlsxBytes()`, `exportXML()`, `exportMermaid()`, `exportMermaidFlow()` (once per flow) and
 * `ingestKitMarkdown()`, reads the state its Save would write, and records what they produced in
 *
 *   src/__fixtures__/legacy-parity.json     per case: a digest per slide plus the rest of the deck,
 *                                           a digest per workbook part, the XML, the chart's Mermaid
 *                                           and each flow's, the kit, and the saved file
 *   src/__fixtures__/legacy-ingest-kit.md   the demo's kit, whole, so a failure shows a readable diff
 *
 * Run it after index.html changes any of those, and commit both files with the port that matches.
 *
 * Playwright is deliberately not a dependency of this repository, so install it anywhere and point
 * NODE_PATH at it for the run:
 *
 *   npm install --prefix /tmp/pw playwright@1 && npx --prefix /tmp/pw playwright install chromium
 *   NODE_PATH=/tmp/pw/node_modules node packages/core/scripts/capture-legacy-parity.mjs
 *
 * CHROMIUM=/path/to/chrome uses an existing browser instead of Playwright's download. Needs a Node
 * that strips TypeScript types (22.18+, or 22.6+ with --experimental-strip-types), because the
 * variations are imported straight from their .ts file.
 *
 * PARITY_DUMP=/some/dir also writes every captured text whole — the XML, each workbook part, each
 * Mermaid file — under <dir>/<case>/, for diffing a port against when a digest stops matching.
 */

// The page-side callbacks below run inside index.html, against its own globals — not in Node.
/* global localStorage, zipBytes:writable, download:writable, pptxBytes, xlsxBytes, exportXML,
   exportMermaid, exportMermaidFlow, ac, chartFileBase, ingestKitMarkdown, state */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const core = resolve(here, '..');
const fixtures = resolve(core, 'src', '__fixtures__');
const indexHtml = pathToFileURL(resolve(core, '..', '..', 'index.html')).href;
const dump = process.env.PARITY_DUMP ? resolve(process.env.PARITY_DUMP) : null;

/** The clock the page sees, so the kit's "Generated … on <date>" line is reproducible. */
const NOW = '2026-09-24T12:00:00.000Z';

// Through `require` rather than `import`: only CommonJS resolution honours NODE_PATH, which is how
// an install outside the repository is found.
let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  console.error('Playwright not found — see the header of this script for how to run it.');
  process.exit(1);
}

const { anchoredVariant, freeFormVariant } = await import(
  pathToFileURL(resolve(fixtures, 'parity-variants.ts')).href
);
const demo = JSON.parse(readFileSync(resolve(fixtures, 'demo-workspace.json'), 'utf8'));
const cases = { demo, anchored: anchoredVariant(demo), freeform: freeFormVariant(demo) };

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const isSlide = (path) => /^ppt\/slides\/slide\d+\.xml$/.test(path);

/** Write one captured text under the dump directory, when there is one. */
function dumpText(name, path, text) {
  if (!dump) return;
  const file = resolve(dump, name, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const browser = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
);
const golden = {
  source:
    'index.html v0.39 — pptxBytes(), xlsxBytes(), exportXML(), exportMermaid(), exportMermaidFlow(), ingestKitMarkdown() and the file Save writes, run headless (Chromium, en-US, UTC) by packages/core/scripts/capture-legacy-parity.mjs',
  now: NOW,
  cases: {},
};
let demoKit = '';

for (const [name, input] of Object.entries(cases)) {
  // The signed date prints with the browser's locale and zone, so both are pinned; the tests pass
  // the same pair to the port.
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'UTC' });
  await context.addInitScript((s) => {
    localStorage.setItem('raci-matrix-v8', s);
    localStorage.setItem('raci-matrix-splash-v2', 'never');
  }, JSON.stringify(input));
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(NOW));
  await page.goto(indexHtml);
  await page.waitForFunction(() => typeof pptxBytes === 'function');

  const captured = await page.evaluate(() => {
    // What Save writes (exportJSON): the whole state, two-space indented — read FIRST, before the
    // flow loop below moves the active flow. None of these cases has an attachment, so the
    // IndexedDB sync that runs first changes nothing.
    // The legacy loader keeps a record's keys in the order the FILE had them, adding what it fills in
    // at the end, so a hand-written file comes back in its own order. The content is compared with
    // the keys sorted too, which holds for any file; the bytes only for one index.html wrote.
    const sorted = (v) => (Array.isArray(v) ? v.map(sorted)
      : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
    const save = JSON.stringify(state, null, 2);
    const saveSorted = JSON.stringify(sorted(state));

    // The package parts are read on their way into the ZIP writer: the legacy calls it by its
    // global name, so wrapping the global sees exactly what it was about to store.
    const originalZip = zipBytes;
    const partsOf = (build) => {
      let parts = null;
      zipBytes = (files) => {
        parts = files.map(([path, content]) => [path, content]);
        return originalZip(files);
      };
      try { build(); } finally { zipBytes = originalZip; }
      return parts;
    };
    // The text exports end in `download(name, text, mime)`, also called by its global name — so the
    // text is taken there, and nothing is downloaded.
    const originalDownload = download;
    const textOf = (run) => {
      let text = null;
      download = (_name, content) => { text = content; };
      try { run(); } finally { download = originalDownload; }
      return text;
    };

    const parts = partsOf(pptxBytes);
    const xlsxParts = partsOf(xlsxBytes);
    const xml = textOf(exportXML);
    // exportMermaid draws the chart from the chart view and the open flow from the flow view; the
    // flow half is exportMermaidFlow, which draws `abc()` — so each flow is opened in turn.
    const view = state.viewMode;
    state.viewMode = 'chart';
    const chartMermaid = textOf(exportMermaid);
    state.viewMode = view;
    const openFlow = state.activeBizCaseId;
    const flowMermaid = {};
    for (const flow of state.bizCases) {
      state.activeBizCaseId = flow.id;
      flowMermaid[flow.id] = textOf(exportMermaidFlow);
    }
    state.activeBizCaseId = openFlow;
    return {
      chartId: ac().id, fileBase: chartFileBase(), parts, xlsxParts, xml, chartMermaid, flowMermaid,
      kit: ingestKitMarkdown(), save, saveSorted,
    };
  });
  await context.close();

  const slides = captured.parts.filter(([path]) => isSlide(path));
  const others = captured.parts.filter(([path]) => !isSlide(path));
  golden.cases[name] = {
    chartId: captured.chartId,
    fileBase: captured.fileBase,
    parts: captured.parts.length,
    // One digest per slide pinpoints WHICH slide drifted; the fixed parts and the rels share one.
    slides: Object.fromEntries(slides.map(([path, xml]) => [path, sha(xml).slice(0, 16)])),
    otherParts: sha(others.map(([path, xml]) => `${path}\n${xml}`).join('\n\u0000\n')),
    // Every part of the workbook, in the order it was written: a digest each, so a failure names
    // the sheet that drifted.
    xlsx: Object.fromEntries(captured.xlsxParts.map(([path, xml]) => [path, sha(xml).slice(0, 16)])),
    xml: sha(captured.xml),
    chartMermaid: sha(captured.chartMermaid),
    // Keyed by flow id, in the order the file lists the flows.
    flowMermaid: Object.fromEntries(
      Object.entries(captured.flowMermaid).map(([id, text]) => [id, sha(text).slice(0, 16)]),
    ),
    kit: sha(captured.kit),
    save: sha(captured.save),
    saveSorted: sha(captured.saveSorted),
  };
  if (name === 'demo') demoKit = captured.kit;

  dumpText(name, 'export.xml', captured.xml);
  dumpText(name, 'chart.mmd', captured.chartMermaid);
  for (const [id, text] of Object.entries(captured.flowMermaid)) dumpText(name, `flow-${id}.mmd`, text);
  for (const [path, xml] of captured.xlsxParts) dumpText(name, `xlsx/${path}`, xml);

  console.log(
    `${name}: ${slides.length} slides, ${captured.parts.length} deck parts, ` +
      `${captured.xlsxParts.length} workbook parts, ${Object.keys(captured.flowMermaid).length} flows`,
  );
}
await browser.close();

writeFileSync(resolve(fixtures, 'legacy-parity.json'), JSON.stringify(golden, null, 2) + '\n');
writeFileSync(resolve(fixtures, 'legacy-ingest-kit.md'), demoKit);
console.log('wrote legacy-parity.json and legacy-ingest-kit.md');
