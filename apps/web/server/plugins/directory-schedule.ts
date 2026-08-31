/**
 * The scheduled directory sync.
 *
 * A plain interval in a Nitro plugin, not a Nitro task. Nitro's task scheduler is behind an
 * experimental flag and, at 2.13 under Nuxt 4, does not bundle a file from `server/tasks/` —
 * verified, not assumed. A schedule that silently never fires is worse than no schedule, so this
 * takes the boring route: wake every minute, ask whether this minute matches the cron expression,
 * and run if it does.
 *
 * The admin endpoint (`POST /api/directory/sync`) does the same work on demand, so a deployment
 * that would rather drive this from a systemd timer or a Kubernetes CronJob — which is often what
 * an operations team on a closed network actually wants — can leave DIRECTORY_SYNC_CRON empty and
 * call the endpoint instead.
 */

import { listWorkspaces, organizations } from '@raci/db';
import { matchesCron, nextRun, parseCron } from '@raci/directory';

/** Wake often enough not to miss a minute, cheaply enough not to matter. */
const TICK_MS = 30_000;

export default defineNitroPlugin(() => {
  const expression = process.env.DIRECTORY_SYNC_CRON?.trim();
  if (!expression) {
    console.info('[directory] no DIRECTORY_SYNC_CRON — scheduled sync is off (endpoint still works)');
    return;
  }

  let cron;
  try {
    cron = parseCron(expression);
  } catch (err) {
    // Refusing to start a broken schedule is better than a schedule that quietly never fires.
    console.error(`[directory] DIRECTORY_SYNC_CRON is invalid: ${(err as Error).message}`);
    return;
  }

  console.info(
    `[directory] scheduled sync "${expression}" — next run ${nextRun(cron)?.toISOString() ?? 'never'}`,
  );

  // Guards against two ticks overlapping if a sync runs longer than the interval, which a large
  // directory over a slow link genuinely can.
  let running = false;
  let lastRunMinute = '';

  const timer = setInterval(() => {
    void (async () => {
      const now = new Date();
      // The interval fires more often than once a minute, so the minute is the idempotency key.
      const minute = now.toISOString().slice(0, 16);
      if (minute === lastRunMinute) return;
      if (!matchesCron(cron, now)) return;
      if (running) {
        console.warn('[directory] previous sync still running; skipping this occurrence');
        return;
      }

      lastRunMinute = minute;
      running = true;
      try {
        const db = useDb();
        const orgs = await db.select().from(organizations);
        for (const org of orgs) {
          // Every workspace, because the roster is per-workspace document content and one left
          // out would drift silently — "why is this chart's roster stale" is a bad bug to meet
          // six months later.
          for (const workspace of await listWorkspaces(db, org.id)) {
            const summary = await syncDirectoryIntoWorkspace({
              organizationId: org.id,
              workspaceId: workspace.id,
              startedBy: null,
            });
            if (summary.status === 'refused' || summary.status === 'failed') {
              console.error(`[directory] ${workspace.name}: ${summary.message}`);
            }
          }
        }
      } catch (err) {
        // An exception escaping here would become an unhandled rejection nobody sees.
        console.error('[directory] scheduled sync failed', err);
      } finally {
        running = false;
      }
    })();
  }, TICK_MS);

  // Do not hold the process open just for the scheduler.
  if (typeof timer.unref === 'function') timer.unref();
});
