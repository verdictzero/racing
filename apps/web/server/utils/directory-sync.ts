/**
 * The application's side of a directory sync.
 *
 * `@raci/directory` reads a directory and decides what the roster should become. This is the part
 * that knows where the roster lives — inside the workspace's CRDT document — and what to record
 * about a run, neither of which that package is allowed to know.
 *
 * WHY THE ROSTER IS WRITTEN THROUGH THE COLLABORATIVE DOCUMENT
 * The roster is workspace content: a person editing the Roster screen and a nightly sync are two
 * writers to the same data. Writing it anywhere else would mean two sources of truth that drift.
 * The sync's writes carry their own origin tag, so undo never treats a sync as one of your edits,
 * and the audit trail can tell the two apart.
 */

import * as Y from 'yjs';
import { Roster } from '@raci/core';
import { readWorkspace, setRoster } from '@raci/crdt';
import {
  runSync,
  tierMappingFromEnv,
  type ReconcileChange,
  type SyncOutcome,
} from '@raci/directory';
import {
  appendUpdate,
  clearPendingRemoval,
  finishSyncRun,
  loadDoc,
  recordAudit,
  recordPendingRemoval,
  startSyncRun,
} from '@raci/db';

/** Origin tag for sync writes — never a person's edit, so undo must not reach it. */
export const SYNC_ORIGIN = 'directory-sync';

export interface SyncRequest {
  readonly organizationId: string;
  readonly workspaceId: string;
  /** Null for the scheduled run. */
  readonly startedBy: string | null;
  /** Read the directory and report, but write nothing. */
  readonly dryRun?: boolean;
}

export interface SyncSummary {
  readonly runId: string | null;
  readonly status: SyncOutcome['status'] | 'skipped' | 'failed';
  readonly message: string;
  readonly stats: Record<string, number>;
  readonly changes: ReconcileChange[];
  readonly warnings: string[];
}

/**
 * Read the directory and, unless this is a dry run, write the roster into the workspace document.
 *
 * Never throws: a sync is a background operation, and an exception escaping into a cron handler
 * becomes an unhandled rejection nobody sees. Everything comes back as a summary, and the failure
 * is recorded in `directory_sync_run` where an administrator will look for it.
 */
export async function syncDirectoryIntoWorkspace(request: SyncRequest): Promise<SyncSummary> {
  const db = useDb();
  const source = await useDirectory();

  if (!source) {
    return {
      runId: null,
      status: 'skipped',
      message: 'DIRECTORY_PROVIDER is "none" — no directory is configured.',
      stats: {},
      changes: [],
      warnings: [],
    };
  }

  const run = await startSyncRun(db, {
    organizationId: request.organizationId,
    workspaceId: request.workspaceId,
    provider: source.name,
    startedBy: request.startedBy,
  });

  try {
    // The document is loaded rather than read from the projection, because the roster is document
    // content and the projection only carries what the gallery needs.
    const { doc } = await loadDoc(db, request.workspaceId);
    const existing = Roster.parse(readWorkspace(doc).roster);

    const outcome = await runSync({
      source,
      mapping: tierMappingFromEnv(process.env),
      existing,

      async commit(roster) {
        if (request.dryRun) return;

        // One transaction over the whole roster, so peers see a single coherent change rather
        // than six directorates arriving one at a time. Through the mutation, not through
        // `maps(doc)`: the roster is stored flat and re-nested at the boundary, and a writer that
        // reached past that seam would put the nested shape back into the document.
        const before = Y.encodeStateVector(doc);
        setRoster(doc, roster, SYNC_ORIGIN);

        await appendUpdate(db, {
          workspaceId: request.workspaceId,
          update: Y.encodeStateAsUpdate(doc, before),
          userId: request.startedBy,
          origin: SYNC_ORIGIN,
        });
      },

      async onMissing(change) {
        if (request.dryRun) return;
        await recordPendingRemoval(db, {
          workspaceId: request.workspaceId,
          tier: change.tier,
          rosterId: change.id,
          externalId: change.name,
          name: change.detail,
        });
      },

      async onReturned(rosterId) {
        if (request.dryRun) return;
        await clearPendingRemoval(db, request.workspaceId, rosterId);
      },
    });

    const stats = { ...outcome.result?.stats, durationMs: outcome.durationMs };

    await finishSyncRun(db, run.id, {
      // A refusal is a failure the operator has to see, not a quiet no-op.
      status: outcome.status === 'refused' ? 'failed' : 'succeeded',
      stats: stats as Record<string, number>,
      changes: outcome.result?.changes ?? [],
      warnings: outcome.result?.warnings ?? [],
      error: outcome.refusedBecause ?? undefined,
    });

    await recordAudit(db, {
      organizationId: request.organizationId,
      workspaceId: request.workspaceId,
      userId: request.startedBy,
      action: 'directory.sync',
      detail: { status: outcome.status, provider: source.name, dryRun: !!request.dryRun },
    });

    return {
      runId: run.id,
      status: outcome.status,
      message:
        outcome.refusedBecause ??
        (outcome.status === 'unchanged'
          ? 'The directory matches the roster; nothing was written.'
          : `Applied. ${outcome.result?.stats.unitsCreated ?? 0} new unit(s), ` +
            `${outcome.result?.stats.peopleCreated ?? 0} new person/people, ` +
            `${outcome.missingReported} record(s) no longer present (kept for review).`),
      stats: stats as Record<string, number>,
      changes: outcome.result?.changes ?? [],
      warnings: outcome.result?.warnings ?? [],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishSyncRun(db, run.id, { status: 'failed', error: message });
    console.error('[directory] sync failed', err);
    return {
      runId: run.id,
      status: 'failed',
      message,
      stats: {},
      changes: [],
      warnings: [],
    };
  }
}
