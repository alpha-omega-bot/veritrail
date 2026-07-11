/**
 * HTTP routes that expose `@veritrail/compliance`. They let an operator pick a
 * built-in framework (SOC 2 CC7, EU AI Act Annex IV, HIPAA Security Rule, ISO
 * 42001), collect ledger-backed evidence for a window, and download an
 * auditor-ready Markdown report whose every control claim cites the specific
 * hash-chained ledger event ids that prove it.
 *
 * The handlers are intentionally thin: framework lookup, evidence collection,
 * scoring, and rendering all live in `@veritrail/compliance`.
 */

import type { LedgerReader } from '@veritrail/core';
import { validationError } from '@veritrail/core';
import {
  collectEvidence,
  compliancePercent,
  FRAMEWORK_IDS,
  FRAMEWORK_TEMPLATES,
  renderMarkdown,
  requireFramework,
  type FrameworkId,
} from '@veritrail/compliance';
import type { FastifyInstance } from 'fastify';

import { replyError } from './http.js';

/** Configuration for {@link registerComplianceRoutes}. */
export interface ComplianceRoutesConfig {
  /** Ledger to query for evidence. Only the read interface is used. */
  readonly ledger: LedgerReader;
}

const DEFAULT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

function isFrameworkId(value: unknown): value is FrameworkId {
  return typeof value === 'string' && (FRAMEWORK_IDS as readonly string[]).includes(value);
}

/**
 * Register the compliance-report routes on a Fastify instance. Mounts:
 *
 * - `GET  /api/v1/compliance/frameworks` — list built-in framework ids.
 * - `POST /api/v1/compliance/report`     — generate an evidence + Markdown
 *   report for a framework over `[fromMs, toMs)` (defaults to the last 90
 *   days).
 */
export function registerComplianceRoutes(app: FastifyInstance, opts: ComplianceRoutesConfig): void {
  const { ledger } = opts;

  app.get('/api/v1/compliance/frameworks', async (_request, reply) => {
    return reply.send({
      frameworkIds: FRAMEWORK_IDS,
      frameworks: FRAMEWORK_IDS.map((id) => ({
        id,
        name: FRAMEWORK_TEMPLATES[id].name,
        version: FRAMEWORK_TEMPLATES[id].version,
      })),
    });
  });

  app.post('/api/v1/compliance/report', async (request, reply) => {
    const body = (request.body ?? {}) as {
      frameworkId?: unknown;
      fromMs?: unknown;
      toMs?: unknown;
    };

    if (!isFrameworkId(body.frameworkId)) {
      return replyError(
        reply,
        validationError(`frameworkId must be one of: ${FRAMEWORK_IDS.join(', ')}`),
      );
    }

    const now = Date.now();
    const toMs = typeof body.toMs === 'number' && Number.isFinite(body.toMs) ? body.toMs : now;
    const fromMs =
      typeof body.fromMs === 'number' && Number.isFinite(body.fromMs)
        ? body.fromMs
        : toMs - DEFAULT_WINDOW_MS;

    if (fromMs >= toMs) {
      return replyError(reply, validationError('fromMs must be strictly less than toMs'));
    }

    const framework = requireFramework(body.frameworkId);
    const window = { fromMs, toMs };
    const evidence = await collectEvidence(ledger, framework, window);
    const markdown = renderMarkdown(framework, evidence, { window, generatedAtMs: now });
    const scorePercent = compliancePercent(evidence);

    return reply.send({
      framework: {
        id: framework.id,
        name: framework.name,
        version: framework.version,
      },
      generatedAtMs: now,
      fromMs,
      toMs,
      evidence: evidence.map((item) => ({
        controlId: item.control.id,
        name: item.control.name,
        severity: item.control.severity,
        satisfied: item.satisfied,
        evidenceCount: item.evidenceCount,
        evidenceEventIds: item.evidenceEventIds,
        missingEventTypes: item.missingEventTypes,
      })),
      markdown,
      scorePercent,
    });
  });
}
