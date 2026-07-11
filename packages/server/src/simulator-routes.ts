/**
 * HTTP route for the pre-crime policy simulator. Given a candidate set of
 * policies, replay them against the recorded ledger and report the diff so
 * operators can ship policy changes without guessing which past actions would
 * flip allow/deny/require_approval.
 *
 * Business logic lives in @veritrail/policy-simulator. This module is a thin
 * HTTP shell: validate, call simulatePolicies, serialize.
 */

import { PolicySchema, validationError, type EventQuery, type LedgerReader } from '@veritrail/core';
import { simulatePolicies, type SimulationResult } from '@veritrail/policy-simulator';
import type { FastifyInstance } from 'fastify';

import { replyError } from './http.js';

export interface SimulatorRoutesOptions {
  readonly ledger: LedgerReader;
}

/**
 * Mount POST /api/v1/simulator/run. The handler validates each candidate
 * policy via PolicySchema, optionally accepts an EventQuery window, and
 * returns the full SimulationResult as JSON.
 */
export function registerSimulatorRoutes(app: FastifyInstance, opts: SimulatorRoutesOptions): void {
  const { ledger } = opts;

  app.post('/api/v1/simulator/run', async (request, reply) => {
    const body = request.body as
      | { proposedPolicies?: unknown; window?: unknown }
      | null
      | undefined;
    if (!body || typeof body !== 'object') {
      return replyError(reply, validationError('request body is required'));
    }

    const rawPolicies = body.proposedPolicies;
    if (!Array.isArray(rawPolicies)) {
      return replyError(reply, validationError('proposedPolicies must be an array'));
    }

    const proposedPolicies = [];
    for (let i = 0; i < rawPolicies.length; i++) {
      const parsed = PolicySchema.safeParse(rawPolicies[i]);
      if (!parsed.success) {
        return replyError(
          reply,
          validationError(
            `invalid policy at index ${i}: ${parsed.error.issues[0]?.message ?? 'unknown error'}`,
          ),
        );
      }
      proposedPolicies.push(parsed.data);
    }

    const window = parseWindow(body.window);
    if (!window.ok) return replyError(reply, window.error);

    const result: SimulationResult = await simulatePolicies({
      ledger,
      proposedPolicies,
      ...(window.value !== undefined ? { window: window.value } : {}),
    });
    return reply.send(result);
  });
}

type WindowParseResult =
  | { ok: true; value: EventQuery | undefined }
  | { ok: false; error: ReturnType<typeof validationError> };

/**
 * Coerce the optional `window` field on the request body to an EventQuery.
 * Accepts only the seq/actor/correlation/labels subset that makes sense for a
 * replay window; rejects malformed input rather than silently dropping it.
 */
function parseWindow(raw: unknown): WindowParseResult {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: validationError('window must be an object') };
  }
  const obj = raw as Record<string, unknown>;
  const query: EventQuery = {};
  if (obj['fromSeq'] !== undefined) {
    if (typeof obj['fromSeq'] !== 'number' || !Number.isFinite(obj['fromSeq'])) {
      return { ok: false, error: validationError('window.fromSeq must be a number') };
    }
    query.fromSeq = obj['fromSeq'];
  }
  if (obj['toSeq'] !== undefined) {
    if (typeof obj['toSeq'] !== 'number' || !Number.isFinite(obj['toSeq'])) {
      return { ok: false, error: validationError('window.toSeq must be a number') };
    }
    query.toSeq = obj['toSeq'];
  }
  if (obj['actorId'] !== undefined) {
    if (typeof obj['actorId'] !== 'string') {
      return { ok: false, error: validationError('window.actorId must be a string') };
    }
    query.actorId = obj['actorId'];
  }
  if (obj['correlationId'] !== undefined) {
    if (typeof obj['correlationId'] !== 'string') {
      return { ok: false, error: validationError('window.correlationId must be a string') };
    }
    query.correlationId = obj['correlationId'];
  }
  if (obj['labels'] !== undefined) {
    const labels = obj['labels'];
    if (labels === null || typeof labels !== 'object' || Array.isArray(labels)) {
      return { ok: false, error: validationError('window.labels must be an object') };
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(labels as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        return { ok: false, error: validationError('window.labels values must be strings') };
      }
      out[k] = v;
    }
    query.labels = out;
  }
  return { ok: true, value: query };
}
