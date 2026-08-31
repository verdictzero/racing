import { describe, it, expect } from 'vitest';
import { CronError, matchesCron, nextRun, parseCron } from './schedule.js';

/** Local time, so the tests read the way an operator writes a cron line. */
const at = (iso: string) => new Date(iso);

describe('parseCron', () => {
  it('accepts the five standard fields', () => {
    expect(parseCron('0 3 * * *').source).toBe('0 3 * * *');
  });

  it('rejects the wrong number of fields, saying what it wanted', () => {
    expect(() => parseCron('0 3 * *')).toThrow(/expected 5 fields/);
    expect(() => parseCron('* * * * * *')).toThrow(/got 6/);
  });

  it('rejects out-of-range values rather than silently never firing', () => {
    expect(() => parseCron('60 * * * *')).toThrow(/minute/);
    expect(() => parseCron('* 24 * * *')).toThrow(/hour/);
    expect(() => parseCron('* * 0 * *')).toThrow(/day of month/);
    expect(() => parseCron('* * * 13 *')).toThrow(/month/);
  });

  it('rejects nonsense', () => {
    expect(() => parseCron('a b c d e')).toThrow(CronError);
    expect(() => parseCron('*/0 * * * *')).toThrow(/step/);
    expect(() => parseCron('5-2 * * * *')).toThrow(/outside/);
  });
});

describe('matchesCron', () => {
  it('matches a nightly job at the right minute only', () => {
    const cron = '0 3 * * *';
    expect(matchesCron(cron, at('2026-08-31T03:00:00'))).toBe(true);
    expect(matchesCron(cron, at('2026-08-31T03:01:00'))).toBe(false);
    expect(matchesCron(cron, at('2026-08-31T04:00:00'))).toBe(false);
  });

  it('handles lists, ranges and steps', () => {
    expect(matchesCron('0,30 * * * *', at('2026-08-31T09:30:00'))).toBe(true);
    expect(matchesCron('0,30 * * * *', at('2026-08-31T09:15:00'))).toBe(false);
    expect(matchesCron('0 9-17 * * *', at('2026-08-31T12:00:00'))).toBe(true);
    expect(matchesCron('0 9-17 * * *', at('2026-08-31T18:00:00'))).toBe(false);
    expect(matchesCron('*/15 * * * *', at('2026-08-31T09:45:00'))).toBe(true);
    expect(matchesCron('*/15 * * * *', at('2026-08-31T09:46:00'))).toBe(false);
  });

  it('matches a weekday-only schedule', () => {
    // 2026-08-31 is a Monday; 2026-09-05 is a Saturday.
    expect(matchesCron('0 3 * * 1-5', at('2026-08-31T03:00:00'))).toBe(true);
    expect(matchesCron('0 3 * * 1-5', at('2026-09-05T03:00:00'))).toBe(false);
  });

  it('accepts 7 as Sunday, as most cron implementations do', () => {
    expect(matchesCron('0 3 * * 7', at('2026-09-06T03:00:00'))).toBe(true); // a Sunday
    expect(matchesCron('0 3 * * 0', at('2026-09-06T03:00:00'))).toBe(true);
  });

  it('ORs the two day fields when both are restricted — cron’s genuinely surprising rule', () => {
    // "1st of the month OR a Monday", not "the 1st AND a Monday".
    const cron = '0 3 1 * 1';
    expect(matchesCron(cron, at('2026-09-01T03:00:00'))).toBe(true); // the 1st, a Tuesday
    expect(matchesCron(cron, at('2026-08-31T03:00:00'))).toBe(true); // a Monday, the 31st
    expect(matchesCron(cron, at('2026-09-02T03:00:00'))).toBe(false); // neither
  });

  it('uses only the restricted field when the other is a wildcard', () => {
    expect(matchesCron('0 3 15 * *', at('2026-09-15T03:00:00'))).toBe(true);
    expect(matchesCron('0 3 15 * *', at('2026-09-16T03:00:00'))).toBe(false);
  });

  it('matches every minute for the all-wildcards expression', () => {
    expect(matchesCron('* * * * *', at('2026-08-31T03:07:00'))).toBe(true);
  });
});

describe('nextRun', () => {
  it('finds the next occurrence', () => {
    const next = nextRun('0 3 * * *', at('2026-08-31T09:00:00'));
    expect(next?.toISOString().slice(0, 16)).toBe(
      new Date('2026-09-01T03:00:00').toISOString().slice(0, 16),
    );
  });

  it('never returns the current minute, so a run cannot double-fire', () => {
    const now = at('2026-08-31T03:00:00');
    const next = nextRun('0 3 * * *', now);
    expect(next!.getTime()).toBeGreaterThan(now.getTime());
  });

  it('returns null when nothing matches inside the horizon', () => {
    // 30 February never happens.
    expect(nextRun('0 3 30 2 *', at('2026-01-01T00:00:00'), 366)).toBeNull();
  });

  it('crosses a month boundary', () => {
    const next = nextRun('0 0 1 * *', at('2026-08-31T23:59:00'));
    expect(next?.getDate()).toBe(1);
    expect(next?.getMonth()).toBe(8); // September
  });
});
