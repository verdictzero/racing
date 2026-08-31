/** Workspaces the caller can see. Scoped by organization in the repository, not here. */
import { listWorkspaces } from '@raci/db';

export default defineEventHandler(async (event) => {
  const session = await requireSession(event);
  const rows = await listWorkspaces(useDb(), session.organizationId);
  return rows.map((w) => ({
    id: w.id,
    name: w.name,
    updatedAt: w.updatedAt,
  }));
});
