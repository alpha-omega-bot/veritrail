import { buildServer, type BuildServerOptions } from './app.js';
import {
  parseApiKeyEntries,
  ServerRoleSchema,
  ServerScopeSchema,
  type AdminActionSigningConfig,
  type OidcAuthConfig,
  type ServerRole,
  type ServerScope,
} from './auth.js';
import {
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  type ServerLimitsConfig,
} from './limits.js';

const port = Number(process.env['PORT'] ?? 8787);
const host = process.env['HOST'] ?? '0.0.0.0';

const options: BuildServerOptions = { logger: true };
const ledgerFile = process.env['VERITRAIL_LEDGER_FILE'];
if (ledgerFile) options.ledgerFile = ledgerFile;
const signerSecret = process.env['VERITRAIL_SIGNER_SECRET'];
if (signerSecret) options.signerSecret = signerSecret;
const apiKeys = parseApiKeyEntries(process.env['VERITRAIL_API_KEYS']);
const oidc = oidcFromEnv();
const adminActionSigning = adminActionSigningFromEnv();
if (apiKeys.length > 0 || oidc !== undefined) {
  options.auth = {
    ...(apiKeys.length > 0 ? { apiKeys } : {}),
    ...(oidc !== undefined ? { oidc } : {}),
    ...(adminActionSigning !== undefined ? { adminActionSigning } : {}),
  };
} else if (adminActionSigning !== undefined) {
  throw new Error('VERITRAIL_ADMIN_ACTION_SIGNING_SECRET requires server auth credentials');
}
options.limits = limitsFromEnv();

const app = await buildServer(options);

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

function limitsFromEnv(): ServerLimitsConfig {
  const bodyLimitBytes = parsePositiveInt(process.env['VERITRAIL_BODY_LIMIT_BYTES']);
  const rateLimit = rateLimitFromEnv();
  const maxInFlightWrites = maxInFlightWritesFromEnv();
  return {
    ...(bodyLimitBytes !== undefined ? { bodyLimitBytes } : {}),
    ...(rateLimit !== undefined ? { rateLimit } : {}),
    ...(maxInFlightWrites !== undefined ? { maxInFlightWrites } : {}),
  };
}

function adminActionSigningFromEnv(): AdminActionSigningConfig | undefined {
  const secret = process.env['VERITRAIL_ADMIN_ACTION_SIGNING_SECRET'];
  if (!secret) return undefined;
  const keyId = process.env['VERITRAIL_ADMIN_ACTION_SIGNING_KEY_ID'];
  const maxSkewMs = parsePositiveInt(process.env['VERITRAIL_ADMIN_ACTION_SIGNING_MAX_SKEW_MS']);
  return {
    secret,
    ...(keyId !== undefined && keyId.length > 0 ? { keyId } : {}),
    ...(maxSkewMs !== undefined ? { maxSkewMs } : {}),
  };
}

function oidcFromEnv(): OidcAuthConfig | undefined {
  const issuer = process.env['VERITRAIL_OIDC_ISSUER'];
  const audience = csvFromEnv(process.env['VERITRAIL_OIDC_AUDIENCE']);
  const jwksRaw = process.env['VERITRAIL_OIDC_JWKS'];
  if (!issuer && audience.length === 0 && !jwksRaw) return undefined;
  if (!issuer || audience.length === 0 || !jwksRaw) {
    throw new Error(
      'VERITRAIL_OIDC_ISSUER, VERITRAIL_OIDC_AUDIENCE, and VERITRAIL_OIDC_JWKS are required together',
    );
  }
  const parsedJwks = JSON.parse(jwksRaw) as OidcAuthConfig['jwks'];
  const actorIdClaim = process.env['VERITRAIL_OIDC_ACTOR_CLAIM'];
  const rolesClaim = process.env['VERITRAIL_OIDC_ROLES_CLAIM'];
  const scopesClaim = process.env['VERITRAIL_OIDC_SCOPES_CLAIM'];
  const labelScopeClaim = process.env['VERITRAIL_OIDC_LABEL_SCOPE_CLAIM'];
  const defaultRoles = rolesFromEnv(process.env['VERITRAIL_OIDC_DEFAULT_ROLES']);
  const defaultScopes = scopesFromEnv(process.env['VERITRAIL_OIDC_DEFAULT_SCOPES']);
  const roleMappings = mappingFromEnv(process.env['VERITRAIL_OIDC_ROLE_MAPPINGS'], parseRole);
  const scopeMappings = mappingFromEnv(process.env['VERITRAIL_OIDC_SCOPE_MAPPINGS'], parseScope);
  const clockSkewSeconds = parseNonNegativeInt(process.env['VERITRAIL_OIDC_CLOCK_SKEW_SECONDS']);
  return {
    issuer,
    audience: audience.length === 1 ? audience[0]! : audience,
    jwks: parsedJwks,
    ...(actorIdClaim !== undefined && actorIdClaim.length > 0 ? { actorIdClaim } : {}),
    ...(rolesClaim !== undefined && rolesClaim.length > 0 ? { rolesClaim } : {}),
    ...(scopesClaim !== undefined && scopesClaim.length > 0 ? { scopesClaim } : {}),
    ...(labelScopeClaim !== undefined && labelScopeClaim.length > 0 ? { labelScopeClaim } : {}),
    ...(defaultRoles !== undefined ? { defaultRoles } : {}),
    ...(defaultScopes !== undefined ? { defaultScopes } : {}),
    ...(roleMappings !== undefined ? { roleMappings } : {}),
    ...(scopeMappings !== undefined ? { scopeMappings } : {}),
    ...(clockSkewSeconds !== undefined ? { clockSkewSeconds } : {}),
  };
}

function rolesFromEnv(raw: string | undefined): ServerRole[] | undefined {
  const roles = csvFromEnv(raw);
  if (roles.length === 0) return undefined;
  return roles.map(parseRole);
}

function scopesFromEnv(raw: string | undefined): ServerScope[] | undefined {
  const scopes = csvFromEnv(raw);
  if (scopes.length === 0) return undefined;
  return scopes.map(parseScope);
}

function mappingFromEnv<T extends string>(
  raw: string | undefined,
  parseValue: (value: string) => T,
): Record<string, T> | undefined {
  if (!raw) return undefined;
  const entries = csvFromEnv(raw).map((token) => {
    const separator = token.indexOf('=');
    if (separator <= 0 || separator === token.length - 1) {
      throw new Error('OIDC mappings must be comma-separated external=veritrail pairs');
    }
    return [token.slice(0, separator), parseValue(token.slice(separator + 1))] as const;
  });
  return Object.fromEntries(entries);
}

function parseRole(value: string): ServerRole {
  return ServerRoleSchema.parse(value);
}

function parseScope(value: string): ServerScope {
  return ServerScopeSchema.parse(value);
}

function csvFromEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function rateLimitFromEnv(): ServerLimitsConfig['rateLimit'] | undefined {
  const maxRaw = process.env['VERITRAIL_RATE_LIMIT_MAX'];
  if (maxRaw === '0') return false;
  const max = parsePositiveInt(maxRaw);
  const windowMs = parsePositiveInt(process.env['VERITRAIL_RATE_LIMIT_WINDOW_MS']);
  if (max === undefined && windowMs === undefined) return undefined;
  return {
    max: max ?? DEFAULT_RATE_LIMIT_MAX,
    windowMs: windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
  };
}

function maxInFlightWritesFromEnv(): ServerLimitsConfig['maxInFlightWrites'] | undefined {
  const raw = process.env['VERITRAIL_MAX_IN_FLIGHT_WRITES'];
  if (raw === '0') return false;
  return parsePositiveInt(raw);
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function parseNonNegativeInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
