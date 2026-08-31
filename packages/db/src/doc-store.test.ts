import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as Y from 'yjs';
import { schema, docSnapshots } from './schema.js';
import { appendUpdate, compact, loadDoc, pendingUpdateCount, reindexWorkspace } from './doc-store.js';
import {
  createOrganization,
  createWorkspace,
  listWorkspaceContents,
  listWorkspaces,
  getWorkspace,
  recordAudit,
  listAudit,
  upsertUserFromClaims,
  createSession,
  resolveSession,
  revokeSession,
  consumeAuthRequest,
  saveAuthRequest,
  recordPendingRemoval,
  listPendingRemovals,
} from './repositories.js';
import { eq } from 'drizzle-orm';
import type { Database } from './client.js';

/**
 * Real Postgres, in process.
 *
 * PGlite is Postgres compiled to WASM, so these run the ACTUAL migration and the ACTUAL SQL — not
 * a mock that agrees with whatever the code happens to do. That matters most for the parts a mock
 * would paper over: bytea round-tripping the Yjs updates, `on conflict do update` on the composite
 * keys, and the generated-identity columns the update log orders by.
 */
let pg: PGlite;
let db: Database;

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg, { schema }) as unknown as Database;

  const dir = join(import.meta.dirname, '../migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  expect(files.length, 'a migration must have been generated').toBeGreaterThan(0);
  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    // drizzle-kit separates statements with this marker; PGlite wants them one at a time.
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await pg.exec(trimmed);
    }
  }
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

async function seedWorkspace(name = 'Test workspace') {
  const org = await createOrganization(db, 'ASIC', `asic-${Math.random().toString(36).slice(2, 8)}`);
  const ws = await createWorkspace(db, {
    organizationId: org.id,
    name,
    createdBy: null,
  });
  return { org, ws };
}

describe('the migration', () => {
  it('creates every table the schema declares', async () => {
    const result = await pg.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    const tables = result.rows.map((r) => r.table_name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'app_user',
        'audit_log',
        'auth_request',
        'directory_pending_removal',
        'directory_sync_run',
        'doc_snapshot',
        'doc_update',
        'document_blob',
        'membership',
        'organization',
        'session',
        'workspace',
        'workspace_index',
      ]),
    );
  });
});

describe('the update log', () => {
  it('round-trips a Yjs update through bytea', async () => {
    const { ws } = await seedWorkspace();
    const source = new Y.Doc();
    source.getMap('charts').set('c_1', 'hello');

    await appendUpdate(db, {
      workspaceId: ws.id,
      update: Y.encodeStateAsUpdate(source),
      origin: 'local',
    });

    const { doc, replayed } = await loadDoc(db, ws.id);
    expect(replayed).toBe(1);
    expect(doc.getMap('charts').get('c_1')).toBe('hello');
  });

  it('replays several updates in order', async () => {
    const { ws } = await seedWorkspace();
    const source = new Y.Doc();
    const map = source.getMap<string>('m');

    for (const value of ['first', 'second', 'third']) {
      let update: Uint8Array | null = null;
      const handler = (u: Uint8Array) => {
        update = u;
      };
      source.on('update', handler);
      map.set('key', value);
      source.off('update', handler);
      await appendUpdate(db, { workspaceId: ws.id, update: update!, origin: 'local' });
    }

    const { doc } = await loadDoc(db, ws.id);
    // Last write wins on a single key — the point is that all three arrived and applied in order.
    expect(doc.getMap('m').get('key')).toBe('third');
  });

  it('returns an empty document for a workspace nobody has edited', async () => {
    const { ws } = await seedWorkspace();
    const { doc, throughUpdateId, replayed } = await loadDoc(db, ws.id);
    expect(throughUpdateId).toBe(0);
    expect(replayed).toBe(0);
    expect([...doc.getMap('charts').keys()]).toEqual([]);
  });

  it('keeps two workspaces' + ' documents apart', async () => {
    const a = await seedWorkspace('A');
    const b = await seedWorkspace('B');

    const docA = new Y.Doc();
    docA.getMap('m').set('who', 'A');
    await appendUpdate(db, { workspaceId: a.ws.id, update: Y.encodeStateAsUpdate(docA) });

    const loadedB = await loadDoc(db, b.ws.id);
    expect(loadedB.replayed).toBe(0);
    const loadedA = await loadDoc(db, a.ws.id);
    expect(loadedA.doc.getMap('m').get('who')).toBe('A');
  });
});

describe('compaction', () => {
  it('folds the log into a snapshot and prunes what it covers', async () => {
    const { ws } = await seedWorkspace();
    const source = new Y.Doc();
    const map = source.getMap<number>('m');

    for (let i = 0; i < 12; i++) {
      let update: Uint8Array | null = null;
      const handler = (u: Uint8Array) => {
        update = u;
      };
      source.on('update', handler);
      map.set(`k${i}`, i);
      source.off('update', handler);
      await appendUpdate(db, { workspaceId: ws.id, update: update! });
    }

    expect(await pendingUpdateCount(db, ws.id)).toBe(12);

    const result = await compact(db, ws.id);
    expect(result).not.toBeNull();
    expect(result!.prunedUpdates).toBe(12);
    expect(await pendingUpdateCount(db, ws.id)).toBe(0);

    // The document still reads identically after the log it was built from is gone.
    const { doc, replayed } = await loadDoc(db, ws.id);
    expect(replayed).toBe(0);
    for (let i = 0; i < 12; i++) expect(doc.getMap('m').get(`k${i}`)).toBe(i);
  });

  it('keeps working when updates arrive after a snapshot', async () => {
    const { ws } = await seedWorkspace();
    const source = new Y.Doc();
    source.getMap('m').set('before', 1);
    await appendUpdate(db, { workspaceId: ws.id, update: Y.encodeStateAsUpdate(source) });
    await compact(db, ws.id);

    const after = new Y.Doc();
    Y.applyUpdate(after, Y.encodeStateAsUpdate(source));
    let update: Uint8Array | null = null;
    after.on('update', (u: Uint8Array) => {
      update = u;
    });
    after.getMap('m').set('after', 2);

    await appendUpdate(db, { workspaceId: ws.id, update: update! });

    const { doc, replayed } = await loadDoc(db, ws.id);
    expect(replayed).toBe(1); // snapshot plus the one that came later
    expect(doc.getMap('m').get('before')).toBe(1);
    expect(doc.getMap('m').get('after')).toBe(2);
  });

  it('does nothing for a workspace with no history', async () => {
    const { ws } = await seedWorkspace();
    expect(await compact(db, ws.id)).toBeNull();
  });

  it('retains a few old snapshots as a way back', async () => {
    const { ws } = await seedWorkspace();
    const source = new Y.Doc();
    for (let i = 0; i < 5; i++) {
      let update: Uint8Array | null = null;
      const handler = (u: Uint8Array) => {
        update = u;
      };
      source.on('update', handler);
      source.getMap('m').set(`k${i}`, i);
      source.off('update', handler);
      await appendUpdate(db, { workspaceId: ws.id, update: update! });
      await compact(db, ws.id, { keepSnapshots: 3 });
    }
    const snapshots = await db
      .select()
      .from(docSnapshots)
      .where(eq(docSnapshots.workspaceId, ws.id));
    expect(snapshots.length).toBeLessThanOrEqual(3);
    // And the document is still whole.
    const { doc } = await loadDoc(db, ws.id);
    for (let i = 0; i < 5; i++) expect(doc.getMap('m').get(`k${i}`)).toBe(i);
  });
});

describe('tenancy', () => {
  it('will not return another organization’s workspace', async () => {
    const mine = await seedWorkspace('Mine');
    const theirs = await seedWorkspace('Theirs');

    expect(await getWorkspace(db, mine.org.id, mine.ws.id)).not.toBeNull();
    // The id is correct and the organization is not — this must be a miss, not a hit.
    expect(await getWorkspace(db, mine.org.id, theirs.ws.id)).toBeNull();
  });

  it('lists only the caller’s workspaces', async () => {
    const mine = await seedWorkspace('Mine');
    await seedWorkspace('Theirs');
    const rows = await listWorkspaces(db, mine.org.id);
    expect(rows.map((r) => r.id)).toEqual([mine.ws.id]);
  });
});

describe('the workspace projection', () => {
  it('rebuilds wholesale and is searchable', async () => {
    const { org, ws } = await seedWorkspace();
    await reindexWorkspace(db, ws.id, [
      {
        kind: 'chart',
        artifactId: 'c_1',
        title: 'Portfolio RACI',
        status: 'draft',
        searchText: 'portfolio raci acquisition fy26',
        meta: { customer: 'Acquisition' },
        nodeCount: 810,
      },
      {
        kind: 'flow',
        artifactId: 'b_1',
        title: 'Incident Response',
        status: 'final',
        searchText: 'incident response cyber tabletop',
        meta: {},
        nodeCount: 7,
      },
    ]);

    expect(await listWorkspaceContents(db, org.id, ws.id)).toHaveLength(2);
    expect(await listWorkspaceContents(db, org.id, ws.id, { kind: 'flow' })).toHaveLength(1);

    const hits = await listWorkspaceContents(db, org.id, ws.id, { query: 'fy26' });
    expect(hits.map((h) => h.artifactId)).toEqual(['c_1']);

    // Rebuilding replaces rather than accumulating.
    await reindexWorkspace(db, ws.id, []);
    expect(await listWorkspaceContents(db, org.id, ws.id)).toHaveLength(0);
  });

  it('refuses to project into another organization’s workspace', async () => {
    const mine = await seedWorkspace();
    const theirs = await seedWorkspace();
    await reindexWorkspace(db, theirs.ws.id, [
      {
        kind: 'chart',
        artifactId: 'c_x',
        title: 'Theirs',
        status: 'draft',
        searchText: 'theirs',
        meta: {},
        nodeCount: 1,
      },
    ]);
    expect(await listWorkspaceContents(db, mine.org.id, theirs.ws.id)).toHaveLength(0);
  });
});

describe('identity and sessions', () => {
  it('matches a returning user on (issuer, subject), not on email', async () => {
    const org = await createOrganization(db, 'Org', `org-${Math.random().toString(36).slice(2, 8)}`);
    const first = await upsertUserFromClaims(db, {
      organizationId: org.id,
      issuer: 'https://idp.example/realms/raci',
      externalId: 'subject-123',
      email: 'old.address@example.mil',
      displayName: 'Dana Whitfield',
    });

    // Same person, new email — the account must be the same row, with the address refreshed.
    const second = await upsertUserFromClaims(db, {
      organizationId: org.id,
      issuer: 'https://idp.example/realms/raci',
      externalId: 'subject-123',
      email: 'new.address@example.mil',
      displayName: 'Dana Whitfield',
    });
    expect(second.id).toBe(first.id);
    expect(second.email).toBe('new.address@example.mil');

    // A different subject that happens to reuse the OLD email is a different person.
    const other = await upsertUserFromClaims(db, {
      organizationId: org.id,
      issuer: 'https://idp.example/realms/raci',
      externalId: 'subject-999',
      email: 'old.address@example.mil',
      displayName: 'Someone Else',
    });
    expect(other.id).not.toBe(first.id);
  });

  it('resolves a live session and refuses a revoked one', async () => {
    const org = await createOrganization(db, 'Org', `org-${Math.random().toString(36).slice(2, 8)}`);
    const user = await upsertUserFromClaims(db, {
      organizationId: org.id,
      issuer: 'iss',
      externalId: `sub-${Math.random()}`,
      email: null,
      displayName: 'X',
    });
    const id = 'session-hash-' + Math.random().toString(36).slice(2);
    await createSession(db, {
      id,
      userId: user.id,
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    expect(await resolveSession(db, id)).not.toBeNull();
    await revokeSession(db, id);
    // Revocation takes effect on the next request, not whenever a sweep next runs.
    expect(await resolveSession(db, id)).toBeNull();
  });

  it('refuses an expired session', async () => {
    const org = await createOrganization(db, 'Org', `org-${Math.random().toString(36).slice(2, 8)}`);
    const user = await upsertUserFromClaims(db, {
      organizationId: org.id,
      issuer: 'iss',
      externalId: `sub-${Math.random()}`,
      email: null,
      displayName: 'X',
    });
    const id = 'expired-' + Math.random().toString(36).slice(2);
    await createSession(db, { id, userId: user.id, expiresAt: new Date(Date.now() - 1000) });
    expect(await resolveSession(db, id)).toBeNull();
  });

  it('makes an OIDC state parameter single-use', async () => {
    const state = 'state-' + Math.random().toString(36).slice(2);
    await saveAuthRequest(db, {
      state,
      codeVerifier: 'verifier',
      nonce: 'nonce',
      redirectTo: '/charts',
      expiresAt: new Date(Date.now() + 600_000),
    });

    expect((await consumeAuthRequest(db, state))?.redirectTo).toBe('/charts');
    // A replayed callback finds nothing — the delete and the read were one statement.
    expect(await consumeAuthRequest(db, state)).toBeNull();
  });
});

describe('directory sync bookkeeping', () => {
  it('counts consecutive absences rather than deleting on the first one', async () => {
    const { ws } = await seedWorkspace();
    const params = {
      workspaceId: ws.id,
      tier: 'division',
      rosterId: 'dv_1',
      externalId: 'ou-gone',
      name: 'Governance Division',
    };
    await recordPendingRemoval(db, params);
    await recordPendingRemoval(db, params);
    await recordPendingRemoval(db, params);

    const pending = await listPendingRemovals(db, ws.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.missedSyncs).toBe(3);
  });
});

describe('audit', () => {
  it('records and reads back an action', async () => {
    const { org, ws } = await seedWorkspace();
    await recordAudit(db, {
      organizationId: org.id,
      workspaceId: ws.id,
      action: 'chart.finalize',
      targetKind: 'chart',
      targetId: 'c_1',
      detail: { title: 'Portfolio RACI' },
    });
    const rows = await listAudit(db, org.id, { workspaceId: ws.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('chart.finalize');
    expect(rows[0]!.detail).toEqual({ title: 'Portfolio RACI' });
  });
});
