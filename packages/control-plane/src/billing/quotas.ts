import { TIER_LIMITS } from '../plans.js';
import type { Organization } from '../schema.js';

/**
 * In-memory per-tenant counter that batches writes to the durable
 * `usage_meters` table. Goal: keep the `ledger.append` hot path < 1ms by
 * NOT going to Postgres on every event. The trade-off is bounded drift —
 * we may over-count for up to `flushIntervalMs` in the rare crash case.
 *
 * Public API:
 *   - `check(orgId, tier)` — returns the current usage / limit (cheap).
 *   - `record(orgId, projectId)` — increment in memory; returns whether
 *     the org is now over its hard limit (free tier only).
 *   - `flush()` — persist counts to the durable store and reset the buffer.
 */

export type UsageFlushFn = (entries: ReadonlyArray<UsageEntry>) => Promise<void>;

export interface UsageEntry {
  readonly orgId: string;
  readonly projectId: string;
  readonly count: number;
}

export interface UsageCheck {
  readonly usage: number;
  readonly limit: number;
  readonly tier: string;
  readonly overLimit: boolean;
}

export interface UsageTrackerOptions {
  readonly flush: UsageFlushFn;
  readonly flushIntervalMs?: number;
  /** Initial counts seeded from the durable store at process start. */
  readonly initial?: ReadonlyArray<{ orgId: string; projectId: string; count: number }>;
}

interface OrgCounter {
  total: number;
  byProject: Map<string, number>;
}

export class UsageTracker {
  readonly #counts = new Map<string, OrgCounter>();
  readonly #flush: UsageFlushFn;
  readonly #flushIntervalMs: number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #started = false;

  constructor(options: UsageTrackerOptions) {
    this.#flush = options.flush;
    this.#flushIntervalMs = options.flushIntervalMs ?? 30_000;
    for (const initial of options.initial ?? []) {
      this.#bump(initial.orgId, initial.projectId, initial.count);
    }
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#timer = setInterval(() => {
      void this.flush();
    }, this.#flushIntervalMs);
    // Don't keep the event loop alive just for the meter.
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#started = false;
  }

  /**
   * Record one event. Returns `false` to deny the event when the org is on
   * the free tier and over its monthly cap; `true` otherwise. Higher tiers
   * always return `true` here — overage is metered, not blocked.
   */
  record(org: Organization, projectId: string): boolean {
    const limits = TIER_LIMITS[org.tier];
    this.#bump(org.id, projectId, 1);
    if (org.tier !== 'free') return true;
    const counter = this.#counts.get(org.id);
    if (!counter) return true;
    return counter.total <= limits.eventsPerMonth;
  }

  check(org: Organization): UsageCheck {
    const limits = TIER_LIMITS[org.tier];
    const usage = this.#counts.get(org.id)?.total ?? 0;
    return {
      usage,
      limit: limits.eventsPerMonth,
      tier: org.tier,
      overLimit: usage > limits.eventsPerMonth,
    };
  }

  async flush(): Promise<void> {
    const entries: UsageEntry[] = [];
    for (const [orgId, counter] of this.#counts) {
      for (const [projectId, count] of counter.byProject) {
        if (count > 0) entries.push({ orgId, projectId, count });
      }
    }
    if (entries.length === 0) return;
    // Capture-then-reset is safer than reset-then-capture under concurrent
    // increments: if `flush` succeeds, we move the delta out; if it throws,
    // the values stay in the buffer for the next attempt.
    try {
      await this.#flush(entries);
      for (const e of entries) {
        const counter = this.#counts.get(e.orgId);
        if (!counter) continue;
        const current = counter.byProject.get(e.projectId) ?? 0;
        counter.byProject.set(e.projectId, Math.max(0, current - e.count));
        counter.total = Math.max(0, counter.total - e.count);
      }
    } catch {
      // Leave the counter in place; the next interval retries.
    }
  }

  #bump(orgId: string, projectId: string, count: number): void {
    let counter = this.#counts.get(orgId);
    if (!counter) {
      counter = { total: 0, byProject: new Map() };
      this.#counts.set(orgId, counter);
    }
    counter.total += count;
    counter.byProject.set(projectId, (counter.byProject.get(projectId) ?? 0) + count);
  }
}
