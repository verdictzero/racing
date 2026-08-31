/**
 * @raci/auth — IdP-agnostic OpenID Connect.
 *
 * Discovery-driven, so Keycloak and EntraID are the same code with a different issuer URL.
 * verify.ts is the security boundary of the application; read the note at the top of it before
 * changing anything in there.
 */

export * from './oidc.js';
export * from './verify.js';
