/**
 * ID token verification.
 *
 * The security boundary of the whole application. Everything downstream — who you are, which
 * organization you are in, what you may edit — rests on this function having actually checked what
 * it claims to check.
 *
 * Written against WebCrypto rather than a JWT library, for two reasons. It is auditable in one
 * sitting, which matters more here than anywhere else in the codebase; and it is one fewer package
 * to vendor and keep patched in an air-gapped deployment, where "just upgrade the dependency" is a
 * change-controlled event rather than a command.
 *
 * ONLY ASYMMETRIC ALGORITHMS ARE ACCEPTED. `alg: none` and the HMAC family are rejected outright,
 * before anything else happens. The classic JWT vulnerability is a verifier that trusts the header
 * to say which algorithm to use, letting an attacker sign with the PUBLIC key as an HMAC secret
 * and be believed. The allow-list below is what makes that unrepresentable.
 */

import { AuthError } from './oidc.js';

export interface VerifiedIdToken {
  readonly subject: string;
  readonly email: string | null;
  readonly displayName: string;
  readonly roles: string[];
  readonly issuer: string;
  readonly audience: string;
  readonly expiresAt: Date;
  readonly claims: Record<string, unknown>;
}

export interface VerifyOptions {
  readonly idToken: string;
  readonly keys: JsonWebKey[];
  readonly issuer: string;
  readonly audience: string;
  /** The nonce this browser's login attempt started with. */
  readonly nonce?: string;
  readonly rolesClaim?: string;
  readonly subjectClaim?: string;
  /** Tolerance for clock skew between this host and the IdP. */
  readonly clockToleranceSeconds?: number;
  /** Injectable for tests. */
  readonly now?: Date;
}

/** Asymmetric signatures only — see the note at the top of the file. */
const ALGORITHMS: Record<string, { name: string; hash: string; namedCurve?: string }> = {
  RS256: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
  RS384: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
  RS512: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
  PS256: { name: 'RSA-PSS', hash: 'SHA-256' },
  PS384: { name: 'RSA-PSS', hash: 'SHA-384' },
  PS512: { name: 'RSA-PSS', hash: 'SHA-512' },
  ES256: { name: 'ECDSA', hash: 'SHA-256', namedCurve: 'P-256' },
  ES384: { name: 'ECDSA', hash: 'SHA-384', namedCurve: 'P-384' },
};

/**
 * Backed by an explicit ArrayBuffer rather than the default.
 *
 * WebCrypto's BufferSource excludes SharedArrayBuffer-backed views, and a plain `new Uint8Array(n)`
 * widens to ArrayBufferLike under TypeScript 5.7 — so allocating the buffer by hand is what lets
 * the result be handed straight to subtle.verify without a cast that would hide a real mismatch.
 */
function decodeBase64Url(input: string): Uint8Array<ArrayBuffer> {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function decodeJsonSegment(segment: string): Record<string, unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(segment)));
  } catch {
    throw new AuthError('token segment is not valid JSON', 'invalid_token');
  }
}

/** Read a dotted path out of the claims, e.g. `realm_access.roles`. */
export function readClaimPath(claims: Record<string, unknown>, path: string): unknown {
  let current: unknown = claims;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Verify an ID token and return what it says.
 *
 * Every check is mandatory. There is no options flag that turns one off, because the one that
 * would get switched on in a hurry to unblock a demo is exactly the one that matters.
 */
export async function verifyIdToken(opts: VerifyOptions): Promise<VerifiedIdToken> {
  const parts = opts.idToken.split('.');
  if (parts.length !== 3) throw new AuthError('malformed JWT', 'invalid_token');
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = decodeJsonSegment(headerB64);
  const alg = typeof header.alg === 'string' ? header.alg : '';
  const spec = ALGORITHMS[alg];
  if (!spec) {
    // Rejected BEFORE the key is chosen. A verifier that lets the token pick its own algorithm can
    // be handed alg:none, or an HMAC signed with the public key it was about to verify against.
    throw new AuthError(`unsupported or unsafe JWT algorithm: ${alg || '(none)'}`, 'invalid_token');
  }

  const kid = typeof header.kid === 'string' ? header.kid : null;
  const candidates = opts.keys.filter((k) => {
    const jwk = k as JsonWebKey & { kid?: string; alg?: string; use?: string };
    if (jwk.use && jwk.use !== 'sig') return false;
    if (kid && jwk.kid && jwk.kid !== kid) return false;
    return true;
  });
  if (candidates.length === 0) {
    throw new AuthError(`no signing key matches kid=${kid ?? '(unset)'}`, 'invalid_token');
  }

  const signature = decodeBase64Url(signatureB64);
  const signedBytes = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

  let signatureValid = false;
  for (const jwk of candidates) {
    try {
      const key = await globalThis.crypto.subtle.importKey(
        'jwk',
        jwk,
        spec.namedCurve
          ? { name: spec.name, namedCurve: spec.namedCurve }
          : { name: spec.name, hash: spec.hash },
        false,
        ['verify'],
      );
      const verifyParams =
        spec.name === 'ECDSA'
          ? { name: 'ECDSA', hash: spec.hash }
          : spec.name === 'RSA-PSS'
            ? { name: 'RSA-PSS', saltLength: Number(spec.hash.slice(-3)) / 8 }
            : { name: spec.name };
      if (await globalThis.crypto.subtle.verify(verifyParams, key, signature, signedBytes)) {
        signatureValid = true;
        break;
      }
    } catch {
      // A key that cannot be imported for this algorithm is simply not the right key. Keep going:
      // a JWKS legitimately carries keys for several algorithms and several rotations.
      continue;
    }
  }
  if (!signatureValid) throw new AuthError('token signature does not verify', 'invalid_token');

  const claims = decodeJsonSegment(payloadB64);
  const now = Math.floor((opts.now?.getTime() ?? Date.now()) / 1000);
  const skew = opts.clockToleranceSeconds ?? 60;

  // The issuer, so a token minted by a different tenant of the same IdP is not accepted.
  const issuer = typeof claims.iss === 'string' ? claims.iss : '';
  if (normalizeIssuer(issuer) !== normalizeIssuer(opts.issuer)) {
    throw new AuthError(`issuer mismatch: ${issuer} is not ${opts.issuer}`, 'invalid_token');
  }

  // The audience, so a token minted for a DIFFERENT application the same user also signs into
  // cannot be replayed here.
  const audience = claims.aud;
  const audiences = Array.isArray(audience) ? audience : [audience];
  if (!audiences.some((a) => a === opts.audience)) {
    throw new AuthError(`audience mismatch: ${JSON.stringify(audience)}`, 'invalid_token');
  }

  if (typeof claims.exp === 'number' && claims.exp + skew < now) {
    throw new AuthError('token has expired', 'invalid_token');
  }
  if (typeof claims.nbf === 'number' && claims.nbf - skew > now) {
    throw new AuthError('token is not yet valid', 'invalid_token');
  }

  // The nonce ties the token to the login attempt THIS browser started, so an attacker cannot
  // inject a token they obtained elsewhere into someone else's session.
  if (opts.nonce !== undefined) {
    if (claims.nonce !== opts.nonce) throw new AuthError('nonce mismatch', 'invalid_token');
  }

  const subjectClaim = opts.subjectClaim ?? 'sub';
  const subject = readClaimPath(claims, subjectClaim);
  if (typeof subject !== 'string' || subject.length === 0) {
    throw new AuthError(`token carries no "${subjectClaim}" claim`, 'no_subject');
  }

  const rolesRaw = readClaimPath(claims, opts.rolesClaim ?? 'realm_access.roles');
  const roles = Array.isArray(rolesRaw) ? rolesRaw.filter((r): r is string => typeof r === 'string') : [];

  const email =
    (typeof claims.email === 'string' && claims.email) ||
    (typeof claims.preferred_username === 'string' && claims.preferred_username.includes('@')
      ? claims.preferred_username
      : null) ||
    null;

  return {
    subject,
    email,
    displayName:
      (typeof claims.name === 'string' && claims.name) ||
      (typeof claims.preferred_username === 'string' && claims.preferred_username) ||
      email ||
      subject,
    roles,
    issuer,
    audience: opts.audience,
    expiresAt: new Date((typeof claims.exp === 'number' ? claims.exp : now) * 1000),
    claims,
  };
}

/**
 * Issuers are compared without a trailing slash.
 *
 * Not laxness: EntraID's discovery document and its token `iss` claim genuinely differ in this,
 * and a strict comparison rejects every valid Entra login. Everything else about the string still
 * has to match exactly.
 */
function normalizeIssuer(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Map IdP roles onto the application's three.
 *
 * Deliberately a mapping rather than a direct read: an IdP's role names belong to the
 * organization that runs it, and hard-coding "admin" would make this tool dictate naming in a
 * directory it does not own.
 */
export function mapRoles(
  idpRoles: string[],
  mapping: Record<string, 'viewer' | 'editor' | 'admin'>,
  fallback: 'viewer' | 'editor' | 'admin' | null = 'viewer',
): 'viewer' | 'editor' | 'admin' | null {
  const rank = { viewer: 0, editor: 1, admin: 2 } as const;
  let best: 'viewer' | 'editor' | 'admin' | null = null;
  for (const role of idpRoles) {
    const mapped = mapping[role];
    // Highest wins: somebody in both the editors and the admins group is an admin.
    if (mapped && (best === null || rank[mapped] > rank[best])) best = mapped;
  }
  return best ?? fallback;
}
