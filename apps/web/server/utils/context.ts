/**
 * Server singletons and the per-request session.
 *
 * The database pool, the OIDC client and the directory adapter are built once per process and
 * reused. Building them per request would open a connection pool per request, and re-fetch the
 * IdP's discovery document on every login.
 */

import { createDatabase, resolveSession, type Database, type Role } from '@raci/db';
import { OidcClient, oidcConfigFromEnv, type OidcConfig } from '@raci/auth';
import {
  createDirectorySource,
  directoryConfigFromEnv,
  type DirectorySource,
} from '@raci/directory';
import type { H3Event } from 'h3';

let _db: Database | null = null;
let _oidc: OidcClient | null = null;
let _oidcConfig: OidcConfig | null = null;
let _directory: DirectorySource | null | undefined;

export function useDb(): Database {
  if (_db) return _db;
  const url = useRuntimeConfig().databaseUrl || process.env.DATABASE_URL;
  if (!url) {
    throw createError({
      statusCode: 500,
      statusMessage: 'DATABASE_URL is not set — see .env.example',
    });
  }
  _db = createDatabase({ url }).db;
  return _db;
}

export function useOidcConfig(): OidcConfig {
  if (_oidcConfig) return _oidcConfig;
  const config = useRuntimeConfig();
  _oidcConfig = oidcConfigFromEnv({
    AUTH_OIDC_ISSUER: config.authOidcIssuer || process.env.AUTH_OIDC_ISSUER,
    AUTH_OIDC_CLIENT_ID: config.authOidcClientId || process.env.AUTH_OIDC_CLIENT_ID,
    AUTH_OIDC_CLIENT_SECRET: config.authOidcClientSecret || process.env.AUTH_OIDC_CLIENT_SECRET,
    AUTH_OIDC_REDIRECT_URI: config.authOidcRedirectUri || process.env.AUTH_OIDC_REDIRECT_URI,
    AUTH_OIDC_SCOPES: config.authOidcScopes,
    AUTH_OIDC_POST_LOGOUT_REDIRECT_URI: config.authOidcPostLogoutRedirectUri || undefined,
    AUTH_ROLES_CLAIM: config.authRolesClaim,
    AUTH_SUBJECT_CLAIM: config.authSubjectClaim,
  });
  return _oidcConfig;
}

export function useOidc(): OidcClient {
  if (!_oidc) _oidc = new OidcClient(useOidcConfig());
  return _oidc;
}

export async function useDirectory(): Promise<DirectorySource | null> {
  if (_directory !== undefined) return _directory;
  _directory = await createDirectorySource(directoryConfigFromEnv(process.env));
  return _directory;
}

/** Maps IdP group names onto the three application roles. */
export function useRoleMap(): Record<string, Role> {
  try {
    return JSON.parse(useRuntimeConfig().authRoleMap || '{}') as Record<string, Role>;
  } catch {
    // A malformed map must not take the whole app down at login; everyone falls back to viewer,
    // which is the safe direction to fail in.
    console.warn('AUTH_ROLE_MAP is not valid JSON — every user will fall back to viewer');
    return {};
  }
}

export const SESSION_COOKIE = 'raci_session';

export interface SessionContext {
  readonly userId: string;
  readonly organizationId: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly role: Role;
  readonly sessionId: string;
}

/**
 * Resolve the caller, or null when there is no valid session.
 *
 * Read fresh from the database on every request rather than trusted from the cookie, which is what
 * makes revocation immediate: an administrator ending a session takes effect on the very next
 * request, not whenever a token happens to expire.
 */
export async function getSession(event: H3Event): Promise<SessionContext | null> {
  const token = getCookie(event, SESSION_COOKIE);
  if (!token) return null;

  const { hashToken } = await import('@raci/auth');
  const row = await resolveSession(useDb(), await hashToken(token));
  if (!row) return null;

  return {
    userId: row.user.id,
    organizationId: row.user.organizationId,
    displayName: row.user.displayName,
    email: row.user.email,
    role: (row.role ?? 'viewer') as Role,
    sessionId: row.session.id,
  };
}

/** The session, or a 401. Use in any handler that must not run for an anonymous caller. */
export async function requireSession(event: H3Event): Promise<SessionContext> {
  const session = await getSession(event);
  if (!session) throw createError({ statusCode: 401, statusMessage: 'Not signed in' });
  return session;
}

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

/** The session, or a 403 when the caller's role is below `minimum`. */
export async function requireRole(event: H3Event, minimum: Role): Promise<SessionContext> {
  const session = await requireSession(event);
  if (RANK[session.role] < RANK[minimum]) {
    throw createError({
      statusCode: 403,
      statusMessage: `This needs the ${minimum} role; you have ${session.role}.`,
    });
  }
  return session;
}
