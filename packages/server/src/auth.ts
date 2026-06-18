import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

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

export interface RouteAccess {
  readonly roles: readonly ServerRole[];
  readonly scope?: ServerScope;
}

export interface AuthConfig {
  readonly apiKeys: readonly ApiKeyConfig[];
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

const AuthConfigSchema = z
  .object({
    apiKeys: z.array(ApiKeyConfigSchema).min(1),
    adminActionSigning: z
      .object({
        secret: z.string().min(16),
        keyId: z.string().min(1).max(256).optional(),
        maxSkewMs: z.number().int().positive().safe().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

interface StoredApiKey {
  readonly principal: ApiKeyPrincipal;
  readonly secretHash: Buffer;
}

export class ApiKeyAuthenticator {
  readonly #keys: readonly StoredApiKey[];
  readonly #adminSigning: NormalizedAdminActionSigningConfig | undefined;
  readonly #seenAdminNonces = new Map<string, number>();

  constructor(config: AuthConfig) {
    const parsed = AuthConfigSchema.parse(config);
    this.#adminSigning =
      parsed.adminActionSigning === undefined
        ? undefined
        : normalizeAdminActionSigning(parsed.adminActionSigning);
    this.#keys = parsed.apiKeys.map((key) => ({
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
  ): AuthResult {
    if (rawSecret === undefined) {
      return { ok: false, failure: authFailure('missing', 'API key is required') };
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
