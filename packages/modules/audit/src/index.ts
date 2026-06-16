/**
 * `@veritrail/audit` — the Audit & Integrity engine.
 *
 * Audit is a pure projection over the single tamper-evident ledger. It never
 * keeps its own store: every method reads the same {@link Ledger} that backs
 * the rest of the platform. It exposes search/get/timeline projections, the
 * ledger's integrity verification, an aggregate {@link AuditSummary}, and an
 * NDJSON export for offline analysis or external anchoring.
 */

import type {
  EventQuery,
  IntegrityReport,
  LedgerRecord,
  ModuleContext,
  VeritrailModule,
} from '@veritrail/core';

/**
 * A compact, single-pass summary of the entire ledger: how many records, the
 * current chain head, whether integrity holds, a histogram of event types, the
 * number of distinct actors, and the first/last record timestamps.
 */
export interface AuditSummary {
  /** Total number of records in the ledger. */
  readonly totalRecords: number;
  /** Hash of the chain head, or `null` when the ledger is empty. */
  readonly head: string | null;
  /** True when {@link IntegrityReport.ok} holds for the whole chain. */
  readonly integrityOk: boolean;
  /** Histogram of records keyed by `event.type`. */
  readonly countsByType: Record<string, number>;
  /** Number of distinct `event.actorId` values seen. */
  readonly actorCount: number;
  /** Timestamp (epoch ms) of the first record, or `null` when empty. */
  readonly firstAt: number | null;
  /** Timestamp (epoch ms) of the last record, or `null` when empty. */
  readonly lastAt: number | null;
}

/**
 * Audit & Integrity engine.
 *
 * All read methods delegate to `ctx.ledger`; the module adds the aggregation
 * ({@link AuditModule.summary}), the correlation-scoped {@link AuditModule.timeline},
 * and the {@link AuditModule.exportNdjson} serializer on top of those reads.
 */
export class AuditModule implements VeritrailModule {
  readonly info = {
    name: '@veritrail/audit',
    version: '0.1.0',
    capability: 'audit' as const,
  };

  readonly #ctx: ModuleContext;

  constructor(ctx: ModuleContext) {
    this.#ctx = ctx;
  }

  /** Query the ledger with the standard {@link EventQuery} filter (seq order). */
  async search(query: EventQuery): Promise<LedgerRecord[]> {
    return this.#ctx.ledger.query(query);
  }

  /** Fetch a single record by its sequence number, or `null` if absent. */
  async get(seq: number): Promise<LedgerRecord | null> {
    return this.#ctx.ledger.getBySeq(seq);
  }

  /**
   * All records sharing a correlation id, in sequence order — the audit trail
   * for one run/incident/trace.
   */
  async timeline(correlationId: string): Promise<LedgerRecord[]> {
    return this.#ctx.ledger.query({ correlationId });
  }

  /** Verify the integrity of the entire chain (delegates to the ledger). */
  async verify(): Promise<IntegrityReport> {
    return this.#ctx.ledger.verify();
  }

  /**
   * Aggregate the whole ledger into an {@link AuditSummary}. Reads every record
   * once for the histogram/actor/time bounds and runs one integrity pass.
   */
  async summary(): Promise<AuditSummary> {
    const records = await this.#ctx.ledger.readAll();
    const report = await this.#ctx.ledger.verify();

    const countsByType: Record<string, number> = {};
    const actors = new Set<string>();
    let firstAt: number | null = null;
    let lastAt: number | null = null;

    for (const record of records) {
      const { type, actorId } = record.event;
      countsByType[type] = (countsByType[type] ?? 0) + 1;
      actors.add(actorId);
      if (firstAt === null || record.timestamp < firstAt) {
        firstAt = record.timestamp;
      }
      if (lastAt === null || record.timestamp > lastAt) {
        lastAt = record.timestamp;
      }
    }

    this.#ctx.logger.debug('audit.summary', {
      totalRecords: records.length,
      integrityOk: report.ok,
    });

    return {
      totalRecords: records.length,
      head: report.head,
      integrityOk: report.ok,
      countsByType,
      actorCount: actors.size,
      firstAt,
      lastAt,
    };
  }

  /**
   * Export the ledger as newline-delimited JSON: one `JSON.stringify(record)`
   * per line, in sequence order. There is no trailing newline. Each line
   * round-trips back to a {@link LedgerRecord} via `JSON.parse`.
   */
  async exportNdjson(): Promise<string> {
    const records = await this.#ctx.ledger.readAll();
    return records.map((record) => JSON.stringify(record)).join('\n');
  }
}

/** Construct an {@link AuditModule} from a {@link ModuleContext}. */
export function createAuditModule(ctx: ModuleContext): AuditModule {
  return new AuditModule(ctx);
}
