import {
  VendorSchema,
  VendorSignalSchema,
  err,
  notFoundError,
  ok,
  validationError,
  type EventQuery,
  type LedgerRecord,
  type ModuleContext,
  type Result,
  type Vendor,
  type VendorSignal,
  type VeritrailError,
  type VeritrailModule,
} from '@veritrail/core';
import type { ZodError } from 'zod';

import { computeScore, type VendorRiskScore } from './scoring.js';

export type { RiskBand, VendorRiskScore } from './scoring.js';
export { bandFor } from './scoring.js';

/**
 * A pluggable feed of vendor risk observations (status page, CVE feed, analyst,
 * etc.). Implementations return freshly polled signals; the module records them.
 */
export interface MonitorSource {
  readonly name: string;
  poll(): Promise<VendorSignal[]>;
}

/** Optional ledger envelope values for vendor facts. */
export interface VendorRiskRecordOptions {
  /** Labels to write onto `vendor.registered` / `vendor.signal` event envelopes. */
  readonly labels?: Readonly<Record<string, string>>;
}

/** Optional projection filters for vendor risk reads. */
export interface VendorRiskProjectionOptions {
  /** Restrict reads to vendor risk records carrying these exact ledger labels. */
  readonly labels?: Readonly<Record<string, string>>;
}

/**
 * Vendor Risk engine — a projection over the shared ledger.
 *
 * Vendors and their risk signals are appended as `vendor.registered` and
 * `vendor.signal` events; scoring, listing, and assessment are computed by
 * replaying that one stream. There is no separate store.
 */
export class VendorRiskModule implements VeritrailModule {
  readonly info = {
    name: '@veritrail/vendor-risk',
    version: '0.1.0',
    capability: 'vendor-risk' as const,
  };

  readonly #ctx: ModuleContext;

  constructor(ctx: ModuleContext) {
    this.#ctx = ctx;
  }

  /**
   * Register a third party in the inventory. Assigns an id (`ven…`) when absent,
   * validates against `VendorSchema`, and appends a `vendor.registered` event.
   */
  async register(
    input: unknown,
    opts?: VendorRiskRecordOptions,
  ): Promise<Result<LedgerRecord, VeritrailError>> {
    const withId = this.#withId(input, 'ven');
    const parsed = VendorSchema.safeParse(withId);
    if (!parsed.success) {
      return err(this.#zodError('invalid vendor', parsed.error));
    }
    const vendor = parsed.data;
    this.#ctx.logger.debug('registering vendor', { vendorId: vendor.id });
    return this.#ctx.ledger.append({
      type: 'vendor.registered',
      actorId: this.info.name,
      ...(opts?.labels !== undefined ? { labels: opts.labels } : {}),
      payload: { vendor },
    });
  }

  /**
   * Record a risk observation about a vendor. Assigns an id (`sig…`) when absent,
   * validates against `VendorSignalSchema`, and appends a `vendor.signal` event.
   */
  async recordSignal(
    input: unknown,
    opts?: VendorRiskRecordOptions,
  ): Promise<Result<LedgerRecord, VeritrailError>> {
    const withId = this.#withId(input, 'sig');
    const parsed = VendorSignalSchema.safeParse(withId);
    if (!parsed.success) {
      return err(this.#zodError('invalid vendor signal', parsed.error));
    }
    const signal = parsed.data;
    this.#ctx.logger.debug('recording vendor signal', {
      vendorId: signal.vendorId,
      signalId: signal.id,
    });
    return this.#ctx.ledger.append({
      type: 'vendor.signal',
      actorId: this.info.name,
      ...(opts?.labels !== undefined ? { labels: opts.labels } : {}),
      payload: { signal },
    });
  }

  /** Project the current vendor inventory from the ledger. */
  async listVendors(opts?: VendorRiskProjectionOptions): Promise<Vendor[]> {
    const records = await this.#ctx.ledger.query(vendorQuery(['vendor.registered'], opts));
    const byId = new Map<string, Vendor>();
    for (const record of records) {
      if (record.event.type !== 'vendor.registered') continue;
      const { vendor } = record.event.payload;
      byId.set(vendor.id, vendor);
    }
    return [...byId.values()];
  }

  /** All signals recorded for a vendor, in ledger order. */
  async signalsFor(vendorId: string, opts?: VendorRiskProjectionOptions): Promise<VendorSignal[]> {
    const records = await this.#ctx.ledger.query(vendorQuery(['vendor.signal'], opts));
    const out: VendorSignal[] = [];
    for (const record of records) {
      if (record.event.type !== 'vendor.signal') continue;
      const { signal } = record.event.payload;
      if (signal.vendorId === vendorId) out.push(signal);
    }
    return out;
  }

  /** Compute the time-decayed risk score for one vendor. NOT_FOUND if unknown. */
  async score(
    vendorId: string,
    opts?: VendorRiskProjectionOptions,
  ): Promise<Result<VendorRiskScore, VeritrailError>> {
    const vendors = await this.listVendors(opts);
    const vendor = vendors.find((v) => v.id === vendorId);
    if (!vendor) {
      return err(notFoundError(`unknown vendor: ${vendorId}`, { vendorId }));
    }
    const signals = await this.#signalRecordsFor(vendorId, opts);
    return ok(computeScore(vendor, signals, this.#ctx.clock.now()));
  }

  /** Score every vendor, sorted by score descending (riskiest first). */
  async assess(opts?: VendorRiskProjectionOptions): Promise<VendorRiskScore[]> {
    const vendors = await this.listVendors(opts);
    const now = this.#ctx.clock.now();
    const scores: VendorRiskScore[] = [];
    for (const vendor of vendors) {
      const signals = await this.#signalRecordsFor(vendor.id, opts);
      scores.push(computeScore(vendor, signals, now));
    }
    return scores.sort((a, b) => b.score - a.score);
  }

  /** Poll a monitor source and record every signal it returns. Returns the count. */
  async ingest(source: MonitorSource): Promise<number> {
    const signals = await source.poll();
    let recorded = 0;
    for (const signal of signals) {
      const result = await this.recordSignal(signal);
      if (result.ok) {
        recorded += 1;
      } else {
        this.#ctx.logger.warn('ingest skipped invalid signal', {
          source: source.name,
          reason: result.error.message,
        });
      }
    }
    return recorded;
  }

  /** Signals for a vendor paired with their authoritative ledger timestamps. */
  async #signalRecordsFor(
    vendorId: string,
    opts?: VendorRiskProjectionOptions,
  ): Promise<Array<{ signal: VendorSignal; timestamp: number }>> {
    const records = await this.#ctx.ledger.query(vendorQuery(['vendor.signal'], opts));
    const out: Array<{ signal: VendorSignal; timestamp: number }> = [];
    for (const record of records) {
      if (record.event.type !== 'vendor.signal') continue;
      const { signal } = record.event.payload;
      if (signal.vendorId === vendorId) {
        out.push({ signal, timestamp: record.timestamp });
      }
    }
    return out;
  }

  /** Assign an id to an object input when one is absent. */
  #withId(input: unknown, prefix: string): unknown {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return input;
    }
    const obj = input as Record<string, unknown>;
    if (obj['id'] !== undefined) return input;
    return { ...obj, id: this.#ctx.ids.next(prefix) };
  }

  /** Wrap a Zod parse failure as a VALIDATION error with structured details. */
  #zodError(message: string, error: ZodError): VeritrailError {
    const issues = error.issues.map((issue) => ({
      path: issue.path.map((segment) => String(segment)).join('.'),
      message: issue.message,
    }));
    return validationError(message, { issues });
  }
}

/** Construct a {@link VendorRiskModule} bound to a module context. */
export function createVendorRiskModule(ctx: ModuleContext): VendorRiskModule {
  return new VendorRiskModule(ctx);
}

function vendorQuery(
  types: NonNullable<EventQuery['types']>,
  opts?: VendorRiskProjectionOptions,
): EventQuery {
  return {
    types,
    ...(opts?.labels !== undefined ? { labels: opts.labels } : {}),
  };
}
