import {
  createControlPlane,
  InMemoryControlPlaneStore,
  ResendEmailAdapter,
  StripeWebhookHandler,
  UsageTracker,
  type ControlPlane,
  type EmailAdapter,
  type Tier,
} from '@veritrail/control-plane';
import { InMemoryAnchorStore } from '@veritrail/core';

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

const port = Number(process.env['PORT'] ?? process.env['VERITRAIL_PORT'] ?? 8787);
const host = process.env['HOST'] ?? process.env['VERITRAIL_HOST'] ?? '0.0.0.0';

const options: BuildServerOptions = { logger: true };
// Accept both VERITRAIL_LEDGER_FILE (original) and VERITRAIL_LEDGER_PATH (used
// by the Docker/Kubernetes manifests). Preferring one canonical name silently
// dropped the other, which sent the ledger to the in-memory fallback in
// production and lost data on restart.
const ledgerFile = process.env['VERITRAIL_LEDGER_FILE'] ?? process.env['VERITRAIL_LEDGER_PATH'];
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

const consoleUrl = process.env['VERITRAIL_CONSOLE_URL'] ?? 'http://localhost:5173';

const controlPlaneEnabled = process.env['VERITRAIL_CONTROL_PLANE'] === '1';
let controlPlane: ControlPlane | undefined;
if (controlPlaneEnabled) {
  const store = new InMemoryControlPlaneStore();
  controlPlane = createControlPlane({ store });
  const usage = new UsageTracker({ flush: async () => {} });
  usage.start();
  let email: EmailAdapter | undefined;
  if (process.env['RESEND_API_KEY']) {
    email = new ResendEmailAdapter({
      apiKey: process.env['RESEND_API_KEY']!,
      from: process.env['RESEND_FROM_EMAIL'] ?? 'noreply@veritrail.io',
    });
  }
  const stripeSecret = process.env['STRIPE_WEBHOOK_SECRET'];
  const stripe = stripeSecret
    ? new StripeWebhookHandler({
        store,
        signingSecret: stripeSecret,
        priceIdToTier: parsePriceMap(process.env['STRIPE_PRICE_IDS'] ?? ''),
      })
    : undefined;
  options.controlPlane = {
    controlPlane,
    usage,
    ...(email !== undefined ? { email } : {}),
    ...(stripe !== undefined ? { stripe } : {}),
    consoleUrl,
    ...(boolEnv('VERITRAIL_ALLOW_INSECURE_DEV_MAGIC_LINKS', false)
      ? { allowInsecureDevMagicLinks: true }
      : {}),
  };
}

options.extensions = extensionsFromEnv(controlPlane);

/**
 * Assemble the opt-in extension surface the console depends on. The
 * ledger-backed read views (compliance, simulator, cost optimizer, agent
 * reputation) and cryptographic receipts are ON by default so every console
 * navigation item resolves against a real deployment; each can be turned off
 * with its `VERITRAIL_*=0` flag. Webhooks and billing are wired only when the
 * control plane is enabled, since both resolve tenant sessions through it.
 * AI RCA and the risk network stay off until their credentials/salt are set.
 */
function extensionsFromEnv(
  cp: ControlPlane | undefined,
): NonNullable<BuildServerOptions['extensions']> {
  const riskNetworkSalt = process.env['VERITRAIL_RISK_NETWORK_SALT'];
  const anthropicApiKey =
    process.env['VERITRAIL_ANTHROPIC_API_KEY'] ?? process.env['ANTHROPIC_API_KEY'];
  const rcaModel = process.env['VERITRAIL_RCA_MODEL'];
  const stripeSecretKey = process.env['STRIPE_SECRET_KEY'];
  const priceIdForTier = tierToPriceId(process.env['STRIPE_PRICE_IDS'] ?? '');
  return {
    ...(boolEnv('VERITRAIL_COMPLIANCE', true) ? { complianceEnabled: true } : {}),
    ...(boolEnv('VERITRAIL_SIMULATOR', true) ? { simulatorEnabled: true } : {}),
    ...(boolEnv('VERITRAIL_COST_OPTIMIZER', true) ? { costOptimizerEnabled: true } : {}),
    ...(boolEnv('VERITRAIL_AGENT_REPUTATION', true) ? { reputationEnabled: true } : {}),
    ...(boolEnv('VERITRAIL_RECEIPTS', true) ? { anchorStore: new InMemoryAnchorStore() } : {}),
    ...(riskNetworkSalt ? { riskNetworkSalt } : {}),
    // Always register the RCA route. Without a key it returns a graceful 503
    // ("AI backend not configured") that the console handles, rather than a
    // 404 that would surface as an opaque error in the Incident RCA view.
    autoRca: {
      ...(anthropicApiKey ? { anthropicApiKey } : {}),
      ...(rcaModel ? { model: rcaModel } : {}),
    },
    ...(cp ? { webhooks: { controlPlane: cp } } : {}),
    ...(cp
      ? {
          billing: {
            controlPlane: cp,
            ...(stripeSecretKey ? { stripeSecretKey } : {}),
            priceIdForTier,
            successUrl: `${consoleUrl}/#/billing?checkout=success`,
            cancelUrl: `${consoleUrl}/#/billing?checkout=cancel`,
          },
        }
      : {}),
  };
}

/**
 * Read a boolean feature flag. Unset/empty falls back to `defaultValue`;
 * `1`/`true` enable, anything else disables.
 */
function boolEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  return raw === '1' || raw.toLowerCase() === 'true';
}

/**
 * Build a `tier → Stripe price id` resolver from the same
 * `starter=price_abc,pro=price_def` string the webhook handler consumes.
 * Returns `null` for unmapped tiers so the checkout route can 400 cleanly.
 */
function tierToPriceId(raw: string): (tier: string) => string | null {
  const map: Record<string, string> = {};
  for (const entry of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [tier, priceId] = entry.split('=');
    if (tier && priceId) map[tier] = priceId;
  }
  return (tier: string) => map[tier] ?? null;
}

function parsePriceMap(raw: string): Readonly<Record<string, Tier>> {
  // Format: "starter=price_abc,pro=price_def,enterprise=price_xyz"
  // The control plane indexes by price-id → tier, so we invert here.
  const out: Record<string, Tier> = {};
  for (const entry of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [tier, priceId] = entry.split('=');
    if (!tier || !priceId) continue;
    if (tier === 'starter' || tier === 'pro' || tier === 'enterprise' || tier === 'free') {
      out[priceId] = tier;
    }
  }
  return out;
}

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
  const jwksUrl = process.env['VERITRAIL_OIDC_JWKS_URL'];
  const discoveryUrl = process.env['VERITRAIL_OIDC_DISCOVERY_URL'];
  if (!issuer && audience.length === 0 && !jwksRaw && !jwksUrl && !discoveryUrl) return undefined;
  if (!issuer || audience.length === 0 || (!jwksRaw && !jwksUrl && !discoveryUrl)) {
    throw new Error(
      'VERITRAIL_OIDC_ISSUER, VERITRAIL_OIDC_AUDIENCE, and one of VERITRAIL_OIDC_JWKS, VERITRAIL_OIDC_JWKS_URL, or VERITRAIL_OIDC_DISCOVERY_URL are required together',
    );
  }
  const parsedJwks =
    jwksRaw === undefined ? undefined : (JSON.parse(jwksRaw) as OidcAuthConfig['jwks']);
  const actorIdClaim = process.env['VERITRAIL_OIDC_ACTOR_CLAIM'];
  const rolesClaim = process.env['VERITRAIL_OIDC_ROLES_CLAIM'];
  const scopesClaim = process.env['VERITRAIL_OIDC_SCOPES_CLAIM'];
  const labelScopeClaim = process.env['VERITRAIL_OIDC_LABEL_SCOPE_CLAIM'];
  const defaultRoles = rolesFromEnv(process.env['VERITRAIL_OIDC_DEFAULT_ROLES']);
  const defaultScopes = scopesFromEnv(process.env['VERITRAIL_OIDC_DEFAULT_SCOPES']);
  const roleMappings = mappingFromEnv(process.env['VERITRAIL_OIDC_ROLE_MAPPINGS'], parseRole);
  const scopeMappings = mappingFromEnv(process.env['VERITRAIL_OIDC_SCOPE_MAPPINGS'], parseScope);
  const clockSkewSeconds = parseNonNegativeInt(process.env['VERITRAIL_OIDC_CLOCK_SKEW_SECONDS']);
  const jwksCacheTtlMs = parseNonNegativeInt(process.env['VERITRAIL_OIDC_JWKS_CACHE_TTL_MS']);
  return {
    issuer,
    audience: audience.length === 1 ? audience[0]! : audience,
    ...(parsedJwks !== undefined ? { jwks: parsedJwks } : {}),
    ...(jwksUrl !== undefined && jwksUrl.length > 0 ? { jwksUrl } : {}),
    ...(discoveryUrl !== undefined && discoveryUrl.length > 0 ? { discoveryUrl } : {}),
    ...(jwksCacheTtlMs !== undefined ? { jwksCacheTtlMs } : {}),
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
