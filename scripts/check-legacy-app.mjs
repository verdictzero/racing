#!/usr/bin/env node
// Guard for the legacy single-file app.
//
// index.html has no build step, so nothing would otherwise catch a syntax error in it before a
// user opens the file. It keeps shipping until the Nuxt app reaches parity (ADR-0002), which
// makes "it parses" a release gate rather than a nicety. This also checks the two invariants
// that a careless edit to that file tends to break.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

let failures = 0;
const fail = (msg) => {
  console.error(`  FAIL  ${msg}`);
  failures++;
};
const pass = (msg) => console.log(`  ok    ${msg}`);

// --- every inline <script> block parses -------------------------------------------------------
// The embedded field guides are text/html payloads, not script, so they are skipped by type.
const blocks = [...html.matchAll(/<script(?<attrs>[^>]*)>(?<body>[\s\S]*?)<\/script>/g)];
if (blocks.length === 0) fail('no <script> blocks found — did the file move?');

let parsed = 0;
for (const [i, m] of blocks.entries()) {
  const attrs = m.groups.attrs || '';
  if (/type\s*=\s*["'](?!text\/javascript|module)/i.test(attrs)) continue; // data payload
  if (/\bsrc\s*=/.test(attrs)) continue;
  try {
    new Function(m.groups.body);
    parsed++;
  } catch (err) {
    fail(`script block #${i + 1} does not parse: ${err.message}`);
  }
}
if (parsed > 0) pass(`${parsed} inline script block(s) parse`);

// --- the version is stated once and stated consistently ---------------------------------------
const version = html.match(/const APP_VERSION = '([^']+)'/)?.[1];
if (!version) fail('APP_VERSION not found');
else {
  pass(`APP_VERSION = ${version}`);
  if (!new RegExp(`^//\\s+${version.replace('.', '\\.')} alpha`, 'm').test(html)) {
    fail(`APP_VERSION ${version} has no matching line in the version-history comment`);
  } else {
    pass('version history has an entry for the current version');
  }
}

// --- CRLF line endings are preserved ----------------------------------------------------------
// The file is CRLF throughout. A tool that rewrites it as LF produces a diff touching all 17k
// lines, which buries the actual change and makes review impossible.
if (html.includes('\r\n')) pass('CRLF line endings intact');
else fail('line endings were flattened to LF — the diff will touch every line');

console.log(failures ? `\n${failures} check(s) failed.` : '\nLegacy app OK.');
process.exit(failures ? 1 : 0);
