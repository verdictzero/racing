import { describe, it, expect, beforeAll } from 'vitest';
import { AuthError, hashToken, randomToken, s256 } from './oidc.js';
import { mapRoles, readClaimPath, verifyIdToken } from './verify.js';

/**
 * These tests mint real tokens with real keys and then attack them.
 *
 * A verifier is only worth what its NEGATIVE tests prove: anyone can write one that accepts a
 * valid token. What matters is that it rejects the token signed with the wrong key, the one for
 * another audience, the one with `alg` swapped to none, and the one replayed from a different
 * login attempt.
 */

const ISSUER = 'https://idp.example.mil/realms/raci';
const AUDIENCE = 'raci-web';

let keyPair: CryptoKeyPair;
let otherKeyPair: CryptoKeyPair;
let jwks: JsonWebKey[];

function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const encodeJson = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

async function mintToken(
  claims: Record<string, unknown>,
  opts: { key?: CryptoKey; header?: Record<string, unknown> } = {},
): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT', kid: 'test-key', ...opts.header };
  const body = `${encodeJson(header)}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    opts.key ?? keyPair.privateKey,
    new TextEncoder().encode(body),
  );
  return `${body}.${b64url(new Uint8Array(signature))}`;
}

function validClaims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'subject-abc-123',
    exp: now + 3600,
    iat: now,
    nonce: 'the-nonce',
    email: 'dana.whitfield@asic.army.mil',
    name: 'Dana Whitfield',
    realm_access: { roles: ['raci-editor', 'offline_access'] },
    ...overrides,
  };
}

beforeAll(async () => {
  const params = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
  keyPair = await crypto.subtle.generateKey(params, true, ['sign', 'verify']);
  otherKeyPair = await crypto.subtle.generateKey(params, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  jwks = [{ ...jwk, kid: 'test-key', use: 'sig', alg: 'RS256' } as JsonWebKey];
}, 30_000);

const base = () => ({ keys: jwks, issuer: ISSUER, audience: AUDIENCE, nonce: 'the-nonce' });

describe('a valid token', () => {
  it('verifies and returns its claims', async () => {
    const result = await verifyIdToken({ idToken: await mintToken(validClaims()), ...base() });
    expect(result.subject).toBe('subject-abc-123');
    expect(result.email).toBe('dana.whitfield@asic.army.mil');
    expect(result.displayName).toBe('Dana Whitfield');
    expect(result.roles).toEqual(['raci-editor', 'offline_access']);
  });

  it('tolerates a trailing slash difference in the issuer, as EntraID produces', async () => {
    const token = await mintToken(validClaims({ iss: `${ISSUER}/` }));
    await expect(verifyIdToken({ idToken: token, ...base() })).resolves.toBeDefined();
  });

  it('accepts an audience array containing the client id', async () => {
    const token = await mintToken(validClaims({ aud: ['some-other-app', AUDIENCE] }));
    await expect(verifyIdToken({ idToken: token, ...base() })).resolves.toBeDefined();
  });

  it('reads a role claim at a different path', async () => {
    const token = await mintToken(
      validClaims({ realm_access: undefined, roles: ['App.Admin'] }),
    );
    const result = await verifyIdToken({ idToken: token, ...base(), rolesClaim: 'roles' });
    expect(result.roles).toEqual(['App.Admin']);
  });
});

describe('forged and mismatched tokens are rejected', () => {
  it('rejects a token signed with a different key', async () => {
    const token = await mintToken(validClaims(), { key: otherKeyPair.privateKey });
    await expect(verifyIdToken({ idToken: token, ...base() })).rejects.toThrow(/signature/);
  });

  it('rejects alg:none outright', async () => {
    // The classic attack: strip the signature and tell the verifier not to check one.
    const header = encodeJson({ alg: 'none', typ: 'JWT' });
    const payload = encodeJson(validClaims());
    await expect(
      verifyIdToken({ idToken: `${header}.${payload}.`, ...base() }),
    ).rejects.toThrow(/unsupported or unsafe/);
  });

  it('rejects an HMAC algorithm, which is the public-key-as-secret attack', async () => {
    const header = encodeJson({ alg: 'HS256', typ: 'JWT', kid: 'test-key' });
    const payload = encodeJson(validClaims());
    await expect(
      verifyIdToken({ idToken: `${header}.${payload}.c2lnbmF0dXJl`, ...base() }),
    ).rejects.toThrow(/unsupported or unsafe/);
  });

  it('rejects a token from another issuer', async () => {
    const token = await mintToken(validClaims({ iss: 'https://evil.example/realms/raci' }));
    await expect(verifyIdToken({ idToken: token, ...base() })).rejects.toThrow(/issuer mismatch/);
  });

  it('rejects a token minted for another application', async () => {
    const token = await mintToken(validClaims({ aud: 'a-different-app' }));
    await expect(verifyIdToken({ idToken: token, ...base() })).rejects.toThrow(/audience mismatch/);
  });

  it('rejects an expired token', async () => {
    const token = await mintToken(validClaims({ exp: Math.floor(Date.now() / 1000) - 7200 }));
    await expect(verifyIdToken({ idToken: token, ...base() })).rejects.toThrow(/expired/);
  });

  it('rejects a token that is not yet valid', async () => {
    const token = await mintToken(validClaims({ nbf: Math.floor(Date.now() / 1000) + 7200 }));
    await expect(verifyIdToken({ idToken: token, ...base() })).rejects.toThrow(/not yet valid/);
  });

  it('rejects a token from a different login attempt', async () => {
    const token = await mintToken(validClaims({ nonce: 'someone-elses-nonce' }));
    await expect(verifyIdToken({ idToken: token, ...base() })).rejects.toThrow(/nonce mismatch/);
  });

  it('rejects a token with no subject', async () => {
    const token = await mintToken(validClaims({ sub: undefined }));
    await expect(verifyIdToken({ idToken: token, ...base() })).rejects.toThrow(AuthError);
  });

  it('rejects a token whose kid names no known key', async () => {
    const token = await mintToken(validClaims(), { header: { kid: 'rotated-away' } });
    await expect(verifyIdToken({ idToken: token, ...base() })).rejects.toThrow(/no signing key/);
  });

  it('rejects a malformed token', async () => {
    await expect(verifyIdToken({ idToken: 'not-a-jwt', ...base() })).rejects.toThrow(/malformed/);
    await expect(verifyIdToken({ idToken: 'a.b.c', ...base() })).rejects.toThrow();
  });

  it('rejects a tampered payload', async () => {
    const token = await mintToken(validClaims());
    const [header, , signature] = token.split('.');
    const forged = encodeJson(validClaims({ sub: 'somebody-else' }));
    await expect(
      verifyIdToken({ idToken: `${header}.${forged}.${signature}`, ...base() }),
    ).rejects.toThrow(/signature/);
  });
});

describe('clock skew', () => {
  it('accepts a token that expired within tolerance', async () => {
    const token = await mintToken(validClaims({ exp: Math.floor(Date.now() / 1000) - 30 }));
    await expect(
      verifyIdToken({ idToken: token, ...base(), clockToleranceSeconds: 120 }),
    ).resolves.toBeDefined();
  });
});

describe('role mapping', () => {
  const mapping = { 'raci-admins': 'admin', 'raci-editors': 'editor' } as const;

  it('maps an IdP group to an application role', () => {
    expect(mapRoles(['raci-editors'], mapping)).toBe('editor');
  });

  it('takes the highest when someone is in several groups', () => {
    expect(mapRoles(['raci-editors', 'raci-admins'], mapping)).toBe('admin');
    expect(mapRoles(['raci-admins', 'raci-editors'], mapping)).toBe('admin');
  });

  it('falls back for an unmapped group', () => {
    expect(mapRoles(['some-unrelated-group'], mapping)).toBe('viewer');
    expect(mapRoles([], mapping, null)).toBeNull();
  });
});

describe('claim paths', () => {
  it('reads a nested path', () => {
    expect(readClaimPath({ realm_access: { roles: ['a'] } }, 'realm_access.roles')).toEqual(['a']);
  });
  it('returns undefined rather than throwing on a missing path', () => {
    expect(readClaimPath({}, 'a.b.c')).toBeUndefined();
    expect(readClaimPath({ a: 'string' }, 'a.b')).toBeUndefined();
  });
});

describe('crypto helpers', () => {
  it('produces a PKCE challenge that matches the RFC 7636 test vector', async () => {
    // The example verifier and challenge from the specification itself.
    expect(await s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('mints URL-safe tokens with no padding', () => {
    const token = randomToken(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(randomToken(32)).not.toBe(token);
  });

  it('hashes a session token to stable hex', async () => {
    const hash = await hashToken('some-session-token');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashToken('some-session-token')).toBe(hash);
    expect(await hashToken('a-different-token')).not.toBe(hash);
  });
});
