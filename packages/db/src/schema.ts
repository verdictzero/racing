/**
 * The Postgres schema.
 *
 * THE CENTRAL DECISION: the workspace is stored as a Yjs update log, not as relational rows.
 *
 * It is tempting to give charts and rows real tables — you would get SQL queries over them for
 * free. It is the wrong trade here, and the reason is the collaboration model. The document of
 * record is the CRDT: it is what merges, what carries causality, and what every client already
 * agrees on. Shredding it into rows on write means reconstructing intent from a diff, and any
 * mismatch between the shredder and the CRDT is a silent divergence between what a user sees and
 * what the database believes.
 *
 * So the log is the source of truth, and everything else is derived:
 *
 *   doc_update      append-only Yjs updates. Writes never conflict — they are inserts.
 *   doc_snapshot    periodic compaction, so loading a document is O(recent) not O(all history).
 *   workspace_index a denormalized projection for the things SQL is genuinely better at:
 *                   listing, searching and permission checks, none of which want a CRDT.
 *
 * The index can always be rebuilt from the log, which is what makes it safe to change its shape
 * later without a data migration. If the index and the log disagree, the log wins.
 *
 * MULTI-TENANCY is by organization, enforced at the query layer rather than by Postgres RLS. RLS
 * would be stronger, but it needs a per-request database role, and this deployment has one
 * connection pool. Every repository function therefore takes an orgId and there is no query path
 * that omits it — see `repositories.ts`.
 */

import {
  bigint,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Postgres bytea <-> Uint8Array. Yjs speaks Uint8Array; node-postgres hands back Buffer. */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => new Uint8Array(value),
});

// ---- tenancy and identity -------------------------------------------------------------------

export const organizations = pgTable('organization', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** URL-safe identifier. */
  slug: text('slug').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  'app_user',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /**
     * The IdP's subject claim. Stable for the life of the account — unlike the email, which gets
     * reassigned when people leave, and which must therefore never be the join key.
     */
    externalId: text('external_id').notNull(),
    /** Which IdP issued it, so two providers can coexist during a migration between them. */
    issuer: text('issuer').notNull(),
    email: text('email'),
    displayName: text('display_name').notNull().default(''),
    /**
     * Roster person this account IS, when the directory sync can match them. What makes "my
     * team's tasks" answerable for the person actually looking at the screen.
     */
    rosterPersonId: text('roster_person_id'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Identity is (issuer, subject) — a subject is only unique within its issuer.
    uniqueIndex('app_user_issuer_external_idx').on(t.issuer, t.externalId),
    index('app_user_org_idx').on(t.organizationId),
  ],
);

/**
 * Roles are coarse on purpose.
 *
 * The legacy app has no permission model at all — one maintainer edits and everyone else receives
 * exports. Going from that to per-row ACLs in one step would be a design nobody has requirements
 * for yet. Three roles cover what the deployment actually distinguishes today; finer grants can be
 * added as a separate table without changing this one.
 *
 *   viewer  read everything in the organization
 *   editor  create and edit workspaces
 *   admin   manage members, run directory syncs, delete workspaces
 */
export const ROLES = ['viewer', 'editor', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const memberships = pgTable(
  'membership',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    role: text('role').$type<Role>().notNull().default('viewer'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.organizationId] })],
);

// ---- workspaces -------------------------------------------------------------------------------

/**
 * A workspace is one collaborative document: charts, flows, registries and roster together.
 *
 * The unit is the whole workspace rather than the individual chart because they REFERENCE each
 * other — a flow anchors to a chart row, a step binds to one, both point into the shared
 * deliverable registry. Splitting them into separate CRDT documents would put those references
 * across a consistency boundary, so a chart row could be deleted while a flow in another document
 * still bound to it, with no transaction able to see both.
 */
export const workspaces = pgTable(
  'workspace',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [index('workspace_org_idx').on(t.organizationId)],
);

/**
 * The append-only Yjs update log — the source of truth.
 *
 * Append-only is what makes concurrent writes trivial: two clients saving at the same instant
 * produce two INSERTs, which cannot conflict. There is no row to lock and no version to compare,
 * so the database never becomes the bottleneck the CRDT was chosen to avoid.
 */
export const docUpdates = pgTable(
  'doc_update',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    update: bytea('update').notNull(),
    /** Who produced it. Null for a server-side write (a directory sync, a repair). */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** The mutation's origin tag, so a sync or a repair can be told from a person's edit. */
    origin: text('origin').notNull().default('local'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('doc_update_workspace_idx').on(t.workspaceId, t.id)],
);

/**
 * Periodic compaction.
 *
 * Without it, opening a workspace edited for a year means replaying every keystroke ever made.
 * A snapshot is one merged update; loading is then the newest snapshot plus whatever arrived
 * after it. Snapshots are additive and older updates are only pruned once a snapshot covering
 * them is durable, so a failed compaction can never lose history.
 */
export const docSnapshots = pgTable(
  'doc_snapshot',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Merged state as of `throughUpdateId`. */
    state: bytea('state').notNull(),
    /** Highest doc_update.id folded in. Everything above it still has to be replayed. */
    throughUpdateId: bigint('through_update_id', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('doc_snapshot_workspace_idx').on(t.workspaceId, t.id)],
);

/**
 * A denormalized projection of the document, for what SQL is genuinely better at: listing charts
 * and flows, searching them, and answering "what may this user see" without loading a CRDT.
 *
 * Derived, never authoritative. It can be rebuilt from the log at any time, which is what makes
 * it safe to change shape without a data migration. If it disagrees with the log, the log wins.
 */
export const workspaceIndex = pgTable(
  'workspace_index',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** 'chart' | 'flow' */
    kind: text('kind').notNull(),
    artifactId: text('artifact_id').notNull(),
    title: text('title').notNull().default(''),
    status: text('status').notNull().default('draft'),
    /** Everything the gallery filter matches: description, customer, budget, tags. */
    searchText: text('search_text').notNull().default(''),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    nodeCount: integer('node_count').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.artifactId] }),
    index('workspace_index_kind_idx').on(t.workspaceId, t.kind),
  ],
);

/**
 * Attachment bytes, out of the document.
 *
 * The legacy app offloads these to IndexedDB for the same reason: a base64 dataUrl inside the
 * document would put megabytes into every CRDT update and into every peer's memory. The document
 * carries only the metadata; the bytes live here, keyed by the doc id it references.
 */
export const documentBlobs = pgTable(
  'document_blob',
  {
    id: text('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull().default(''),
    contentType: text('content_type').notNull().default(''),
    byteSize: integer('byte_size').notNull().default(0),
    /**
     * Inline for a self-contained deployment. A deployment with object storage sets `storageKey`
     * instead and leaves this null — which is why the column is nullable rather than notNull.
     */
    bytes: bytea('bytes'),
    storageKey: text('storage_key'),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('document_blob_workspace_idx').on(t.workspaceId)],
);

// ---- directory sync ------------------------------------------------------------------------------

/**
 * One row per sync run.
 *
 * Kept because a directory sync is the one operation that can rewrite the roster underneath
 * everybody's assignments. When somebody asks why a branch is suddenly named differently, the
 * answer has to be in the database and not in a log file that rotated last week.
 */
export const directorySyncRuns = pgTable(
  'directory_sync_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    /** 'running' | 'succeeded' | 'failed' */
    status: text('status').notNull().default('running'),
    /** Set when a person started it; null for the scheduled run. */
    startedBy: uuid('started_by').references(() => users.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    stats: jsonb('stats').$type<Record<string, number>>().notNull().default({}),
    /** The reconciler's change list — additions, renames, and what went missing. */
    changes: jsonb('changes').$type<unknown[]>().notNull().default([]),
    warnings: jsonb('warnings').$type<string[]>().notNull().default([]),
    error: text('error'),
  },
  (t) => [index('directory_sync_run_org_idx').on(t.organizationId, t.startedAt)],
);

/**
 * Units the directory stopped returning.
 *
 * A sync reports rather than deletes, so the pending removals have to live somewhere until a
 * human decides. This is that queue.
 */
export const directoryPendingRemovals = pgTable(
  'directory_pending_removal',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** 'directorate' | 'division' | 'branch' | 'team' | 'person' */
    tier: text('tier').notNull(),
    rosterId: text('roster_id').notNull(),
    externalId: text('external_id').notNull(),
    name: text('name').notNull().default(''),
    firstSeenMissingAt: timestamp('first_seen_missing_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** How many consecutive syncs it has been absent — one absence is usually a failed query. */
    missedSyncs: integer('missed_syncs').notNull().default(1),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    /** 'removed' | 'kept' — what the human decided. */
    resolution: text('resolution'),
  },
  (t) => [uniqueIndex('directory_pending_removal_unique').on(t.workspaceId, t.rosterId)],
);

// ---- audit --------------------------------------------------------------------------------------

/**
 * Who did what.
 *
 * The update log already records every document change, but it records it as CRDT bytes, which is
 * the wrong shape for "show me what changed last Tuesday". This is the human-readable companion:
 * one row per meaningful action, in terms a person recognizes.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** 'workspace.create', 'chart.finalize', 'directory.sync', 'member.role_change', … */
    action: text('action').notNull(),
    targetKind: text('target_kind'),
    targetId: text('target_id'),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_org_idx').on(t.organizationId, t.createdAt),
    index('audit_log_workspace_idx').on(t.workspaceId, t.createdAt),
  ],
);

// ---- sessions --------------------------------------------------------------------------------------

/**
 * Server-side sessions.
 *
 * A stateless JWT cookie would be less machinery, but it cannot be revoked: a token stays valid
 * until it expires, so removing someone's access means waiting it out. On a system that models
 * who is accountable for what, an administrator has to be able to end a session NOW.
 */
export const sessions = pgTable(
  'session',
  {
    /** SHA-256 of the cookie value. A database leak must not yield usable session tokens. */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
    /** Kept so the IdP can be told to end its side too (OIDC RP-initiated logout). */
    idTokenHint: text('id_token_hint'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('session_user_idx').on(t.userId)],
);

/** Short-lived OIDC authorization-code state: the PKCE verifier and nonce, awaiting the callback. */
export const authRequests = pgTable('auth_request', {
  state: text('state').primaryKey(),
  codeVerifier: text('code_verifier').notNull(),
  nonce: text('nonce').notNull(),
  redirectTo: text('redirect_to').notNull().default('/'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const schema = {
  organizations,
  users,
  memberships,
  workspaces,
  docUpdates,
  docSnapshots,
  workspaceIndex,
  documentBlobs,
  directorySyncRuns,
  directoryPendingRemovals,
  auditLog,
  sessions,
  authRequests,
};

/** Set on a workspace row when the archive flag is used rather than a hard delete. */
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type DocUpdateRow = typeof docUpdates.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
