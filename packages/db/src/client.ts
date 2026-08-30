/**
 * The database connection.
 *
 * One pool for the process. `postgres` (postgres.js) rather than node-postgres: it speaks the
 * binary protocol, handles bytea without a round trip through hex, and the update log is all
 * bytea. Drizzle over it for the typed query builder.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { schema } from './schema.js';

export type Database = ReturnType<typeof createDatabase>['db'];

export interface DatabaseOptions {
  readonly url: string;
  /** Pool size. One per concurrent request is wasteful; Postgres is happier with fewer. */
  readonly max?: number;
  readonly idleTimeoutSeconds?: number;
  /** PEM CA bundle where the server presents a private certificate. */
  readonly sslCa?: string;
}

export function createDatabase(opts: DatabaseOptions) {
  const sql = postgres(opts.url, {
    max: opts.max ?? 10,
    idle_timeout: opts.idleTimeoutSeconds ?? 30,
    // Prepared statements are disabled because a connection pooler in transaction mode (PgBouncer,
    // which is how this is fronted on-prem) does not keep a session long enough to reuse one.
    prepare: false,
    ssl: opts.sslCa ? { ca: opts.sslCa } : undefined,
    onnotice: () => {
      /* NOTICE is not an application concern; the query result is */
    },
  });
  return { db: drizzle(sql, { schema }), sql };
}

/** Fail fast at boot rather than at the first request. */
export async function checkConnection(db: Database): Promise<{ ok: boolean; detail: string }> {
  try {
    await db.execute('select 1');
    return { ok: true, detail: 'connected' };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
