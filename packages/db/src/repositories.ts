/**
 * Query functions.
 *
 * THE ONE RULE: every function that reads or writes tenant data takes an `orgId` and filters on
 * it. Multi-tenancy is enforced here rather than by Postgres row-level security, because RLS needs
 * a per-request database role and this deployment runs one pooled connection. That makes the
 * filter a convention rather than a guarantee, so it is concentrated in this file — one place to
 * read, one place to review — instead of spread across route handlers where an omission would be
 * invisible.
 *
 * Anything that returns a row belonging to another organization is a data breach, not a bug.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import {
  auditLog,
  authRequests,
  directoryPendingRemovals,
  directorySyncRuns,
  memberships,
  organizations,
  sessions,
  users,
  workspaceIndex,
  workspaces,
  type Role,
} from './schema.js';

// ---- organizations and users -------------------------------------------------------------------

export async function findOrganizationBySlug(db: Database, slug: string) {
  const [row] = await db.select().from(organizations).where(eq(organizations.slug, slug)).limit(1);
  return row ?? null;
}

export async function createOrganization(db: Database, name: string, slug: string) {
  const [row] = await db.insert(organizations).values({ name, slug }).returning();
  return row!;
}

/**
 * Find or create the local account behind an IdP identity.
 *
 * Matched on (issuer, subject) and never on email: an address gets reassigned when somebody
 * leaves, and matching on it would hand the new holder the previous holder's account and history.
 * The email is stored because it is useful to display, and refreshed on every login because the
 * IdP is authoritative for it.
 */
export async function upsertUserFromClaims(
  db: Database,
  params: {
    organizationId: string;
    issuer: string;
    externalId: string;
    email: string | null;
    displayName: string;
  },
) {
  const [existing] = await db
    .select()
    .from(users)
    .where(and(eq(users.issuer, params.issuer), eq(users.externalId, params.externalId)))
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(users)
      .set({
        email: params.email,
        displayName: params.displayName || existing.displayName,
        lastSeenAt: new Date(),
      })
      .where(eq(users.id, existing.id))
      .returning();
    return updated!;
  }

  const [created] = await db
    .insert(users)
    .values({
      organizationId: params.organizationId,
      issuer: params.issuer,
      externalId: params.externalId,
      email: params.email,
      displayName: params.displayName,
      lastSeenAt: new Date(),
    })
    .returning();
  return created!;
}

export async function getMembership(db: Database, userId: string, organizationId: string) {
  const [row] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
}

export async function setMembership(
  db: Database,
  userId: string,
  organizationId: string,
  role: Role,
) {
  const [row] = await db
    .insert(memberships)
    .values({ userId, organizationId, role })
    .onConflictDoUpdate({
      target: [memberships.userId, memberships.organizationId],
      set: { role },
    })
    .returning();
  return row!;
}

// ---- workspaces ------------------------------------------------------------------------------------

export async function listWorkspaces(db: Database, organizationId: string) {
  return db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.organizationId, organizationId), isNull(workspaces.archivedAt)))
    .orderBy(desc(workspaces.updatedAt));
}

/**
 * One workspace, scoped by organization.
 *
 * The orgId is a filter, not an assertion checked afterwards: a query that fetched by id and then
 * compared would still have read another tenant's row into memory, and the difference matters the
 * day someone logs the result.
 */
export async function getWorkspace(db: Database, organizationId: string, workspaceId: string) {
  const [row] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
}

export async function createWorkspace(
  db: Database,
  params: { organizationId: string; name: string; createdBy: string | null },
) {
  const [row] = await db.insert(workspaces).values(params).returning();
  return row!;
}

/** Archive rather than delete: a workspace is somebody's year of work. */
export async function archiveWorkspace(
  db: Database,
  organizationId: string,
  workspaceId: string,
) {
  const [row] = await db
    .update(workspaces)
    .set({ archivedAt: new Date() })
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.organizationId, organizationId)))
    .returning();
  return row ?? null;
}

/** The gallery listing, straight out of the projection — no CRDT loaded. */
export async function listWorkspaceContents(
  db: Database,
  organizationId: string,
  workspaceId: string,
  opts: { kind?: 'chart' | 'flow'; query?: string } = {},
) {
  const workspace = await getWorkspace(db, organizationId, workspaceId);
  if (!workspace) return [];

  const conditions = [eq(workspaceIndex.workspaceId, workspaceId)];
  if (opts.kind) conditions.push(eq(workspaceIndex.kind, opts.kind));
  if (opts.query) {
    // Matches everything the gallery filter matches — name, description, customer, budget, tags —
    // because searchText is built from all of them when the projection is written.
    conditions.push(sql`${workspaceIndex.searchText} ILIKE ${'%' + opts.query + '%'}`);
  }
  return db
    .select()
    .from(workspaceIndex)
    .where(and(...conditions))
    .orderBy(workspaceIndex.title);
}

// ---- sessions ---------------------------------------------------------------------------------------

export async function createSession(
  db: Database,
  params: {
    id: string;
    userId: string;
    expiresAt: Date;
    userAgent?: string | null;
    ipAddress?: string | null;
    idTokenHint?: string | null;
  },
) {
  const [row] = await db.insert(sessions).values(params).returning();
  return row!;
}

/**
 * Resolve a session to its user and role.
 *
 * Revocation and expiry are both checked HERE rather than by a background sweep, so ending
 * somebody's access takes effect on their next request rather than whenever a job next runs.
 */
export async function resolveSession(db: Database, sessionId: string) {
  const [row] = await db
    .select({
      session: sessions,
      user: users,
      role: memberships.role,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .leftJoin(
      memberships,
      and(eq(memberships.userId, users.id), eq(memberships.organizationId, users.organizationId)),
    )
    .where(eq(sessions.id, sessionId))
    .limit(1);

  if (!row) return null;
  if (row.session.revokedAt) return null;
  if (row.session.expiresAt.getTime() <= Date.now()) return null;
  return row;
}

export async function revokeSession(db: Database, sessionId: string) {
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
}

/** Every session for a user — how an administrator ends access immediately. */
export async function revokeAllSessionsForUser(db: Database, userId: string) {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

export async function deleteExpiredSessions(db: Database) {
  const rows = await db
    .delete(sessions)
    .where(sql`${sessions.expiresAt} < now() - interval '7 days'`)
    .returning({ id: sessions.id });
  return rows.length;
}

// ---- OIDC handshake state ------------------------------------------------------------------------------

export async function saveAuthRequest(
  db: Database,
  params: {
    state: string;
    codeVerifier: string;
    nonce: string;
    redirectTo: string;
    expiresAt: Date;
  },
) {
  await db.insert(authRequests).values(params);
}

/**
 * Consume the pending authorization request.
 *
 * Deleted as it is read, in one statement. That makes the state parameter single-use, which is
 * what stops an intercepted callback URL from being replayed — a returning DELETE is atomic where
 * a select-then-delete would leave a window for two callbacks to both succeed.
 */
export async function consumeAuthRequest(db: Database, state: string) {
  const [row] = await db.delete(authRequests).where(eq(authRequests.state, state)).returning();
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  return row;
}

// ---- directory sync --------------------------------------------------------------------------------------

export async function startSyncRun(
  db: Database,
  params: {
    organizationId: string;
    workspaceId: string;
    provider: string;
    startedBy: string | null;
  },
) {
  const [row] = await db.insert(directorySyncRuns).values(params).returning();
  return row!;
}

export async function finishSyncRun(
  db: Database,
  runId: string,
  result: {
    status: 'succeeded' | 'failed';
    stats?: Record<string, number>;
    changes?: unknown[];
    warnings?: string[];
    error?: string;
  },
) {
  await db
    .update(directorySyncRuns)
    .set({
      status: result.status,
      finishedAt: new Date(),
      stats: result.stats ?? {},
      changes: result.changes ?? [],
      warnings: result.warnings ?? [],
      error: result.error ?? null,
    })
    .where(eq(directorySyncRuns.id, runId));
}

export async function listSyncRuns(db: Database, organizationId: string, limit = 20) {
  return db
    .select()
    .from(directorySyncRuns)
    .where(eq(directorySyncRuns.organizationId, organizationId))
    .orderBy(desc(directorySyncRuns.startedAt))
    .limit(limit);
}

/**
 * Record that a roster record was absent from this sync.
 *
 * The counter is what turns "missing" into a signal worth acting on: one absence is usually a
 * failed query or a permissions gap, three in a row is a reorganization. A human still decides,
 * but they decide with the count in front of them.
 */
export async function recordPendingRemoval(
  db: Database,
  params: {
    workspaceId: string;
    tier: string;
    rosterId: string;
    externalId: string;
    name: string;
  },
) {
  await db
    .insert(directoryPendingRemovals)
    .values(params)
    .onConflictDoUpdate({
      target: [directoryPendingRemovals.workspaceId, directoryPendingRemovals.rosterId],
      set: { missedSyncs: sql`${directoryPendingRemovals.missedSyncs} + 1` },
    });
}

/** A record that came back is no longer pending — clear it silently. */
export async function clearPendingRemoval(db: Database, workspaceId: string, rosterId: string) {
  await db
    .delete(directoryPendingRemovals)
    .where(
      and(
        eq(directoryPendingRemovals.workspaceId, workspaceId),
        eq(directoryPendingRemovals.rosterId, rosterId),
      ),
    );
}

export async function listPendingRemovals(db: Database, workspaceId: string) {
  return db
    .select()
    .from(directoryPendingRemovals)
    .where(
      and(
        eq(directoryPendingRemovals.workspaceId, workspaceId),
        isNull(directoryPendingRemovals.resolvedAt),
      ),
    )
    .orderBy(desc(directoryPendingRemovals.missedSyncs));
}

// ---- audit -----------------------------------------------------------------------------------------------

export async function recordAudit(
  db: Database,
  params: {
    organizationId: string;
    workspaceId?: string | null;
    userId?: string | null;
    action: string;
    targetKind?: string | null;
    targetId?: string | null;
    detail?: Record<string, unknown>;
  },
) {
  await db.insert(auditLog).values({
    organizationId: params.organizationId,
    workspaceId: params.workspaceId ?? null,
    userId: params.userId ?? null,
    action: params.action,
    targetKind: params.targetKind ?? null,
    targetId: params.targetId ?? null,
    detail: params.detail ?? {},
  });
}

export async function listAudit(
  db: Database,
  organizationId: string,
  opts: { workspaceId?: string; limit?: number } = {},
) {
  const conditions = [eq(auditLog.organizationId, organizationId)];
  if (opts.workspaceId) conditions.push(eq(auditLog.workspaceId, opts.workspaceId));
  return db
    .select()
    .from(auditLog)
    .where(and(...conditions))
    .orderBy(desc(auditLog.createdAt))
    .limit(opts.limit ?? 100);
}
