import {
  createHash,
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';

import {
  asJson,
  canonicalize,
  sha256Hex,
  validationError,
  type JsonValue,
  type VeritrailError,
} from '@veritrail/core';
import { z } from 'zod';

export const ServerRoleSchema = z.enum(['ingest', 'operator', 'admin']);
export type ServerRole = z.infer<typeof ServerRoleSchema>;

export const ServerScopeSchema = z.enum([
  'audit:read',
  'permissions:read',
  'spend:read',
  'decisions:read',
  'evidence:read',
  'vendor-risk:read',
  'forensics:read',
  'rollback:read',
  'rollback:execute',
]);
export type ServerScope = z.infer<typeof ServerScopeSchema>;

export interface ApiKeyPrincipal {
  readonly id: string;
  readonly actorId: string;
  readonly roles: readonly ServerRole[];
  /**
   * Optional route scopes that narrow a key after its role check succeeds.
   * Omitted scopes preserve the role-only behavior used by existing deployments.
   */
  readonly scopes?: readonly ServerScope[];
  /**
   * Optional exact event-label constraints for tenant/project scoping.
   * Scoped raw ledger reads are constrained to these labels, and scoped writes
   * must include them.
   */
  readonly labelScope?: Readonly<Record<string, string>>;
}

export interface ApiKeyConfig {
  readonly id: string;
  readonly actorId: string;
  readonly secret: string;
  readonly roles: readonly ServerRole[];
  /** Optional route scopes. When supplied, scoped routes require a matching value. */
  readonly scopes?: readonly ServerScope[];
  /** Optional exact event-label constraints for tenant/project scoping. */
  readonly labelScope?: Readonly<Record<string, string>>;
}

export interface OidcAuthConfig {
  /** Expected `iss` claim. */
  readonly issuer: string;
  /** Accepted `aud` claim values. */
  readonly audience: string | readonly string[];
  /** Static public JWKS. Dynamic discovery/refresh belongs in a provider adapter. */
  readonly jwks: OidcJwks;
  /** Claim used as the Veritrail actor id. Defaults to `sub`. */
  readonly actorIdClaim?: string;
  /** Claim containing Veritrail roles or external values mapped by `roleMappings`. */
  readonly rolesClaim?: string;
  /** Claim containing Veritrail route scopes or external values mapped by `scopeMappings`. */
  readonly scopesClaim?: string;
  /** Claim containing exact label-scope constraints as a string record. */
  readonly labelScopeClaim?: string;
  /** Roles added to every valid OIDC token. Keep empty unless the issuer is dedicated. */
  readonly defaultRoles?: readonly ServerRole[];
  /** Scopes added to every valid OIDC token. */
  readonly defaultScopes?: readonly ServerScope[];
  /** Optional mapping from IdP role/group values to Veritrail roles. */
  readonly roleMappings?: Readonly<Record<string, ServerRole>>;
  /** Optional mapping from IdP scope/group values to Veritrail route scopes. */
  readonly scopeMappings?: Readonly<Record<string, ServerScope>>;
  /** Allowed clock skew for time claims. Defaults to 60 seconds. */
  readonly clockSkewSeconds?: number;
}

export interface OidcJwks {
  readonly keys: readonly JsonWebKey[];
}

export interface RouteAccess {
  readonly roles: readonly ServerRole[];
  readonly scope?: ServerScope;
}

export interface AuthConfig {
  readonly apiKeys?: readonly ApiKeyConfig[];
  readonly oidc?: OidcAuthConfig;
  /**
   * Optional request-signature verification for administrative mutations.
   * When enabled, admin routes require `x-veritrail-admin-*` HMAC headers before
   * server-held configuration is changed.
   */
  readonly adminActionSigning?: AdminActionSigningConfig;
}

export interface AdminActionSigningConfig {
  readonly secret: string;
  readonly keyId?: string;
  readonly maxSkewMs?: number;
}

export type AuthFailureReason = 'missing' | 'invalid' | 'forbidden';

export interface AuthFailure {
  readonly reason: AuthFailureReason;
  readonly error: VeritrailError;
}

export type AuthResult =
  | { readonly ok: true; readonly principal: ApiKeyPrincipal }
  | { readonly ok: false; readonly failure: AuthFailure };

export interface AdminActionSignatureInput {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly timestamp: string | undefined;
  readonly nonce: string | undefined;
  readonly keyId: string | undefined;
  readonly signature: string | undefined;
  readonly now: number;
}

export type AdminActionSignatureResult =
  | { readonly ok: true; readonly receipt: AdminActionSignatureReceipt }
  | { readonly ok: false; readonly error: VeritrailError };

export interface AdminActionSignatureReceipt {
  readonly keyId: string;
  readonly timestamp: number;
  readonly nonce: string;
  readonly method: string;
  readonly path: string;
  readonly bodyHash: string;
  readonly algorithm: 'hmac-sha256';
}

const DEFAULT_ADMIN_ACTION_SIGNATURE_MAX_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_OIDC_CLOCK_SKEW_SECONDS = 60;
const OIDC_ALGORITHMS = ['RS256'] as const;
type OidcAlgorithm = (typeof OIDC_ALGORITHMS)[number];

const ApiKeyConfigSchema = z
  .object({
    id: z.string().min(1).max(256),
    actorId: z.string().min(1).max(256),
    secret: z.string().min(16),
    roles: z.array(ServerRoleSchema).min(1),
    scopes: z.array(ServerScopeSchema).optional(),
    labelScope: z.record(z.string().min(1), z.string()).optional(),
  })
  .strict();

const OidcJwkSchema = z.custom<JsonWebKey>((value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const jwk = value as Record<string, unknown>;
  return (
    typeof jwk['kty'] === 'string' &&
    (jwk['kid'] === undefined || typeof jwk['kid'] === 'string') &&
    (jwk['alg'] === undefined || typeof jwk['alg'] === 'string')
  );
});

const OidcAuthConfigSchema = z
  .object({
    issuer: z.string().url(),
    audience: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    jwks: z
      .object({
        keys: z.array(OidcJwkSchema).min(1),
      })
      .strict(),
    actorIdClaim: z.string().min(1).optional(),
    rolesClaim: z.string().min(1).optional(),
    scopesClaim: z.string().min(1).optional(),
    labelScopeClaim: z.string().min(1).optional(),
    defaultRoles: z.array(ServerRoleSchema).optional(),
    defaultScopes: z.array(ServerScopeSchema).optional(),
    roleMappings: z.record(z.string().min(1), ServerRoleSchema).optional(),
    scopeMappings: z.record(z.string().min(1), ServerScopeSchema).optional(),
    clockSkewSeconds: z.number().int().nonnegative().safe().optional(),
  })
  .strict();

const AuthConfigSchema = z
  .object({
    apiKeys: z.array(ApiKeyConfigSchema).min(1).optional(),
    oidc: OidcAuthConfigSchema.optional(),
    adminActionSigning: z
      .object({
        secret: z.string().min(16),
        keyId: z.string().min(1).max(256).optional(),
        maxSkewMs: z.number().int().positive().safe().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.apiKeys === undefined && config.oidc === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'auth requires at least one credential source',
      });
    }
  });

type ParsedOidcAuthConfig = z.infer<typeof OidcAuthConfigSchema>;

interface StoredApiKey {
  readonly principal: ApiKeyPrincipal;
  readonly secretHash: Buffer;
}

interface NormalizedOidcConfig {
  readonly issuer: string;
  readonly audiences: ReadonlySet<string>;
  readonly keys: readonly OidcVerificationKey[];
  readonly actorIdClaim: string;
  readonly rolesClaim?: string;
  readonly scopesClaim?: string;
  readonly labelScopeClaim?: string;
  readonly defaultRoles: readonly ServerRole[];
  readonly defaultScopes: readonly ServerScope[];
  readonly roleMappings: Readonly<Record<string, ServerRole>>;
  readonly scopeMappings: Readonly<Record<string, ServerScope>>;
  readonly clockSkewSeconds: number;
}

interface OidcVerificationKey {
  readonly kid?: string;
  readonly alg?: string;
  readonly key: KeyObject;
}

interface JwtHeader {
  readonly alg: OidcAlgorithm;
  readonly kid?: string;
  readonly typ?: string;
}

interface JwtClaims {
  readonly iss: string;
  readonly sub?: string;
  readonly aud: string | readonly string[];
  readonly exp: number;
  readonly nbf?: number;
  readonly iat?: number;
  readonly [claim: string]: unknown;
}

export class ApiKeyAuthenticator {
  readonly #keys: readonly StoredApiKey[];
  readonly #oidc: OidcTokenVerifier | undefined;
  readonly #adminSigning: NormalizedAdminActionSigningConfig | undefined;
  readonly #seenAdminNonces = new Map<string, number>();

  constructor(config: AuthConfig) {
    const parsed = AuthConfigSchema.parse(config);
    this.#adminSigning =
      parsed.adminActionSigning === undefined
        ? undefined
        : normalizeAdminActionSigning(parsed.adminActionSigning);
    this.#oidc = parsed.oidc === undefined ? undefined : new OidcTokenVerifier(parsed.oidc);
    this.#keys = (parsed.apiKeys ?? []).map((key) => ({
      principal: {
        id: key.id,
        actorId: key.actorId,
        roles: key.roles,
        ...(key.scopes !== undefined ? { scopes: key.scopes } : {}),
        ...(key.labelScope !== undefined ? { labelScope: key.labelScope } : {}),
      },
      secretHash: hashSecret(key.secret),
    }));
  }

  get adminActionSigningRequired(): boolean {
    return this.#adminSigning !== undefined;
  }

  authenticate(
    rawSecret: string | undefined,
    requirement: RouteAccess | readonly ServerRole[],
    now = Date.now(),
  ): AuthResult {
    if (rawSecret === undefined) {
      return {
        ok: false,
        failure: authFailure('missing', 'authentication credential is required'),
      };
    }
    const access = routeAccessFrom(requirement);
    const candidate = hashSecret(rawSecret);
    for (const key of this.#keys) {
      if (!timingSafeEqual(candidate, key.secretHash)) continue;
      if (!hasAccess(key.principal, access)) {
        return {
          ok: false,
          failure: authFailure('forbidden', 'API key does not have the required role'),
        };
      }
      return { ok: true, principal: key.principal };
    }
    if (this.#oidc !== undefined && isJwt(rawSecret)) {
      return this.#oidc.authenticate(rawSecret, access, now);
    }
    return { ok: false, failure: authFailure('invalid', 'API key is invalid') };
  }

  verifyAdminActionSignature(input: AdminActionSignatureInput): AdminActionSignatureResult {
    const config = this.#adminSigning;
    if (config === undefined) {
      return {
        ok: true,
        receipt: {
          keyId: 'unsigned',
          timestamp: input.now,
          nonce: '',
          method: input.method.toUpperCase(),
          path: input.path,
          bodyHash: bodyHash(input.body),
          algorithm: 'hmac-sha256',
        },
      };
    }

    if (
      input.timestamp === undefined ||
      input.nonce === undefined ||
      input.keyId === undefined ||
      input.signature === undefined
    ) {
      return { ok: false, error: validationError('admin action signature is required') };
    }
    if (input.keyId !== config.keyId) {
      return { ok: false, error: validationError('admin action signature key is invalid') };
    }
    if (!/^[0-9a-f]{64}$/.test(input.signature)) {
      return { ok: false, error: validationError('admin action signature is invalid') };
    }

    const timestamp = Number(input.timestamp);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      return { ok: false, error: validationError('admin action signature timestamp is invalid') };
    }
    if (Math.abs(input.now - timestamp) > config.maxSkewMs) {
      return { ok: false, error: validationError('admin action signature is stale') };
    }

    const nonce = input.nonce.trim();
    if (nonce.length === 0 || nonce.length > 256) {
      return { ok: false, error: validationError('admin action signature nonce is invalid') };
    }
    this.#pruneAdminNonces(input.now, config.maxSkewMs);
    const nonceKey = `${config.keyId}:${nonce}`;
    if (this.#seenAdminNonces.has(nonceKey)) {
      return { ok: false, error: validationError('admin action signature nonce was already used') };
    }

    const receipt = {
      keyId: config.keyId,
      timestamp,
      nonce,
      method: input.method.toUpperCase(),
      path: input.path,
      bodyHash: bodyHash(input.body),
      algorithm: 'hmac-sha256' as const,
    };
    const expected = signAdminAction(config.secret, receipt);
    if (!constantTimeHexEqual(expected, input.signature)) {
      return { ok: false, error: validationError('admin action signature is invalid') };
    }

    this.#seenAdminNonces.set(nonceKey, timestamp);
    return { ok: true, receipt };
  }

  #pruneAdminNonces(now: number, maxSkewMs: number): void {
    const oldestFresh = now - maxSkewMs;
    for (const [key, timestamp] of this.#seenAdminNonces) {
      if (timestamp < oldestFresh) this.#seenAdminNonces.delete(key);
    }
  }
}

class OidcTokenVerifier {
  readonly #config: NormalizedOidcConfig;

  constructor(config: ParsedOidcAuthConfig) {
    this.#config = normalizeOidcConfig(config);
  }

  authenticate(rawJwt: string, access: RouteAccess, nowMs: number): AuthResult {
    const verified = this.#verify(rawJwt, nowMs);
    if (!verified.ok) return verified;
    if (!hasAccess(verified.principal, access)) {
      return {
        ok: false,
        failure: authFailure('forbidden', 'OIDC token does not have the required role'),
      };
    }
    return { ok: true, principal: verified.principal };
  }

  #verify(
    rawJwt: string,
    nowMs: number,
  ): { readonly ok: true; readonly principal: ApiKeyPrincipal } | AuthResult {
    const parsed = parseJwt(rawJwt);
    if (!parsed.ok) return invalidOidc(parsed.reason);

    const { header, claims, signingInput, signature } = parsed;
    if (!this.#verifySignature(header, signingInput, signature)) {
      return invalidOidc('OIDC token signature is invalid');
    }
    const claimsResult = this.#validateClaims(claims, Math.floor(nowMs / 1000));
    if (!claimsResult.ok) return invalidOidc(claimsResult.reason);
    const principal = this.#principalFromClaims(claims);
    return { ok: true, principal };
  }

  #verifySignature(header: JwtHeader, signingInput: string, signature: Buffer): boolean {
    for (const candidate of this.#keysFor(header)) {
      const algorithm = cryptoAlgorithmFor(header.alg);
      try {
        if (
          verifySignature(algorithm, Buffer.from(signingInput, 'utf8'), candidate.key, signature)
        ) {
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  }

  #keysFor(header: JwtHeader): readonly OidcVerificationKey[] {
    return this.#config.keys.filter((key) => {
      if (header.kid !== undefined && key.kid !== undefined && key.kid !== header.kid) return false;
      if (header.kid !== undefined && key.kid === undefined) return false;
      if (key.alg !== undefined && key.alg !== header.alg) return false;
      return true;
    });
  }

  #validateClaims(
    claims: JwtClaims,
    nowSeconds: number,
  ): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    const skew = this.#config.clockSkewSeconds;
    if (claims.iss !== this.#config.issuer) {
      return { ok: false, reason: 'OIDC token issuer is invalid' };
    }
    if (!audienceMatches(claims.aud, this.#config.audiences)) {
      return { ok: false, reason: 'OIDC token audience is invalid' };
    }
    if (claims.exp + skew < nowSeconds) {
      return { ok: false, reason: 'OIDC token is expired' };
    }
    if (claims.nbf !== undefined && claims.nbf - skew > nowSeconds) {
      return { ok: false, reason: 'OIDC token is not yet valid' };
    }
    if (claims.iat !== undefined && claims.iat - skew > nowSeconds) {
      return { ok: false, reason: 'OIDC token issued-at time is in the future' };
    }
    const actorClaim = claimValue(claims, this.#config.actorIdClaim);
    if (typeof actorClaim !== 'string' || actorClaim.length === 0) {
      return { ok: false, reason: 'OIDC token actor claim is invalid' };
    }
    if (
      this.#config.labelScopeClaim !== undefined &&
      labelScopeFromClaim(claimValue(claims, this.#config.labelScopeClaim)) === null
    ) {
      return { ok: false, reason: 'OIDC token label-scope claim is invalid' };
    }
    return { ok: true };
  }

  #principalFromClaims(claims: JwtClaims): ApiKeyPrincipal {
    const actorClaim = claimValue(claims, this.#config.actorIdClaim);
    const actorId = actorClaim as string;

    const roles = unique([
      ...this.#config.defaultRoles,
      ...mapClaimValues(
        claimValue(claims, this.#config.rolesClaim),
        this.#config.roleMappings,
        ServerRoleSchema,
      ),
    ]);
    const scopes = unique([
      ...this.#config.defaultScopes,
      ...mapClaimValues(
        claimValue(claims, this.#config.scopesClaim),
        this.#config.scopeMappings,
        ServerScopeSchema,
      ),
    ]);
    const labelScope =
      labelScopeFromClaim(claimValue(claims, this.#config.labelScopeClaim)) ?? undefined;
    return {
      id: `oidc:${claims.iss}:${actorId}`,
      actorId,
      roles,
      scopes,
      ...(labelScope !== undefined ? { labelScope } : {}),
    };
  }
}

export function signAdminAction(secret: string, receipt: AdminActionSignatureReceipt): string {
  return createHmac('sha256', secret)
    .update(adminActionSigningPayload(receipt), 'utf8')
    .digest('hex');
}

export function parseApiKeyEntries(raw: string | undefined): ApiKeyConfig[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map(parseApiKeyEntry);
}

function parseApiKeyEntry(entry: string): ApiKeyConfig {
  const [id, actorId, secret, rolesRaw, ...scopeParts] = entry.split(':');
  if (!id || !actorId || !secret || !rolesRaw) {
    throw new Error(
      'VERITRAIL_API_KEYS entries must be id:actorId:secret:role1|role2[:scope1|scope2]',
    );
  }
  const roles = z.array(ServerRoleSchema).min(1).parse(tokensFrom(rolesRaw));
  const trailingFields = parseTrailingFields(scopeParts);
  const scopes = parseScopes(trailingFields.scopes);
  const labelScope = parseLabelScope(trailingFields.labelScope);
  return {
    id,
    actorId,
    secret,
    roles,
    ...(scopes !== undefined ? { scopes } : {}),
    ...(labelScope !== undefined ? { labelScope } : {}),
  };
}

interface ParsedTrailingFields {
  readonly scopes?: string;
  readonly labelScope?: string;
}

function parseTrailingFields(parts: readonly string[]): ParsedTrailingFields {
  if (parts.length === 0) return {};
  const raw = parts.join(':');
  const [scopesRaw, labelScopeRaw] = raw.split(';labels=');
  return {
    ...(scopesRaw !== undefined && scopesRaw.length > 0 ? { scopes: scopesRaw } : {}),
    ...(labelScopeRaw !== undefined && labelScopeRaw.length > 0
      ? { labelScope: labelScopeRaw }
      : {}),
  };
}

function parseScopes(raw: string | undefined): ServerScope[] | undefined {
  if (!raw) return undefined;
  const scopes = z.array(ServerScopeSchema).min(1).parse(tokensFrom(raw));
  return scopes.length > 0 ? scopes : undefined;
}

function parseLabelScope(raw: string | undefined): Readonly<Record<string, string>> | undefined {
  if (!raw) return undefined;
  const entries = tokensFrom(raw).map((token) => {
    const separator = token.indexOf('=');
    if (separator <= 0 || separator === token.length - 1) {
      throw new Error('label scopes must be key=value pairs');
    }
    return [token.slice(0, separator), token.slice(separator + 1)] as const;
  });
  return z.record(z.string().min(1), z.string()).parse(Object.fromEntries(entries));
}

function tokensFrom(raw: string): string[] {
  return raw
    .split('|')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

export function parseAuthHeader(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const [scheme, token, extra] = trimmed.split(/\s+/);
  if (scheme !== undefined && token !== undefined && extra === undefined) {
    if (scheme.toLowerCase() === 'bearer') return token;
  }
  return trimmed;
}

export function hasRole(principal: ApiKeyPrincipal, requiredRoles: readonly ServerRole[]): boolean {
  if (requiredRoles.length === 0) return true;
  if (principal.roles.includes('admin')) return true;
  return requiredRoles.some((role) => principal.roles.includes(role));
}

export function hasAccess(
  principal: ApiKeyPrincipal,
  requirement: RouteAccess | readonly ServerRole[],
): boolean {
  const access = routeAccessFrom(requirement);
  if (!hasRole(principal, access.roles)) return false;
  if (principal.roles.includes('admin')) return true;
  if (access.scope === undefined) return true;
  if (principal.scopes === undefined) return true;
  return principal.scopes.includes(access.scope);
}

function routeAccessFrom(requirement: RouteAccess | readonly ServerRole[]): RouteAccess {
  return isRoleRequirement(requirement) ? { roles: requirement } : requirement;
}

function isRoleRequirement(
  requirement: RouteAccess | readonly ServerRole[],
): requirement is readonly ServerRole[] {
  return Array.isArray(requirement);
}

function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

function authFailure(reason: AuthFailureReason, message: string): AuthFailure {
  return { reason, error: validationError(message) };
}

interface NormalizedAdminActionSigningConfig {
  readonly secret: string;
  readonly keyId: string;
  readonly maxSkewMs: number;
}

function normalizeAdminActionSigning(config: {
  readonly secret: string;
  readonly keyId?: string | undefined;
  readonly maxSkewMs?: number | undefined;
}): NormalizedAdminActionSigningConfig {
  return {
    secret: config.secret,
    keyId: config.keyId ?? 'admin-action',
    maxSkewMs: config.maxSkewMs ?? DEFAULT_ADMIN_ACTION_SIGNATURE_MAX_SKEW_MS,
  };
}

function normalizeOidcConfig(parsed: ParsedOidcAuthConfig): NormalizedOidcConfig {
  const keys = parsed.jwks.keys.map((jwk): OidcVerificationKey => {
    try {
      const key = createPublicKey({ key: jwk, format: 'jwk' });
      return {
        ...(typeof jwk.kid === 'string' ? { kid: jwk.kid } : {}),
        ...(typeof jwk.alg === 'string' ? { alg: jwk.alg } : {}),
        key,
      };
    } catch {
      throw new Error('OIDC JWKS contains an invalid public key');
    }
  });
  return {
    issuer: parsed.issuer,
    audiences: new Set(Array.isArray(parsed.audience) ? parsed.audience : [parsed.audience]),
    keys,
    actorIdClaim: parsed.actorIdClaim ?? 'sub',
    ...(parsed.rolesClaim !== undefined ? { rolesClaim: parsed.rolesClaim } : {}),
    ...(parsed.scopesClaim !== undefined ? { scopesClaim: parsed.scopesClaim } : {}),
    ...(parsed.labelScopeClaim !== undefined ? { labelScopeClaim: parsed.labelScopeClaim } : {}),
    defaultRoles: parsed.defaultRoles ?? [],
    defaultScopes: parsed.defaultScopes ?? [],
    roleMappings: parsed.roleMappings ?? {},
    scopeMappings: parsed.scopeMappings ?? {},
    clockSkewSeconds: parsed.clockSkewSeconds ?? DEFAULT_OIDC_CLOCK_SKEW_SECONDS,
  };
}

function parseJwt(rawJwt: string):
  | {
      readonly ok: true;
      readonly header: JwtHeader;
      readonly claims: JwtClaims;
      readonly signingInput: string;
      readonly signature: Buffer;
    }
  | { readonly ok: false; readonly reason: string } {
  const parts = rawJwt.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'OIDC token must be a compact JWT' };
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  if (!encodedHeader || !encodedClaims || !encodedSignature) {
    return { ok: false, reason: 'OIDC token must be a compact JWT' };
  }
  const header = JwtHeaderSchema.safeParse(jsonFromBase64Url(encodedHeader));
  if (!header.success) return { ok: false, reason: 'OIDC token header is invalid' };
  const claims = JwtClaimsSchema.safeParse(jsonFromBase64Url(encodedClaims));
  if (!claims.success) return { ok: false, reason: 'OIDC token claims are invalid' };
  const signature = base64UrlToBuffer(encodedSignature);
  if (signature === null || signature.length === 0) {
    return { ok: false, reason: 'OIDC token signature is invalid' };
  }
  return {
    ok: true,
    header: normalizeJwtHeader(header.data),
    claims: normalizeJwtClaims(claims.data),
    signingInput: `${encodedHeader}.${encodedClaims}`,
    signature,
  };
}

const JwtHeaderSchema = z
  .object({
    alg: z.enum(OIDC_ALGORITHMS),
    kid: z.string().min(1).optional(),
    typ: z.string().optional(),
  })
  .passthrough();

const JwtClaimsSchema = z
  .object({
    iss: z.string().url(),
    sub: z.string().min(1).optional(),
    aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    exp: z.number().int().safe().nonnegative(),
    nbf: z.number().int().safe().nonnegative().optional(),
    iat: z.number().int().safe().nonnegative().optional(),
  })
  .passthrough();

function normalizeJwtHeader(header: z.infer<typeof JwtHeaderSchema>): JwtHeader {
  return {
    alg: header.alg,
    ...(header.kid !== undefined ? { kid: header.kid } : {}),
    ...(header.typ !== undefined ? { typ: header.typ } : {}),
  };
}

function normalizeJwtClaims(claims: z.infer<typeof JwtClaimsSchema>): JwtClaims {
  const customClaims = Object.fromEntries(
    Object.entries(claims).filter(
      ([key, value]) =>
        !['iss', 'sub', 'aud', 'exp', 'nbf', 'iat'].includes(key) && value !== undefined,
    ),
  );
  return {
    ...customClaims,
    iss: claims.iss,
    ...(claims.sub !== undefined ? { sub: claims.sub } : {}),
    aud: claims.aud,
    exp: claims.exp,
    ...(claims.nbf !== undefined ? { nbf: claims.nbf } : {}),
    ...(claims.iat !== undefined ? { iat: claims.iat } : {}),
  };
}

function jsonFromBase64Url(encoded: string): unknown {
  const decoded = base64UrlToBuffer(encoded);
  if (decoded === null) return null;
  try {
    return JSON.parse(decoded.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

function base64UrlToBuffer(encoded: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  try {
    return Buffer.from(padded, 'base64');
  } catch {
    return null;
  }
}

function isJwt(value: string): boolean {
  return value.split('.').length === 3;
}

function cryptoAlgorithmFor(algorithm: OidcAlgorithm): string {
  switch (algorithm) {
    case 'RS256':
      return 'RSA-SHA256';
  }
}

function audienceMatches(
  actual: string | readonly string[],
  expected: ReadonlySet<string>,
): boolean {
  const actualAudiences = Array.isArray(actual) ? actual : [actual];
  return actualAudiences.some((audience) => expected.has(audience));
}

function claimValue(claims: JwtClaims, claimName: string | undefined): unknown {
  if (claimName === undefined) return undefined;
  return claims[claimName];
}

function mapClaimValues<T extends string>(
  raw: unknown,
  mappings: Readonly<Record<string, T>>,
  schema: z.ZodType<T>,
): T[] {
  const values = claimValues(raw);
  const mapped: T[] = [];
  for (const value of values) {
    const mappedValue = mappings[value];
    if (mappedValue !== undefined) {
      mapped.push(mappedValue);
      continue;
    }
    const direct = schema.safeParse(value);
    if (direct.success) {
      mapped.push(direct.data);
    }
  }
  return mapped;
}

function claimValues(raw: unknown): string[] {
  if (typeof raw === 'string') {
    return raw
      .split(/\s+/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }
  if (Array.isArray(raw)) {
    return raw.filter((value): value is string => typeof value === 'string' && value.length > 0);
  }
  return [];
}

function labelScopeFromClaim(raw: unknown): Readonly<Record<string, string>> | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const entries = Object.entries(raw).filter(
    (entry): entry is [string, string] => entry[0].length > 0 && typeof entry[1] === 'string',
  );
  if (entries.length !== Object.keys(raw).length || entries.length === 0) return null;
  return Object.fromEntries(entries);
}

function unique<T extends string>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}

function invalidOidc(reason: string): AuthResult {
  return { ok: false, failure: authFailure('invalid', reason) };
}

function adminActionSigningPayload(receipt: AdminActionSignatureReceipt): string {
  return canonicalize({
    algorithm: receipt.algorithm,
    bodyHash: receipt.bodyHash,
    keyId: receipt.keyId,
    method: receipt.method,
    nonce: receipt.nonce,
    path: receipt.path,
    timestamp: receipt.timestamp,
  });
}

function bodyHash(body: unknown): string {
  return sha256Hex(canonicalize(asJson(body ?? null)));
}

function constantTimeHexEqual(expected: string, actual: string): boolean {
  if (!/^[0-9a-f]+$/.test(actual) || expected.length !== actual.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
  } catch {
    return false;
  }
}

export function adminActionSignatureDetails(receipt: AdminActionSignatureReceipt): JsonValue {
  return {
    keyId: receipt.keyId,
    timestamp: receipt.timestamp,
    nonce: receipt.nonce,
    method: receipt.method,
    path: receipt.path,
    bodyHash: receipt.bodyHash,
    algorithm: receipt.algorithm,
  };
}
