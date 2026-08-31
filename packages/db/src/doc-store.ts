/**
 * Loading and persisting a collaborative document.
 *
 * THE LOADING PATH is the newest snapshot plus every update recorded after it. Without snapshots,
 * opening a workspace edited for a year would mean replaying a year of keystrokes; with them it
 * is bounded by how long ago the last compaction ran.
 *
 * THE WRITING PATH is an append. Two clients saving at the same instant produce two INSERTs, which
 * cannot conflict — no row to lock, no version to compare. That is the whole reason the log is the
 * source of truth rather than a shredded relational projection: the database never becomes the
 * bottleneck the CRDT was chosen to avoid.
 *
 * COMPACTION is deliberately additive. A snapshot is written, and only then are the updates it
 * covers pruned — and only ones a snapshot demonstrably covers. A compaction that dies halfway
 * leaves a workspace with redundant history, which costs a little space and loses nothing.
 */

import { and, asc, desc, eq, gt, lt, sql } from 'drizzle-orm';
import * as Y from 'yjs';
import { docSnapshots, docUpdates, workspaceIndex, workspaces } from './schema.js';
import type { Database } from './client.js';

export interface LoadedDoc {
  readonly doc: Y.Doc;
  /** Highest update id folded in. Pass to `appendUpdate` callers that need causality. */
  readonly throughUpdateId: number;
  /** How many updates were replayed on top of the snapshot — the compaction signal. */
  readonly replayed: number;
}

/** Load a workspace's document: newest snapshot, then everything after it. */
export async function loadDoc(db: Database, workspaceId: string): Promise<LoadedDoc> {
  const doc = new Y.Doc();

  const [snapshot] = await db
    .select()
    .from(docSnapshots)
    .where(eq(docSnapshots.workspaceId, workspaceId))
    .orderBy(desc(docSnapshots.id))
    .limit(1);

  let through = snapshot?.throughUpdateId ?? 0;
  if (snapshot) Y.applyUpdate(doc, snapshot.state, 'db');

  const pending = await db
    .select({ id: docUpdates.id, update: docUpdates.update })
    .from(docUpdates)
    .where(and(eq(docUpdates.workspaceId, workspaceId), gt(docUpdates.id, through)))
    .orderBy(asc(docUpdates.id));

  // One transaction so observers see a single coherent load rather than a storm of updates.
  doc.transact(() => {
    for (const row of pending) {
      Y.applyUpdate(doc, row.update, 'db');
      through = row.id;
    }
  }, 'db');

  return { doc, throughUpdateId: through, replayed: pending.length };
}

export interface AppendOptions {
  readonly workspaceId: string;
  readonly update: Uint8Array;
  readonly userId?: string | null;
  readonly origin?: string;
}

/** Append one update. Returns its id. */
export async function appendUpdate(db: Database, opts: AppendOptions): Promise<number> {
  const [row] = await db
    .insert(docUpdates)
    .values({
      workspaceId: opts.workspaceId,
      update: opts.update,
      userId: opts.userId ?? null,
      origin: opts.origin ?? 'local',
    })
    .returning({ id: docUpdates.id });

  await db
    .update(workspaces)
    .set({ updatedAt: new Date() })
    .where(eq(workspaces.id, opts.workspaceId));

  return row!.id;
}

/** How many updates sit above the newest snapshot — what decides when to compact. */
export async function pendingUpdateCount(db: Database, workspaceId: string): Promise<number> {
  const [snapshot] = await db
    .select({ through: docSnapshots.throughUpdateId })
    .from(docSnapshots)
    .where(eq(docSnapshots.workspaceId, workspaceId))
    .orderBy(desc(docSnapshots.id))
    .limit(1);

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(docUpdates)
    .where(
      and(
        eq(docUpdates.workspaceId, workspaceId),
        gt(docUpdates.id, snapshot?.through ?? 0),
      ),
    );
  return row?.count ?? 0;
}

export interface CompactResult {
  readonly snapshotId: number;
  readonly throughUpdateId: number;
  readonly prunedUpdates: number;
  readonly prunedSnapshots: number;
}

/**
 * Write a snapshot and prune what it covers.
 *
 * `keepSnapshots` leaves a few older snapshots in place. They are small next to the update log and
 * they are the only way back if a snapshot is ever written from a document that was itself loaded
 * from bad state — cheap insurance against a class of bug that would otherwise be unrecoverable.
 */
export async function compact(
  db: Database,
  workspaceId: string,
  opts: { keepSnapshots?: number } = {},
): Promise<CompactResult | null> {
  const { doc, throughUpdateId } = await loadDoc(db, workspaceId);
  if (throughUpdateId === 0) return null; // nothing recorded yet

  const state = Y.encodeStateAsUpdate(doc);
  const [snapshot] = await db
    .insert(docSnapshots)
    .values({ workspaceId, state, throughUpdateId })
    .returning({ id: docSnapshots.id });

  // Only now, with the snapshot durable, is it safe to drop what it covers. A crash before this
  // point leaves redundant history — which costs space and loses nothing.
  const pruned = await db
    .delete(docUpdates)
    .where(
      and(eq(docUpdates.workspaceId, workspaceId), lt(docUpdates.id, throughUpdateId + 1)),
    )
    .returning({ id: docUpdates.id });

  const keep = opts.keepSnapshots ?? 3;
  const old = await db
    .select({ id: docSnapshots.id })
    .from(docSnapshots)
    .where(eq(docSnapshots.workspaceId, workspaceId))
    .orderBy(desc(docSnapshots.id))
    .offset(keep);

  let prunedSnapshots = 0;
  if (old.length > 0) {
    for (const row of old) {
      await db.delete(docSnapshots).where(eq(docSnapshots.id, row.id));
      prunedSnapshots++;
    }
  }

  return {
    snapshotId: snapshot!.id,
    throughUpdateId,
    prunedUpdates: pruned.length,
    prunedSnapshots,
  };
}

/**
 * Rebuild the SQL projection from the document.
 *
 * Called after a write settles. It is derived data, so it is rebuilt wholesale rather than patched
 * — a diff-based update is a second implementation of the same truth and a second thing to get
 * subtly wrong, and the row count here is small enough that wholesale costs nothing.
 */
export async function reindexWorkspace(
  db: Database,
  workspaceId: string,
  projection: Array<{
    kind: 'chart' | 'flow';
    artifactId: string;
    title: string;
    status: string;
    searchText: string;
    meta: Record<string, unknown>;
    nodeCount: number;
  }>,
): Promise<void> {
  await db.delete(workspaceIndex).where(eq(workspaceIndex.workspaceId, workspaceId));
  if (projection.length === 0) return;
  await db.insert(workspaceIndex).values(
    projection.map((p) => ({
      workspaceId,
      kind: p.kind,
      artifactId: p.artifactId,
      title: p.title,
      status: p.status,
      searchText: p.searchText,
      meta: p.meta,
      nodeCount: p.nodeCount,
      updatedAt: new Date(),
    })),
  );
}
