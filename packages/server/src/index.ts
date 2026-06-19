/**
 * `@veritrail/server` — a Fastify REST API that mounts all eight governance
 * engines over one ledger. Use {@link buildServer} to construct an instance (for
 * embedding or tests) or run `veritrail-server` to start it.
 */
export { buildServer, type BuildServerOptions } from './app.js';
export {
  ApiKeyAuthenticator,
  ServerRoleSchema,
  ServerScopeSchema,
  adminActionSignatureDetails,
  parseApiKeyEntries,
  parseAuthHeader,
  signAdminAction,
  type AdminActionSignatureReceipt,
  type AdminActionSigningConfig,
  type ApiKeyConfig,
  type ApiKeyPrincipal,
  type AuthConfig,
  type OidcAuthConfig,
  type OidcJwks,
  type RouteAccess,
  type ServerRole,
  type ServerScope,
} from './auth.js';
export {
  DEFAULT_BODY_LIMIT_BYTES,
  DEFAULT_MAX_IN_FLIGHT_WRITES,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  normalizeLimits,
  type RateLimitConfig,
  type ServerLimitsConfig,
} from './limits.js';
export {
  createPlatform,
  developmentLogger,
  type Platform,
  type PlatformOptions,
} from './platform.js';
