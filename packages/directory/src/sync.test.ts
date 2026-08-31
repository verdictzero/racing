import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Roster } from '@raci/core';
import { CsvDirectorySource, parseDirectoryCsv } from './adapters/csv.js';
import { reconcile } from './reconcile.js';
import { runSync, tierMappingFromEnv } from './sync.js';
import { TierMapping, type DirectorySource } from './port.js';

const SAMPLE = readFileSync(
  join(import.meta.dirname, '../../../ops/directory/sample-org.csv'),
  'utf8',
);

const MAPPING = TierMapping.parse({
  directorates: { ocio: 'OU=OCIO', cyber: 'OU=Cyber' },
  useDepthFallback: true,
});

const fullSource = () => new CsvDirectorySource({ text: SAMPLE });

/** A source that returns exactly what it is given — for staging a bad read. */
function sourceOf(csv: string): DirectorySource {
  return {
    name: 'test',
    async fetch() {
      return parseDirectoryCsv(csv, 'test');
    },
  };
}

async function firstSync() {
  const committed: { roster: Roster | null } = { roster: null };
  await runSync({
    source: fullSource(),
    mapping: MAPPING,
    commit: (roster) => {
      committed.roster = roster;
    },
  });
  return committed.roster!;
}

describe('runSync', () => {
  it('commits the reconciled roster on a first run', async () => {
    const commit = vi.fn();
    const outcome = await runSync({ source: fullSource(), mapping: MAPPING, commit });

    expect(outcome.status).toBe('applied');
    expect(commit).toHaveBeenCalledOnce();
    const [roster] = commit.mock.calls[0]!;
    expect((roster as Roster).ocio!.divisions[0]!.name).toBe('Governance Division');
  });

  it('writes nothing when a re-sync changes nothing', async () => {
    // A nightly sync against an unchanged directory should leave no trace. Committing anyway puts
    // an empty update in the document log and an empty row in the history every night, which is
    // how an audit trail becomes one nobody reads.
    const existing = await firstSync();
    const commit = vi.fn();
    const outcome = await runSync({ source: fullSource(), mapping: MAPPING, existing, commit });

    expect(outcome.status).toBe('unchanged');
    expect(commit).not.toHaveBeenCalled();
  });

  it('commits again once the directory actually changes', async () => {
    const existing = await firstSync();
    const withNewPerson =
      SAMPLE.trimEnd() +
      '\np-1099,New Starter,Analyst,new.starter@asic.army.mil,p-1001,ou-ocio-gov-pol-a,Standards Team,ou-ocio-gov-pol,,true\n';

    const commit = vi.fn();
    const outcome = await runSync({
      source: sourceOf(withNewPerson),
      mapping: MAPPING,
      existing,
      commit,
    });

    expect(outcome.status).toBe('applied');
    expect(commit).toHaveBeenCalledOnce();
    expect(outcome.result!.stats.peopleCreated).toBe(1);
  });
});

describe('the shrink circuit breaker', () => {
  /**
   * The failure that actually happens in the field: a bind that SUCCEEDS but returns almost
   * nothing, because the service account lost a permission or someone mistyped the base DN.
   * Without a guard, that reads as "the organization vanished" and every RACI assignment in the
   * workspace loses what it points at.
   */
  it('refuses a read that would drop most of the roster', async () => {
    const existing = await firstSync();
    const almostEmpty = SAMPLE.split('\n').slice(0, 3).join('\n') + '\n';

    const commit = vi.fn();
    const outcome = await runSync({
      source: sourceOf(almostEmpty),
      mapping: MAPPING,
      existing,
      commit,
    });

    expect(outcome.status).toBe('refused');
    expect(commit).not.toHaveBeenCalled();
    expect(outcome.refusedBecause).toMatch(/drop \d+% of the roster/);
    // The reason has to name the likely cause and the way out, or whoever reads it at 3am is stuck.
    expect(outcome.refusedBecause).toMatch(/failed query or a lost permission/);
  });

  it('allows a genuinely large change when the operator says so', async () => {
    const existing = await firstSync();
    const almostEmpty = SAMPLE.split('\n').slice(0, 3).join('\n') + '\n';

    const commit = vi.fn();
    const outcome = await runSync({
      source: sourceOf(almostEmpty),
      mapping: MAPPING,
      existing,
      commit,
      maxShrinkRatio: 1, // disabled
    });

    expect(outcome.status).toBe('applied');
    expect(commit).toHaveBeenCalledOnce();
  });

  it('does not fire on a first sync, when there is nothing to shrink from', async () => {
    const outcome = await runSync({ source: fullSource(), mapping: MAPPING, commit: vi.fn() });
    expect(outcome.status).toBe('applied');
  });

  it('does not fire on a modest reduction', async () => {
    const existing = await firstSync();
    // One person leaves. Normal, and must not trip a circuit breaker.
    const oneFewer = SAMPLE.split('\n')
      .filter((line) => !line.startsWith('p-2002,'))
      .join('\n');

    const outcome = await runSync({
      source: sourceOf(oneFewer),
      mapping: MAPPING,
      existing,
      commit: vi.fn(),
    });
    expect(outcome.status).toBe('applied');
  });
});

describe('missing records', () => {
  it('reports each absence instead of deleting it', async () => {
    const existing = await firstSync();
    // The whole Cyber directorate stops being returned — but only that, so the shrink stays under
    // the threshold and the runner proceeds rather than refusing.
    const withoutCyber = SAMPLE.split('\n')
      .filter((line, i) => i === 0 || (!line.includes('ou-cyber') && !line.startsWith('p-2')))
      .join('\n');

    const onMissing = vi.fn();
    const commit = vi.fn();
    const outcome = await runSync({
      source: sourceOf(withoutCyber),
      mapping: MAPPING,
      existing,
      commit,
      onMissing,
      maxShrinkRatio: 1,
    });

    expect(outcome.status).toBe('applied');
    expect(onMissing).toHaveBeenCalled();
    expect(outcome.missingReported).toBeGreaterThan(0);
    for (const [change] of onMissing.mock.calls) {
      expect(['unit-missing', 'person-missing']).toContain(change.kind);
      expect(change.detail).toMatch(/confirm before removing/);
    }
  });

  it('clears the absence count for records that came back', async () => {
    const existing = await firstSync();
    const onReturned = vi.fn();
    await runSync({
      source: fullSource(),
      mapping: MAPPING,
      existing,
      commit: vi.fn(),
      onReturned,
    });
    // Every externalId still present is reported, so a flicker does not accumulate a count across
    // unrelated outages.
    expect(onReturned).toHaveBeenCalled();
    expect(onReturned.mock.calls.some(([id]) => id === 'ou-ocio-gov-pol-a')).toBe(true);
  });
});

describe('failure handling', () => {
  it('lets an unreachable directory throw, because that is an outage and not a decision', async () => {
    const broken: DirectorySource = {
      name: 'broken',
      async fetch() {
        throw new Error('ECONNREFUSED');
      },
    };
    await expect(
      runSync({ source: broken, mapping: MAPPING, commit: vi.fn() }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('does not commit when the commit itself fails', async () => {
    await expect(
      runSync({
        source: fullSource(),
        mapping: MAPPING,
        commit: () => {
          throw new Error('database is down');
        },
      }),
    ).rejects.toThrow(/database is down/);
  });
});

describe('tierMappingFromEnv', () => {
  it('reads a mapping', () => {
    const mapping = tierMappingFromEnv({
      DIRECTORY_TIER_MAPPING: JSON.stringify({
        directorates: { ocio: 'OU=OCIO' },
        exclude: ['OU=Service Accounts'],
      }),
    });
    expect(mapping.directorates).toEqual({ ocio: 'OU=OCIO' });
    expect(mapping.exclude).toEqual(['OU=Service Accounts']);
    expect(mapping.useDepthFallback).toBe(true);
  });

  it('defaults to depth-only mapping when unset', () => {
    expect(tierMappingFromEnv({}).useDepthFallback).toBe(true);
  });

  it('stops at boot rather than syncing into the wrong directorate', () => {
    expect(() => tierMappingFromEnv({ DIRECTORY_TIER_MAPPING: '{not json' })).toThrow(
      /not valid JSON/,
    );
  });
});

describe('the roster the runner produces', () => {
  it('is the same one reconcile() would give, so the runner adds policy and not transformation', async () => {
    const snapshot = await fullSource().fetch();
    const direct = reconcile(snapshot, { mapping: MAPPING });

    const commit = vi.fn();
    await runSync({ source: fullSource(), mapping: MAPPING, commit });
    const [viaRunner] = commit.mock.calls[0]!;

    // Ids are freshly minted on each first sync, so compare the SHAPE rather than the values.
    const shape = (roster: Roster) =>
      Object.entries(roster)
        .map(([actor, d]) =>
          [
            actor,
            (d?.divisions ?? []).map((dv) => [
              dv.name,
              dv.branches.map((b) => [b.name, b.teams.map((t) => [t.name, t.people.length])]),
            ]),
          ],
        )
        .sort();

    expect(shape(viaRunner as Roster)).toEqual(shape(direct.roster));
  });
});
