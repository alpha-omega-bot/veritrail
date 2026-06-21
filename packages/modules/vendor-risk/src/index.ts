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

import { computeScore, type RiskBand, type VendorRiskScore } from './scoring.js';

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

/** Construction-time options for {@link VendorRiskModule}. */
export interface VendorRiskConfig {
  /**
   * When set, recording a signal that raises a vendor's time-decayed score
   * *up* across this band (i.e. the vendor was below it before the signal and
   * at/above it after) appends a `note` alert fact to the ledger. Unset (the
   * default) disables alerting entirely. See {@link VendorRiskModule.recordSignal}.
   */
  readonly alertBand?: RiskBand;
  /** Thresholds for {@link VendorRiskModule.slaReport}. Defaults apply per field. */
  readonly sla?: SlaConfig;
}

/** Rank of each risk band, lowest to highest, for threshold comparisons. */
const BAND_RANK: Record<RiskBand, number> = { low: 0, medium: 1, high: 2, critical: 3 };

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

/** Thresholds for {@link VendorRiskModule.slaReport}. */
export interface SlaConfig {
  /** Look-back window in ms over which availability signals are counted. Default 30 days. */
  readonly windowMs?: number;
  /** `at_risk` once this many availability signals fall in the window. Default 1. */
  readonly atRiskAfter?: number;
  /** `breaching` once this many fall in the window. Default 3. */
  readonly breachAfter?: number;
}

/** SLA standing derived from recent availability signals. */
export type SlaStatus = 'ok' | 'at_risk' | 'breaching';

/** An availability/SLA assessment for one vendor over a window. */
export interface SlaReport {
  readonly vendorId: string;
  readonly status: SlaStatus;
  /** Number of `availability`-kind signals within the window. */
  readonly availabilitySignals: number;
  /** Count of those signals at `high` or `critical` severity. */
  readonly severeSignals: number;
  /** Window length in ms the report covers. */
  readonly windowMs: number;
}

const DAY_MS = 86_400_000;
const SLA_DEFAULTS = { windowMs: 30 * DAY_MS, atRiskAfter: 1, breachAfter: 3 } as const;

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
  readonly #alertBand: RiskBand | undefined;
  readonly #sla: Required<SlaConfig>;

  constructor(ctx: ModuleContext, config?: VendorRiskConfig) {
    this.#ctx = ctx;
    this.#alertBand = config?.alertBand;
    this.#sla = {
      windowMs: config?.sla?.windowMs ?? SLA_DEFAULTS.windowMs,
      atRiskAfter: config?.sla?.atRiskAfter ?? SLA_DEFAULTS.atRiskAfter,
      breachAfter: config?.sla?.breachAfter ?? SLA_DEFAULTS.breachAfter,
    };
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
   *
   * When an `alertBand` is configured and this signal raises the vendor's
   * time-decayed score *up* across that band (below it before the signal,
   * at/above it after — both computed at the same instant), a `note` alert fact
   * is appended after the signal. Alerting is best-effort: a failed alert append
   * is logged but does not fail the signal recording, and the returned record is
   * always the `vendor.signal` append.
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
    const appended = await this.#ctx.ledger.append({
      type: 'vendor.signal',
      actorId: this.info.name,
      ...(opts?.labels !== undefined ? { labels: opts.labels } : {}),
      payload: { signal },
    });

    if (appended.ok && this.#alertBand !== undefined) {
      await this.#maybeAlertOnCrossing(signal, this.#alertBand, opts);
    }

    return appended;
  }

  /**
   * If recording `signal` pushed the vendor's score up across `alertBand`,
   * append a `note` documenting the crossing. Pure projection: the before/after
   * scores are recomputed from signal history at one clock instant, so no state
   * is held outside the ledger. Best-effort — failures are logged, not thrown.
   */
  async #maybeAlertOnCrossing(
    signal: VendorSignal,
    alertBand: RiskBand,
    opts?: VendorRiskRecordOptions,
  ): Promise<void> {
    const vendors = await this.listVendors(opts);
    const vendor = vendors.find((v) => v.id === signal.vendorId);
    if (!vendor) return; // signal for an unregistered vendor — nothing to score.

    const now = this.#ctx.clock.now();
    const after = await this.#signalRecordsFor(signal.vendorId, opts);
    const before = after.filter((s) => s.signal.id !== signal.id);

    const bandBefore = computeScore(vendor, before, now).band;
    const scoreAfter = computeScore(vendor, after, now);
    const threshold = BAND_RANK[alertBand];

    // Fire only on an upward crossing of the threshold (edge-triggered), so a
    // vendor already in-band does not re-alert on every subsequent signal.
    if (BAND_RANK[bandBefore] >= threshold || BAND_RANK[scoreAfter.band] < threshold) {
      return;
    }

    const text =
      `Vendor ${vendor.name} (${vendor.id}) crossed into risk band ` +
      `'${scoreAfter.band}' (score ${scoreAfter.score}) on signal ${signal.id}`;
    const alert = await this.#ctx.ledger.append({
      type: 'note',
      actorId: this.info.name,
      ...(opts?.labels !== undefined ? { labels: opts.labels } : {}),
      payload: {
        text,
        data: {
          kind: 'vendor-risk.alert',
          vendorId: vendor.id,
          signalId: signal.id,
          fromBand: bandBefore,
          toBand: scoreAfter.band,
          alertBand,
          score: scoreAfter.score,
        },
      },
    });
    if (!alert.ok) {
      this.#ctx.logger.warn('vendor-risk alert note failed to append', {
        vendorId: vendor.id,
        reason: alert.error.message,
      });
    }
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

  /**
   * Assess a vendor's availability SLA standing from its recent `availability`
   * signals. Counts availability-kind signals within the configured window
   * (from `now` backward) and maps the count to `ok` / `at_risk` / `breaching`
   * via the configured thresholds. Returns `NOT_FOUND` for an unknown vendor;
   * tenant-scoped via `opts`.
   *
   * Note: this tracks discrete availability *signals* against thresholds, not a
   * literal uptime percentage — raw uptime requires the (deferred) real monitor
   * feeds.
   */
  async slaReport(
    vendorId: string,
    opts?: VendorRiskProjectionOptions,
  ): Promise<Result<SlaReport, VeritrailError>> {
    const vendors = await this.listVendors(opts);
    if (!vendors.some((v) => v.id === vendorId)) {
      return err(notFoundError(`unknown vendor: ${vendorId}`, { vendorId }));
    }

    const now = this.#ctx.clock.now();
    const cutoff = now - this.#sla.windowMs;
    let availabilitySignals = 0;
    let severeSignals = 0;
    for (const { signal, timestamp } of await this.#signalRecordsFor(vendorId, opts)) {
      if (signal.kind !== 'availability' || timestamp < cutoff) continue;
      availabilitySignals += 1;
      if (signal.severity === 'high' || signal.severity === 'critical') severeSignals += 1;
    }

    let status: SlaStatus = 'ok';
    if (availabilitySignals >= this.#sla.breachAfter) status = 'breaching';
    else if (availabilitySignals >= this.#sla.atRiskAfter) status = 'at_risk';

    return ok({
      vendorId,
      status,
      availabilitySignals,
      severeSignals,
      windowMs: this.#sla.windowMs,
    });
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
export function createVendorRiskModule(
  ctx: ModuleContext,
  config?: VendorRiskConfig,
): VendorRiskModule {
  return new VendorRiskModule(ctx, config);
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
