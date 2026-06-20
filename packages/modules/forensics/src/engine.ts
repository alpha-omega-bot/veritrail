import type { EventQuery, LedgerRecord, ModuleContext, VeritrailModule } from '@veritrail/core';

import { summarize } from './summarize.js';

/** Optional projection filters for forensic reads. */
export interface ForensicsProjectionOptions {
  /** Restrict the projection to records carrying these exact ledger labels. */
  readonly labels?: Readonly<Record<string, string>>;
}

/** Does a record carry every one of the given exact labels? */
function recordHasLabels(
  record: LedgerRecord,
  labels: Readonly<Record<string, string>> | undefined,
): boolean {
  if (labels === undefined) return true;
  return Object.entries(labels).every(([key, value]) => record.event.labels[key] === value);
}

/** A single event projected into a compact, presentation-ready timeline row. */
export interface TimelineEntry {
  /** Ledger sequence number (stable, monotonic ordering key). */
  readonly seq: number;
  /** Authoritative ledger receipt timestamp (epoch ms). */
  readonly at: number;
  /** The event type, e.g. `action.executed`. */
  readonly type: string;
  /** The actor that caused the event. */
  readonly actorId: string;
  /** A short human-readable description of the event. */
  readonly summary: string;
}

/**
 * An aggregated forensic view of a single correlation (run / incident / trace):
 * the ordered timeline plus rolled-up counts useful for triage.
 */
export interface IncidentReport {
  readonly correlationId: string;
  /** Seq-ordered timeline of every event in the correlation. */
  readonly entries: TimelineEntry[];
  /** Distinct actors that appear, in first-seen order. */
  readonly actors: string[];
  /** Number of events by event type. */
  readonly counts: Record<string, number>;
  /** Count of `action.failed` events. */
  readonly failures: number;
  /** Count of `action.denied` events. */
  readonly denials: number;
  /** Count of `action.rolled_back` events. */
  readonly rollbacks: number;
  /** Timestamp of the earliest event, or null when empty. */
  readonly firstAt: number | null;
  /** Timestamp of the latest event, or null when empty. */
  readonly lastAt: number | null;
}

function toTimelineEntry(record: LedgerRecord): TimelineEntry {
  return {
    seq: record.seq,
    at: record.timestamp,
    type: record.event.type,
    actorId: record.event.actorId,
    summary: summarize(record.event),
  };
}

/**
 * Incident Forensics engine (scaffold baseline).
 *
 * A read-only projection over the ledger that reconstructs incident timelines
 * and causal chains. It owns no separate store: every method derives its answer
 * from ledger records on demand.
 */
export class ForensicsModule implements VeritrailModule {
  readonly info = {
    name: '@veritrail/forensics',
    version: '0.1.0',
    capability: 'forensics' as const,
  };

  readonly #ctx: ModuleContext;

  constructor(ctx: ModuleContext) {
    this.#ctx = ctx;
  }

  /**
   * Aggregate every event sharing a `correlationId` into an {@link IncidentReport}:
   * a seq-ordered timeline plus rolled-up counts (failures, denials, rollbacks),
   * distinct actors, and the first/last timestamps.
   */
  async incident(
    correlationId: string,
    opts?: ForensicsProjectionOptions,
  ): Promise<IncidentReport> {
    const records = await this.#ctx.ledger.query({
      correlationId,
      ...(opts?.labels !== undefined ? { labels: opts.labels } : {}),
    });

    const entries: TimelineEntry[] = [];
    const counts: Record<string, number> = {};
    const actors: string[] = [];
    const seenActors = new Set<string>();
    let failures = 0;
    let denials = 0;
    let rollbacks = 0;
    let firstAt: number | null = null;
    let lastAt: number | null = null;

    for (const record of records) {
      entries.push(toTimelineEntry(record));

      const type = record.event.type;
      counts[type] = (counts[type] ?? 0) + 1;

      if (type === 'action.failed') failures += 1;
      else if (type === 'action.denied') denials += 1;
      else if (type === 'action.rolled_back') rollbacks += 1;

      const actorId = record.event.actorId;
      if (!seenActors.has(actorId)) {
        seenActors.add(actorId);
        actors.push(actorId);
      }

      if (firstAt === null || record.timestamp < firstAt) firstAt = record.timestamp;
      if (lastAt === null || record.timestamp > lastAt) lastAt = record.timestamp;
    }

    this.#ctx.logger.debug('forensics.incident', {
      correlationId,
      events: entries.length,
      failures,
      denials,
      rollbacks,
    });

    return {
      correlationId,
      entries,
      actors,
      counts,
      failures,
      denials,
      rollbacks,
      firstAt,
      lastAt,
    };
  }

  /**
   * Project an arbitrary ledger query into a seq-ordered list of
   * {@link TimelineEntry} rows.
   */
  async timeline(query: EventQuery): Promise<TimelineEntry[]> {
    const records = await this.#ctx.ledger.query(query);
    return records.map(toTimelineEntry);
  }

  /**
   * Walk the causal chain ending at `causationId`, oldest -> newest.
   *
   * Starting from the record whose `id === causationId`, repeatedly hop to the
   * record named by that record's `event.causationId`, prepending each as it is
   * found. Stops when a link is missing or a cycle is detected, so the result is
   * always finite and acyclic.
   */
  async causeChain(
    causationId: string,
    opts?: ForensicsProjectionOptions,
  ): Promise<LedgerRecord[]> {
    const records = await this.#ctx.ledger.readAll();
    const byId = new Map<string, LedgerRecord>();
    for (const record of records) {
      // Out-of-scope records are not indexed, so a hop into another tenant's
      // record is treated as a missing link and the chain truncates at the
      // boundary rather than leaking cross-tenant causation.
      if (recordHasLabels(record, opts?.labels)) byId.set(record.id, record);
    }

    const chain: LedgerRecord[] = [];
    const visited = new Set<string>();
    let currentId: string | undefined = causationId;

    while (currentId !== undefined && !visited.has(currentId)) {
      const record = byId.get(currentId);
      if (!record) break;
      visited.add(currentId);
      chain.unshift(record);
      currentId = record.event.causationId;
    }

    return chain;
  }
}

/** Construct a {@link ForensicsModule} from a module context. */
export function createForensicsModule(ctx: ModuleContext): ForensicsModule {
  return new ForensicsModule(ctx);
}
