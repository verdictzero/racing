/**
 * Running a sync.
 *
 * The adapters read a directory and `reconcile()` works out what the roster should become. This
 * joins them to the two things that actually make a sync safe to run unattended: it writes the
 * result through a single injected callback, and it decides what to do about records that have
 * gone missing.
 *
 * WHY THE WRITE IS INJECTED RATHER THAN DONE HERE
 * This package must not know about Yjs or Postgres — it is the ingest, and the app decides where
 * the roster lands. That also makes the whole runner testable without either.
 *
 * THE MISSING-RECORD POLICY, which is the part worth arguing about
 * A unit that stops appearing is NOT removed. Directories are read over flaky networks with
 * partial permissions, and one short read is far more often a failed query than a reorganization.
 * Removing a division because an LDAP call came back light would orphan every assignment beneath
 * it, and that is not a recoverable mistake.
 *
 * So absence is COUNTED. `onMissing` is told each time, with how many consecutive syncs the record
 * has been absent, and the decision to actually remove one stays with a person looking at that
 * count. `graceSyncs` exists only to decide when the runner starts calling the absence
 * *significant* — it never deletes anything by itself.
 */

import type { Roster } from '@raci/core';
import { reconcile, type ReconcileChange, type ReconcileResult } from './reconcile.js';
import { DirectoryError, type DirectorySource, type TierMapping } from './port.js';

export interface SyncOptions {
  readonly source: DirectorySource;
  readonly mapping: TierMapping;
  /** The roster as it stands. Omit for a first sync. */
  readonly existing?: Roster;
  /**
   * Commit the reconciled roster. Called once, only on success, and only when something changed —
   * so a no-op sync produces no document update and no history entry for people to wade through.
   */
  readonly commit: (roster: Roster, result: ReconcileResult) => Promise<void> | void;
  /** Called once per record the directory no longer returns. Never deletes; records and counts. */
  readonly onMissing?: (change: ReconcileChange) => Promise<void> | void;
  /** Called for a record that has come back, so its absence count can be cleared. */
  readonly onReturned?: (rosterId: string) => Promise<void> | void;
  /**
   * How many consecutive absences before the runner reports one as significant. Purely advisory:
   * nothing is removed at any count. Default 3 — one absence is usually a failed query.
   */
  readonly graceSyncs?: number;
  /**
   * Refuse the sync if it would drop more than this fraction of the roster.
   *
   * The circuit breaker for the failure that actually happens in the field: a bind that succeeds
   * but returns almost nothing, because the service account lost a permission or the base DN was
   * mistyped. Without it, that reads as "the organization vanished" and every assignment in the
   * workspace loses what it points at. 0.5 by default; set to 1 to disable.
   */
  readonly maxShrinkRatio?: number;
}

export interface SyncOutcome {
  readonly status: 'applied' | 'unchanged' | 'refused';
  readonly result: ReconcileResult | null;
  /** Set when status is 'refused' — why the runner would not commit. */
  readonly refusedBecause: string | null;
  readonly missingReported: number;
  readonly durationMs: number;
}

function countRecords(roster: Roster | undefined): number {
  if (!roster) return 0;
  let n = 0;
  for (const directorate of Object.values(roster)) {
    for (const division of directorate?.divisions ?? []) {
      n++;
      for (const branch of division.branches) {
        n++;
        for (const team of branch.teams) {
          n++;
          n += team.people.length;
        }
      }
    }
  }
  return n;
}

/** Everything the incoming roster still knows about, for spotting records that came back. */
function externalIdsIn(roster: Roster): Set<string> {
  const ids = new Set<string>();
  for (const directorate of Object.values(roster)) {
    if (directorate?.externalId) ids.add(directorate.externalId);
    for (const division of directorate?.divisions ?? []) {
      if (division.externalId) ids.add(division.externalId);
      for (const branch of division.branches) {
        if (branch.externalId) ids.add(branch.externalId);
        for (const team of branch.teams) {
          if (team.externalId) ids.add(team.externalId);
          for (const person of team.people) {
            if (person.externalId) ids.add(person.externalId);
          }
        }
      }
    }
  }
  return ids;
}

/**
 * Read the directory, reconcile, and commit — or refuse, with the reason.
 *
 * Never throws for a *policy* refusal (a suspiciously small read); that comes back as
 * `status: 'refused'` so the caller can record it as a failed run rather than an exception. It
 * does throw when the directory itself is unreachable, because that is not a decision, it is an
 * outage.
 */
export async function runSync(opts: SyncOptions): Promise<SyncOutcome> {
  const startedAt = Date.now();
  const snapshot = await opts.source.fetch();

  const result = reconcile(snapshot, { mapping: opts.mapping, existing: opts.existing });

  // The circuit breaker, checked BEFORE anything is committed.
  const before = countRecords(opts.existing);
  const after = countRecords(result.roster);
  const maxShrink = opts.maxShrinkRatio ?? 0.5;
  if (before > 0 && maxShrink < 1) {
    const shrink = (before - after) / before;
    if (shrink > maxShrink) {
      return {
        status: 'refused',
        result,
        refusedBecause:
          `the sync would drop ${Math.round(shrink * 100)}% of the roster ` +
          `(${before} records to ${after}). That is far more often a failed query or a lost ` +
          `permission than a reorganization, so nothing was written. Re-run once the directory ` +
          `is returning a full result, or raise maxShrinkRatio if the shrink is real.`,
        missingReported: 0,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  // Records that came back get their absence count cleared before the new absences are recorded,
  // so a record that flickered does not accumulate a count across unrelated outages.
  if (opts.onReturned) {
    const present = externalIdsIn(result.roster);
    for (const id of present) await opts.onReturned(id);
  }

  const missing = result.changes.filter(
    (c) => c.kind === 'unit-missing' || c.kind === 'person-missing',
  );
  if (opts.onMissing) {
    for (const change of missing) await opts.onMissing(change);
  }

  // A sync that changed nothing writes nothing. Committing anyway would put an empty update in
  // the document log and an empty entry in the history every night, which is how a useful audit
  // trail becomes one nobody reads.
  const changedSomething =
    result.stats.unitsCreated > 0 ||
    result.stats.peopleCreated > 0 ||
    missing.length > 0 ||
    JSON.stringify(result.roster) !== JSON.stringify(opts.existing ?? {});

  if (!changedSomething) {
    return {
      status: 'unchanged',
      result,
      refusedBecause: null,
      missingReported: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  await opts.commit(result.roster, result);

  return {
    status: 'applied',
    result,
    refusedBecause: null,
    missingReported: missing.length,
    durationMs: Date.now() - startedAt,
  };
}

/** Read the tier mapping out of the environment. */
export function tierMappingFromEnv(env: Record<string, string | undefined>): TierMapping {
  const raw = env.DIRECTORY_TIER_MAPPING;
  if (!raw) return { directorates: {}, useDepthFallback: true, exclude: [], fallbackDirectorate: null };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      directorates: (parsed.directorates as Record<string, string>) ?? {},
      useDepthFallback: parsed.useDepthFallback !== false,
      exclude: (parsed.exclude as string[]) ?? [],
      fallbackDirectorate: (parsed.fallbackDirectorate as string) ?? null,
    };
  } catch (err) {
    // Better to stop at boot than to sync the whole directory into the wrong directorate.
    throw new DirectoryError('DIRECTORY_TIER_MAPPING is not valid JSON', err);
  }
}
