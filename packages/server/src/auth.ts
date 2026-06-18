import { createHash, timingSafeEqual } from 'node:crypto';

import { validationError, type VeritrailError } from '@veritrail/core';
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
}

export interface ApiKeyConfig {
  readonly id: string;
  readonly actorId: string;
  readonly secret: string;
  readonly roles: readonly ServerRole[];
  /** Optional route scopes. When supplied, scoped routes require a matching value. */
  readonly scopes?: readonly ServerScope[];
}

export interface RouteAccess {
  readonly roles: readonly ServerRole[];
  readonly scope?: ServerScope;
}

export interface AuthConfig {
  readonly apiKeys: readonly ApiKeyConfig[];
}

export type AuthFailureReason = 'missing' | 'invalid' | 'forbidden';

export interface AuthFailure {
  readonly reason: AuthFailureReason;
  readonly error: VeritrailError;
}

export type AuthResult =
  | { readonly ok: true; readonly principal: ApiKeyPrincipal }
  | { readonly ok: false; readonly failure: AuthFailure };

const ApiKeyConfigSchema = z
  .object({
    id: z.string().min(1).max(256),
    actorId: z.string().min(1).max(256),
    secret: z.string().min(16),
    roles: z.array(ServerRoleSchema).min(1),
    scopes: z.array(ServerScopeSchema).optional(),
  })
  .strict();

const AuthConfigSchema = z
  .object({
    apiKeys: z.array(ApiKeyConfigSchema).min(1),
  })
  .strict();

interface StoredApiKey {
  readonly principal: ApiKeyPrincipal;
  readonly secretHash: Buffer;
}

export class ApiKeyAuthenticator {
  readonly #keys: readonly StoredApiKey[];

  constructor(config: AuthConfig) {
    const parsed = AuthConfigSchema.parse(config);
    this.#keys = parsed.apiKeys.map((key) => ({
      principal: {
        id: key.id,
        actorId: key.actorId,
        roles: key.roles,
        ...(key.scopes !== undefined ? { scopes: key.scopes } : {}),
      },
      secretHash: hashSecret(key.secret),
    }));
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
  const scopes = parseScopes(scopeParts.length > 0 ? scopeParts.join(':') : undefined);
  return {
    id,
    actorId,
    secret,
    roles,
    ...(scopes !== undefined ? { scopes } : {}),
  };
}

function parseScopes(raw: string | undefined): ServerScope[] | undefined {
  if (!raw) return undefined;
  const scopes = z.array(ServerScopeSchema).min(1).parse(tokensFrom(raw));
  return scopes.length > 0 ? scopes : undefined;
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
