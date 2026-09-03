#!/usr/bin/env node
/**
 * Put the demo workspace into an empty database.
 *
 * Without this, a first sign-in lands on "Nothing here yet" and the only way forward is knowing
 * that a 700KB fixture is hiding in packages/core/src/__fixtures__. Someone setting the tool up to
 * look at it should see the thing itself.
 *
 * It goes in through exactly the path the API uses — importLegacy, then the CRDT document, then the
 * update log — so the seeded workspace is indistinguishable from one imported through the browser.
 * A shortcut straight to SQL here would be a second implementation of the import, and the first
 * time the two disagreed the demo would be the thing lying about the app.
 *
 *   node apps/web/scripts/seed-demo.mjs [--force]
 *
 * Lives under apps/web because that is where @raci/core, @raci/crdt, @raci/db and yjs all resolve
 * from without adding a dependency to the repository root.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as Y from 'yjs';
import { importLegacy } from '@raci/core';
import { docFromWorkspace } from '@raci/crdt';
import {
  appendUpdate,
  createDatabase,
  createOrganization,
  createWorkspace,
  findOrganizationBySlug,
  listWorkspaces,
  recordAudit,
  upsertUserFromClaims,
} from '@raci/db';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');

/**
 * Must match DEFAULT_ORG_SLUG in server/api/auth/callback.get.ts. The first real sign-in finds this
 * organization rather than creating a second one, which is what puts the seeded workspace in front
 * of the person who just signed in.
 */
const ORG_SLUG = 'asic';

/** No identity provider will ever mint this issuer, so no real login can collide with the row. */
const SEED_ISSUER = 'urn:raci:local-setup';

const WORKSPACE_NAME = 'ASIC RACI Tool Demo';

/** Enough of dotenv for one variable; pulling in a dependency for this would be silly. */
function readEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const value = trimmed.slice(eq + 1).trim();
    out[trimmed.slice(0, eq).trim()] = value.replace(/^(['"])(.*)\1$/s, '$2');
  }
  return out;
}

async function main() {
  const force = process.argv.includes('--force');
  const url = process.env.DATABASE_URL || readEnvFile(resolve(repo, '.env')).DATABASE_URL;
  if (!url) {
    console.error('No DATABASE_URL. Copy .env.example to .env first.');
    process.exitCode = 1;
    return;
  }

  const { db, sql } = createDatabase({ url, max: 2 });
  try {
    const organization =
      (await findOrganizationBySlug(db, ORG_SLUG)) ??
      (await createOrganization(db, 'ASIC', ORG_SLUG));

    const existing = await listWorkspaces(db, organization.id);
    if (existing.length > 0 && !force) {
      console.log(
        `Nothing to do — ${existing.length} workspace(s) already here. Use --force to add the demo anyway.`,
      );
      return;
    }

    const legacy = JSON.parse(
      readFileSync(resolve(repo, 'packages/core/src/__fixtures__/demo-workspace.json'), 'utf8'),
    );
    const imported = importLegacy(legacy);

    // A placeholder author so the workspace has a valid creator. It can never sign in, and the
    // audit trail then says plainly that setup put this here rather than attributing it to a person.
    const author = await upsertUserFromClaims(db, {
      organizationId: organization.id,
      issuer: SEED_ISSUER,
      externalId: 'demo-seed',
      email: null,
      displayName: 'Setup',
    });

    const workspace = await createWorkspace(db, {
      organizationId: organization.id,
      name: WORKSPACE_NAME,
      createdBy: author.id,
    });

    await appendUpdate(db, {
      workspaceId: workspace.id,
      update: Y.encodeStateAsUpdate(docFromWorkspace(imported.workspace)),
      userId: author.id,
      origin: 'import',
    });

    await recordAudit(db, {
      organizationId: organization.id,
      workspaceId: workspace.id,
      userId: author.id,
      action: 'workspace.create',
      detail: { imported: imported.report, source: 'seed-demo' },
    });

    const { charts, nodes, flows, steps, artifacts } = imported.report;
    console.log(
      `Added "${WORKSPACE_NAME}": ${charts} chart, ${nodes} rows, ${flows} flows, ${steps} steps, ${artifacts} deliverables.`,
    );
    if (imported.report.warnings.length) {
      console.log(`  ${imported.report.warnings.length} warning(s) during import.`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

await main();
