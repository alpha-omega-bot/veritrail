import { createHash, timingSafeEqual } from 'node:crypto';

import { validationError, type VeritrailError } from '@veritrail/core';
import { z } from 'zod';

export const ServerRoleSchema = z.enum(['ingest', 'operator', 'admin']);
export type ServerRole = z.infer<typeof ServerRoleSchema>;

export interface ApiKeyPrincipal {
  readonly id: string;
  readonly actorId: string;
  readonly roles: readonly ServerRole[];
}

export interface ApiKeyConfig {
  readonly id: string;
  readonly actorId: string;
  readonly secret: string;
  readonly roles: readonly ServerRole[];
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
      },
      secretHash: hashSecret(key.secret),
    }));
  }

  authenticate(rawSecret: string | undefined, requiredRoles: readonly ServerRole[]): AuthResult {
    if (rawSecret === undefined) {
      return { ok: false, failure: authFailure('missing', 'API key is required') };
    }
    const candidate = hashSecret(rawSecret);
    for (const key of this.#keys) {
      if (!timingSafeEqual(candidate, key.secretHash)) continue;
      if (!hasRole(key.principal, requiredRoles)) {
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

function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

function authFailure(reason: AuthFailureReason, message: string): AuthFailure {
  return { reason, error: validationError(message) };
}
