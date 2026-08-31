/**
 * Sign out here, and at the IdP.
 *
 * Ending only the local session would leave the IdP's cookie in place, so the next "sign in" would
 * silently walk straight back in without a prompt — which looks exactly like the logout failed.
 */

import { recordAudit, revokeSession } from '@raci/db';

export default defineEventHandler(async (event) => {
  const session = await getSession(event);
  const db = useDb();

  if (session) {
    await revokeSession(db, session.sessionId);
    await recordAudit(db, {
      organizationId: session.organizationId,
      userId: session.userId,
      action: 'auth.logout',
    });
  }
  deleteCookie(event, SESSION_COOKIE, { path: '/' });

  const endSession = await useOidc()
    .endSessionUrl(null)
    .catch(() => null);
  return { ok: true, endSessionUrl: endSession };
});
