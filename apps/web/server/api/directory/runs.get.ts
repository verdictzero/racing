/** Recent sync runs, so an administrator can see what the nightly job has been doing. */
import { listSyncRuns } from '@raci/db';

export default defineEventHandler(async (event) => {
  const session = await requireRole(event, 'admin');
  const limit = Number(getQuery(event).limit ?? 20);
  return listSyncRuns(useDb(), session.organizationId, Math.min(100, Math.max(1, limit)));
});
