/**
 * The OIDC callback: verify, then establish a session.
 *
 * The order matters. Nothing is trusted until verifyIdToken has checked the signature, the issuer,
 * the audience, the nonce and the expiry — see the note at the top of @raci/auth/verify.ts.
 */

import { hashToken, randomToken, verifyIdToken, mapRoles } from '@raci/auth';
import {
  consumeAuthRequest,
  createOrganization,
  createSession,
  findOrganizationBySlug,
  recordAudit,
  setMembership,
  upsertUserFromClaims,
} from '@raci/db';

/** Single-tenant default. A multi-tenant deployment resolves this from the host or a claim. */
const DEFAULT_ORG_SLUG = 'asic';

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const code = typeof query.code === 'string' ? query.code : null;
  const state = typeof query.state === 'string' ? query.state : null;

  if (query.error) {
    throw createError({
      statusCode: 400,
      statusMessage: `The identity provider refused the sign-in: ${String(query.error_description ?? query.error)}`,
    });
  }
  if (!code || !state) {
    throw createError({ statusCode: 400, statusMessage: 'Callback is missing code or state' });
  }

  const db = useDb();

  // Consuming the request is what makes state single-use — a replayed callback finds nothing.
  const pending = await consumeAuthRequest(db, state);
  if (!pending) {
    throw createError({
      statusCode: 400,
      statusMessage: 'This sign-in link has already been used or has expired. Start again.',
    });
  }

  const oidc = useOidc();
  const config = useOidcConfig();
  const tokens = await oidc.exchangeCode(code, pending.codeVerifier);

  const verified = await verifyIdToken({
    idToken: tokens.id_token,
    keys: await oidc.signingKeys(),
    issuer: config.issuer,
    audience: config.clientId,
    nonce: pending.nonce,
    rolesClaim: config.rolesClaim,
    subjectClaim: config.subjectClaim,
  });

  const organization =
    (await findOrganizationBySlug(db, DEFAULT_ORG_SLUG)) ??
    (await createOrganization(db, 'ASIC', DEFAULT_ORG_SLUG));

  const user = await upsertUserFromClaims(db, {
    organizationId: organization.id,
    issuer: verified.issuer,
    externalId: verified.subject,
    email: verified.email,
    displayName: verified.displayName,
  });

  const role = mapRoles(verified.roles, useRoleMap(), 'viewer') ?? 'viewer';
  await setMembership(db, user.id, organization.id, role);

  // The cookie carries the token; the database stores only its hash, so a database leak yields no
  // usable sessions.
  const token = randomToken(32);
  await createSession(db, {
    id: await hashToken(token),
    userId: user.id,
    expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
    userAgent: getRequestHeader(event, 'user-agent') ?? null,
    ipAddress: getRequestIP(event, { xForwardedFor: true }) ?? null,
    idTokenHint: tokens.id_token,
  });

  setCookie(event, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax', // 'strict' would drop the cookie on the redirect back from the IdP
    secure: !import.meta.dev,
    path: '/',
    maxAge: 12 * 60 * 60,
  });

  await recordAudit(db, {
    organizationId: organization.id,
    userId: user.id,
    action: 'auth.login',
    detail: { issuer: verified.issuer, role },
  });

  return sendRedirect(event, pending.redirectTo, 302);
});
