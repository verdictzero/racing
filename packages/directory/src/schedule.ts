/**
 * A minimal cron matcher, for the scheduled sync.
 *
 * WHY THIS EXISTS RATHER THAN A DEPENDENCY
 * Nitro's task scheduler is behind an experimental flag and, at 2.13, does not bundle a task from
 * `server/tasks/` under Nuxt 4 — verified, not assumed. Rather than depend on a feature that
 * silently produces no scheduled job, the sync is driven by a plain interval in a Nitro plugin,
 * and this decides whether a given minute is a run minute.
 *
 * A cron library would also do, and would be a package to vendor and patch in an air-gapped
 * deployment for something that is forty lines and fully testable. The same reasoning as the CSV
 * parser and the JWT verifier.
 *
 * SUPPORTED SYNTAX — the standard five fields:
 *
 *     ┌─ minute (0-59)
 *     │ ┌─ hour (0-23)
 *     │ │ ┌─ day of month (1-31)
 *     │ │ │ ┌─ month (1-12)
 *     │ │ │ │ ┌─ day of week (0-6, Sunday = 0)
 *     * * * * *
 *
 * with `*`, `a-b` ranges, `a,b,c` lists, and `* / n` steps. No `@daily`, no `L`, no `#` — the
 * shapes an operations team actually writes for a nightly job, and nothing else.
 *
 * DAY-OF-MONTH AND DAY-OF-WEEK ARE OR-ED when both are restricted, which is what cron itself does
 * and what surprises people who assume AND.
 */

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronError';
  }
}

interface Field {
  readonly values: Set<number>;
  /** True when the field was `*` — needed for the day-of-month / day-of-week OR rule. */
  readonly wildcard: boolean;
}

function parseField(spec: string, min: number, max: number, label: string): Field {
  if (spec === '*') {
    const values = new Set<number>();
    for (let i = min; i <= max; i++) values.add(i);
    return { values, wildcard: true };
  }

  const values = new Set<number>();
  for (const part of spec.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      throw new CronError(`${label}: "${part}" has an invalid step`);
    }

    let lo: number;
    let hi: number;
    if (rangePart === '*' || rangePart === undefined || rangePart === '') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(rangePart);
      hi = lo;
    }

    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      throw new CronError(`${label}: "${part}" is not a number or range`);
    }
    if (lo < min || hi > max || lo > hi) {
      throw new CronError(`${label}: "${part}" is outside ${min}-${max}`);
    }
    for (let i = lo; i <= hi; i += step) values.add(i);
  }
  return { values, wildcard: false };
}

export interface CronExpression {
  readonly minute: Field;
  readonly hour: Field;
  readonly dayOfMonth: Field;
  readonly month: Field;
  readonly dayOfWeek: Field;
  readonly source: string;
}

export function parseCron(expression: string): CronExpression {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CronError(
      `expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}: "${expression}"`,
    );
  }
  return {
    minute: parseField(parts[0]!, 0, 59, 'minute'),
    hour: parseField(parts[1]!, 0, 23, 'hour'),
    dayOfMonth: parseField(parts[2]!, 1, 31, 'day of month'),
    month: parseField(parts[3]!, 1, 12, 'month'),
    // 7 is accepted as Sunday, as most cron implementations do, and normalized to 0.
    dayOfWeek: parseField(parts[4]!, 0, 7, 'day of week'),
    source: expression.trim(),
  };
}

/** True when `date` falls in a minute the expression selects. Evaluated in local time. */
export function matchesCron(expression: CronExpression | string, date: Date): boolean {
  const cron = typeof expression === 'string' ? parseCron(expression) : expression;

  if (!cron.minute.values.has(date.getMinutes())) return false;
  if (!cron.hour.values.has(date.getHours())) return false;
  if (!cron.month.values.has(date.getMonth() + 1)) return false;

  const dom = date.getDate();
  const dow = date.getDay();
  const dowMatches = cron.dayOfWeek.values.has(dow) || (dow === 0 && cron.dayOfWeek.values.has(7));

  // Cron's genuinely surprising rule: when BOTH day fields are restricted, a match on either one
  // is enough. When only one is restricted, only that one is consulted.
  if (cron.dayOfMonth.wildcard && cron.dayOfWeek.wildcard) return true;
  if (cron.dayOfMonth.wildcard) return dowMatches;
  if (cron.dayOfWeek.wildcard) return cron.dayOfMonth.values.has(dom);
  return cron.dayOfMonth.values.has(dom) || dowMatches;
}

/**
 * The next minute at or after `from` that the expression selects, or null if there is none within
 * `limitDays`. Used to log when the next sync is due, which is the first thing anyone asks.
 */
export function nextRun(
  expression: CronExpression | string,
  from: Date = new Date(),
  limitDays = 366,
): Date | null {
  const cron = typeof expression === 'string' ? parseCron(expression) : expression;
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const limit = limitDays * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (matchesCron(cron, cursor)) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}
