/**
 * HTTP route for the self-healing cost optimizer. Given a period window,
 * project month-end spend, flag daily anomalies, and recommend cheaper-model
 * swaps over the existing `budget.charged` events on the ledger.
 *
 * Business logic lives in `@veritrail/cost-optimizer`. This module is a thin
 * HTTP shell: validate the window, project the ledger into SpendSamples, call
 * the three analyzers, serialize the result.
 */

import { validationError, type LedgerReader, type LedgerRecord } from '@veritrail/core';
import {
  detectSpendAnomalies,
  forecast,
  recommendModelSwaps,
  type SpendSample,
} from '@veritrail/cost-optimizer';
import type { FastifyInstance } from 'fastify';

import { replyError } from './http.js';

export interface CostOptimizerRoutesOptions {
  readonly ledger: LedgerReader;
}

/**
 * Mount `POST /api/v1/cost-optimizer/forecast`. The handler validates the
 * window, queries the ledger for `budget.charged` events within
 * `[periodStartMs, periodEndMs]`, projects each record into a `SpendSample`,
 * and returns the combined forecast, anomalies, and swap recommendations.
 */
export function registerCostOptimizerRoutes(
  app: FastifyInstance,
  opts: CostOptimizerRoutesOptions,
): void {
  const { ledger } = opts;

  app.post('/api/v1/cost-optimizer/forecast', async (request, reply) => {
    const body = request.body as
      | { periodStartMs?: unknown; periodEndMs?: unknown }
      | null
      | undefined;
    if (!body || typeof body !== 'object') {
      return replyError(reply, validationError('request body is required'));
    }
    const periodStartMs = body.periodStartMs;
    const periodEndMs = body.periodEndMs;
    if (typeof periodStartMs !== 'number' || !Number.isFinite(periodStartMs)) {
      return replyError(reply, validationError('periodStartMs must be a finite number'));
    }
    if (typeof periodEndMs !== 'number' || !Number.isFinite(periodEndMs)) {
      return replyError(reply, validationError('periodEndMs must be a finite number'));
    }
    if (periodEndMs <= periodStartMs) {
      return replyError(reply, validationError('periodEndMs must be greater than periodStartMs'));
    }

    const records = await ledger.query({ types: ['budget.charged'] });
    const samples = recordsToSamples(records, periodStartMs, periodEndMs);

    return reply.send({
      forecast: forecast({ samples, periodStartMs, periodEndMs }),
      anomalies: detectSpendAnomalies(samples),
      recommendations: recommendModelSwaps(samples),
    });
  });
}

/**
 * Project `budget.charged` ledger records into the `SpendSample` shape used by
 * the cost-optimizer analyzers. Records outside `[periodStartMs, periodEndMs]`
 * are dropped so each analyzer only sees the current window. The `model`
 * label, when present, is forwarded so `recommendModelSwaps` can suggest
 * cheaper-model swaps; the budget scope `value` is forwarded as `scope` for
 * downstream grouping.
 */
function recordsToSamples(
  records: ReadonlyArray<LedgerRecord>,
  periodStartMs: number,
  periodEndMs: number,
): SpendSample[] {
  const samples: SpendSample[] = [];
  for (const record of records) {
    if (record.event.type !== 'budget.charged') continue;
    const atMs = record.timestamp;
    if (atMs < periodStartMs || atMs > periodEndMs) continue;
    const amountMinor = record.event.payload.amount.amountMinor;
    const model = record.event.labels['model'];
    const scopeValue = record.event.payload.scope.value;
    const sample: SpendSample = {
      atMs,
      amountMinor,
      ...(model !== undefined ? { model } : {}),
      ...(scopeValue !== '' ? { scope: scopeValue } : {}),
    };
    samples.push(sample);
  }
  return samples;
}
