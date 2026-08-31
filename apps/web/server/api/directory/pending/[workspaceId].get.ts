/**
 * Records the directory has stopped returning, awaiting a human decision.
 *
 * `missedSyncs` is the number that matters: one absence is usually a failed query or a lost
 * permission, several in a row is a reorganization. Nothing is ever removed automatically, so this
 * list is the only place those records surface.
 */
import { listPendingRemovals, getWorkspace } from '@raci/db';

export default defineEventHandler(async (event) => {
  const session = await requireRole(event, 'admin');
  const workspaceId = getRouterParam(event, 'workspaceId')!;

  const workspace = await getWorkspace(useDb(), session.organizationId, workspaceId);
  if (!workspace) throw createError({ statusCode: 404, statusMessage: 'No such workspace' });

  return listPendingRemovals(useDb(), workspaceId);
});
