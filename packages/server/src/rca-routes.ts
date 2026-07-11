/**
 * HTTP routes for AI-generated Root Cause Analysis.
 *
 * Mounted under /api/v1/rca/* by the server. The handler queries the ledger
 * for the events tied to a correlation id, groups them by event type into a
 * compact forensics payload, and pipes that payload through an LLM adapter
 * (Anthropic Claude by default) via `@veritrail/auto-rca`.
 *
 * Wiring is additive: callers that pass no `opts.adapter` and no
 * `opts.anthropicApiKey` get a 503 from the analyze endpoint rather than a
 * hard build break.
 */

import {
  analyzeIncident,
  AnthropicClaudeAdapter,
  type LlmAdapter,
  type RcaReport,
} from '@veritrail/auto-rca';
import { validationError, type LedgerReader, type LedgerRecord } from '@veritrail/core';
import type { FastifyInstance } from 'fastify';

import { replyError } from './http.js';

export interface RcaRoutesOptions {
  /** Read-side of the ledger used to assemble the forensics payload. */
  readonly ledger: LedgerReader;
  /** Anthropic API key used to construct the default adapter when no override is supplied. */
  readonly anthropicApiKey?: string;
  /** Model id forwarded to the default Anthropic adapter. */
  readonly model?: string;
  /** Adapter override; takes precedence over `anthropicApiKey`. Primarily for tests. */
  readonly adapter?: LlmAdapter;
}

/**
 * Shape of the forensics object passed to the LLM. Records are grouped by
 * event type so the prompt sees one bucket per category rather than a flat
 * stream — this is the "small forensics-shaped object" the analyze prompt
 * expects.
 */
interface RcaForensicsPayload {
  readonly correlationId: string;
  readonly eventCount: number;
  readonly firstTimestamp: number | null;
  readonly lastTimestamp: number | null;
  readonly byType: Readonly<Record<string, ReadonlyArray<RcaForensicsEntry>>>;
}

interface RcaForensicsEntry {
  readonly seq: number;
  readonly id: string;
  readonly timestamp: number;
  readonly actorId: string;
  readonly payload: unknown;
}

/** Register the /api/v1/rca/* HTTP surface. */
export function registerRcaRoutes(app: FastifyInstance, opts: RcaRoutesOptions): void {
  const { ledger } = opts;

  app.post('/api/v1/rca/analyze', async (request, reply) => {
    const body = request.body as { correlationId?: unknown; operatorContext?: unknown } | undefined;
    const correlationId =
      typeof body?.correlationId === 'string' && body.correlationId.length > 0
        ? body.correlationId
        : null;
    if (!correlationId) {
      return replyError(reply, validationError('correlationId is required'));
    }
    const operatorContext =
      typeof body?.operatorContext === 'string' && body.operatorContext.length > 0
        ? body.operatorContext
        : undefined;

    const adapter = resolveAdapter(opts);
    if (!adapter) {
      return reply
        .code(503)
        .send({ error: { code: 'UNSUPPORTED', message: 'RCA backend not configured' } });
    }

    const records = await ledger.query({ correlationId, limit: 1000 });
    const forensics = shapeForensics(correlationId, records);

    let report: RcaReport;
    try {
      report = await analyzeIncident({
        adapter,
        forensics,
        ...(operatorContext !== undefined ? { operatorContext } : {}),
      });
    } catch (err) {
      request.log.error({ err }, 'analyzeIncident failed');
      return reply.code(502).send({
        error: {
          code: 'INTERNAL',
          message: err instanceof Error ? err.message : 'RCA generation failed',
        },
      });
    }

    return reply.send(report);
  });
}

function resolveAdapter(opts: RcaRoutesOptions): LlmAdapter | undefined {
  if (opts.adapter) return opts.adapter;
  if (opts.anthropicApiKey) {
    return new AnthropicClaudeAdapter({
      apiKey: opts.anthropicApiKey,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    });
  }
  return undefined;
}

function shapeForensics(
  correlationId: string,
  records: readonly LedgerRecord[],
): RcaForensicsPayload {
  const byType: Record<string, RcaForensicsEntry[]> = {};
  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;
  for (const record of records) {
    const type = record.event.type;
    const bucket = byType[type] ?? (byType[type] = []);
    bucket.push({
      seq: record.seq,
      id: record.id,
      timestamp: record.timestamp,
      actorId: record.event.actorId,
      payload: record.event.payload,
    });
    if (firstTimestamp === null || record.timestamp < firstTimestamp) {
      firstTimestamp = record.timestamp;
    }
    if (lastTimestamp === null || record.timestamp > lastTimestamp) {
      lastTimestamp = record.timestamp;
    }
  }
  return {
    correlationId,
    eventCount: records.length,
    firstTimestamp,
    lastTimestamp,
    byType,
  };
}
