/**
 * Start a login.
 *
 * The PKCE verifier and the nonce go to the database rather than a cookie. The server has to write
 * an auth_request row anyway to make the state single-use, so keeping one source of truth means a
 * callback cannot be replayed by replaying a cookie.
 */

import { saveAuthRequest } from '@raci/db';

export default defineEventHandler(async (event) => {
  const redirectTo = getQuery(event).redirectTo;
  const oidc = useOidc();

  const { url, state, codeVerifier, nonce } = await oidc.beginLogin(
    // Only same-site paths: an open redirect here would let a login link bounce someone to an
    // attacker's page carrying their freshly-minted session.
    typeof redirectTo === 'string' && redirectTo.startsWith('/') ? redirectTo : '/',
  );

  await saveAuthRequest(useDb(), {
    state,
    codeVerifier,
    nonce,
    redirectTo: typeof redirectTo === 'string' && redirectTo.startsWith('/') ? redirectTo : '/',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  return sendRedirect(event, url, 302);
});
