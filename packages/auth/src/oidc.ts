/**
 * OIDC, provider-agnostic.
 *
 * The app speaks plain OpenID Connect and discovers everything else from the issuer's
 * `.well-known/openid-configuration`. Keycloak and EntraID are then the same code with a different
 * `AUTH_OIDC_ISSUER` — which is what the "build it portable" deployment answer requires, and what
 * lets an on-prem install move to Entra later without a rewrite.
 *
 * WHAT IS DELIBERATELY NOT CONFIGURABLE
 * Authorization-code flow with PKCE, full stop. No implicit flow, no hybrid, no password grant.
 * They exist in the spec for browsers that no longer matter and they all leak tokens somewhere a
 * code + verifier does not. Offering the choice would only be offering a way to get it wrong.
 *
 * WHAT IS VERIFIED, AND WHY EACH ONE
 *   signature   the token came from the issuer's keys, not from whoever posted to the callback
 *   issuer      it came from OUR issuer, not another tenant of the same IdP
 *   audience    it was minted for THIS client, not for a different app the user also uses
 *   nonce       it belongs to the login attempt this browser started
 *   state       the callback belongs to a request we made, and is used exactly once
 *   expiry      it is current
 *
 * Skipping any of them turns "signed in" into "presented something that looked like a token".
 */

import { z } from 'zod';

export const OidcConfig = z.object({
  /** Discovery base, e.g. https://login.microsoftonline.com/<tenant>/v2.0 or a Keycloak realm. */
  issuer: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  redirectUri: z.string().url(),
  scopes: z.string().default('openid profile email'),
  postLogoutRedirectUri: z.string().url().optional(),
  /** Dotted path to the role claim: `realm_access.roles` (Keycloak) or `roles` (Entra). */
  rolesClaim: z.string().default('realm_access.roles'),
  /** Claim carrying the stable user id. Never the email. */
  subjectClaim: z.string().default('sub'),
  /** Extra CA bundle for an internal IdP with a private certificate. */
  tlsCaCertificate: z.string().optional(),
});
export type OidcConfig = z.infer<typeof OidcConfig>;

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'discovery_failed'
      | 'state_mismatch'
      | 'token_exchange_failed'
      | 'invalid_token'
      | 'no_subject',
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export function oidcConfigFromEnv(env: Record<string, string | undefined>): OidcConfig {
  const need = (key: string): string => {
    const value = env[key];
    if (!value) throw new AuthError(`${key} is required`, 'discovery_failed');
    return value;
  };
  return OidcConfig.parse({
    issuer: need('AUTH_OIDC_ISSUER'),
    clientId: need('AUTH_OIDC_CLIENT_ID'),
    clientSecret: need('AUTH_OIDC_CLIENT_SECRET'),
    redirectUri: need('AUTH_OIDC_REDIRECT_URI'),
    scopes: env.AUTH_OIDC_SCOPES || undefined,
    postLogoutRedirectUri: env.AUTH_OIDC_POST_LOGOUT_REDIRECT_URI || undefined,
    rolesClaim: env.AUTH_ROLES_CLAIM || undefined,
    subjectClaim: env.AUTH_SUBJECT_CLAIM || undefined,
  });
}

/** The subset of the discovery document this needs. */
export const DiscoveryDocument = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
  userinfo_endpoint: z.string().url().optional(),
  end_session_endpoint: z.string().url().optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
});
export type DiscoveryDocument = z.infer<typeof DiscoveryDocument>;

/**
 * Fetch and cache the discovery document.
 *
 * Cached because it is fetched on every login and changes about never; re-fetched hourly so a key
 * rotation is picked up without a restart.
 */
export class OidcClient {
  private discovery: { doc: DiscoveryDocument; fetchedAt: number } | null = null;
  private jwks: { keys: JsonWebKey[]; fetchedAt: number } | null = null;
  private static readonly TTL_MS = 60 * 60 * 1000;

  constructor(private readonly config: OidcConfig) {}

  async discover(): Promise<DiscoveryDocument> {
    if (this.discovery && Date.now() - this.discovery.fetchedAt < OidcClient.TTL_MS) {
      return this.discovery.doc;
    }
    const url = `${this.config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      throw new AuthError(`OIDC discovery failed at ${url} (${res.status})`, 'discovery_failed');
    }
    const doc = DiscoveryDocument.parse(await res.json());
    this.discovery = { doc, fetchedAt: Date.now() };
    return doc;
  }

  /** The issuer's signing keys, cached with the same TTL so a rotation is picked up. */
  async signingKeys(): Promise<JsonWebKey[]> {
    if (this.jwks && Date.now() - this.jwks.fetchedAt < OidcClient.TTL_MS) return this.jwks.keys;
    const { jwks_uri } = await this.discover();
    const res = await fetch(jwks_uri, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new AuthError(`JWKS fetch failed (${res.status})`, 'discovery_failed');
    const body = (await res.json()) as { keys?: JsonWebKey[] };
    const keys = body.keys ?? [];
    this.jwks = { keys, fetchedAt: Date.now() };
    return keys;
  }

  /**
   * Build the authorization URL, and the secrets that have to be remembered until the callback.
   *
   * The verifier and nonce go to the DATABASE rather than a cookie: a cookie would work, but the
   * server has to write an auth_request row anyway to make the state single-use, and keeping one
   * source of truth means a callback cannot be replayed by replaying a cookie.
   */
  async beginLogin(redirectTo = '/'): Promise<{
    url: string;
    state: string;
    codeVerifier: string;
    nonce: string;
    redirectTo: string;
  }> {
    const doc = await this.discover();
    const state = randomToken(32);
    const nonce = randomToken(32);
    const codeVerifier = randomToken(64);
    const codeChallenge = await s256(codeVerifier);

    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('scope', this.config.scopes);
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');

    return { url: url.toString(), state, codeVerifier, nonce, redirectTo };
  }

  /** Exchange the authorization code for tokens. */
  async exchangeCode(code: string, codeVerifier: string): Promise<TokenResponse> {
    const doc = await this.discover();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code_verifier: codeVerifier,
    });
    const res = await fetch(doc.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      // The IdP's body names the actual cause (redirect_uri mismatch, bad secret, expired code),
      // and losing it turns a five-minute fix into an afternoon of guessing.
      throw new AuthError(
        `token exchange failed (${res.status}): ${await res.text()}`,
        'token_exchange_failed',
      );
    }
    return TokenResponse.parse(await res.json());
  }

  /** RP-initiated logout, so signing out here also ends the session at the IdP. */
  async endSessionUrl(idTokenHint?: string | null): Promise<string | null> {
    const doc = await this.discover();
    if (!doc.end_session_endpoint) return null;
    const url = new URL(doc.end_session_endpoint);
    if (idTokenHint) url.searchParams.set('id_token_hint', idTokenHint);
    if (this.config.postLogoutRedirectUri) {
      url.searchParams.set('post_logout_redirect_uri', this.config.postLogoutRedirectUri);
    }
    url.searchParams.set('client_id', this.config.clientId);
    return url.toString();
  }
}

export const TokenResponse = z.object({
  access_token: z.string(),
  id_token: z.string(),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

// ---- crypto helpers ---------------------------------------------------------------------------

/** base64url, no padding — what OAuth expects everywhere. */
function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return base64url(buf);
}

/** PKCE S256 challenge. */
export async function s256(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return base64url(new Uint8Array(digest));
}

/**
 * Hash a session token before it is stored.
 *
 * The cookie holds the token; the database holds only this. A database leak then yields no usable
 * sessions, which is the same reason a password is never stored in the clear.
 */
export async function hashToken(token: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
