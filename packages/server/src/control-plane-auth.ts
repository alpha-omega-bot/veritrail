/**
 * Bridge between the SaaS control-plane's dynamically minted API keys and the
 * Veritrail server's existing {@link ApiKeyPrincipal} model.
 *
 * The server has two distinct API-key authentication paths:
 *
 *   (a) {@link ApiKeyAuthenticator} reads a static allow-list configured via
 *       env vars / `BuildServerOptions.auth`. Keys are hashed once at startup
 *       and compared with constant-time equality.
 *   (b) {@link ControlPlane.authenticateApiKey} resolves keys minted in the
 *       console at runtime. Each record is project-scoped and hashed at rest.
 *
 * Without a bridge, a customer who mints a key from the console cannot use it
 * against `/api/events` because the server-side allow-list never heard of it.
 *
 * This module exposes a thin Fastify preHandler that runs BEFORE the static
 * authenticator: it inspects the incoming credential and, if it looks like a
 * control-plane key (the `vt_live_` prefix), resolves it via the control plane
 * and synthesises a principal whose `labelScope` carries the `{ org, project }`
 * hint. On any miss it is a no-op so the existing static/OIDC auth chain still
 * runs.
 */

import type { ControlPlane } from '@veritrail/control-plane';

import { parseAuthHeader, type ApiKeyPrincipal, type ServerRole } from './auth.js';
import type { ServerPreHandler } from './limits.js';

/**
 * Prefix every control-plane-minted API key carries. Keys produced by
 * {@link ControlPlane.createApiKey} are formatted as `vt_live_<random>` and the
 * preHandler uses this prefix to decide whether a credential is in scope.
 */
export const CONTROL_PLANE_API_KEY_PREFIX = 'vt_live_';

/**
 * Roles granted to every principal resolved through the control plane. The
 * console UI does not yet split ingest from operator access, so a minted key
 * receives both — equivalent to a project-scoped service account.
 */
const CONTROL_PLANE_PRINCIPAL_ROLES: readonly ServerRole[] = ['operator', 'ingest'];

/** Configuration for {@link createControlPlaneAuthPreHandler}. */
export interface ControlPlaneAuthOptions {
  /** Live control-plane façade used to resolve plaintext API keys. */
  readonly controlPlane: ControlPlane;
}

/**
 * Build a Fastify preHandler that resolves control-plane API keys to a
 * synthetic {@link ApiKeyPrincipal}. The handler:
 *
 *   - Reads the credential from `Authorization: Bearer …` or
 *     `X-Veritrail-Api-Key`.
 *   - Skips when no credential is present or the value does not start with
 *     `vt_live_` (passes control to the next handler).
 *   - On a successful resolution sets `request.principal` to a principal with
 *     `roles: ["operator", "ingest"]` and
 *     `labelScope: { org, project }` matching the record.
 *   - On a miss (revoked, unknown prefix, hash mismatch) leaves
 *     `request.principal` untouched so the existing static-key / OIDC chain
 *     can attempt to authenticate the same credential.
 *
 * The handler never short-circuits with an error: failure modes are silent and
 * delegate to the next preHandler in the chain.
 */
export function createControlPlaneAuthPreHandler(opts: ControlPlaneAuthOptions): ServerPreHandler {
  const { controlPlane } = opts;
  return async (request) => {
    if (request.principal !== undefined) return;
    const rawSecret =
      parseAuthHeader(request.headers.authorization) ??
      parseAuthHeader(request.headers['x-veritrail-api-key']);
    if (rawSecret === undefined) return;
    if (!rawSecret.startsWith(CONTROL_PLANE_API_KEY_PREFIX)) return;
    const resolved = await controlPlane.authenticateApiKey(rawSecret);
    if (resolved === null) return;
    request.principal = principalFromRecord(
      resolved.record.id,
      resolved.record.label,
      resolved.labelScope,
    );
  };
}

function principalFromRecord(
  id: string,
  label: string,
  labelScope: Readonly<Record<string, string>>,
): ApiKeyPrincipal {
  return {
    id,
    actorId: label.length > 0 ? label : id,
    roles: CONTROL_PLANE_PRINCIPAL_ROLES,
    labelScope,
  };
}
