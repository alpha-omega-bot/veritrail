import {
  err,
  notFoundError,
  ok,
  type EventQuery,
  type LedgerRecord,
  type ModuleContext,
  type Result,
  type VeritrailError,
  type VeritrailModule,
} from '@veritrail/core';

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

/**
 * The forward "blast radius" of a root event: everything its effects reached by
 * following `causationId` edges downstream (the complement of
 * {@link ForensicsModule.causeChain}, which walks upstream).
 */
export interface BlastRadiusReport {
  /** The id of the root event the radius was computed from. */
  readonly rootId: string;
  /** Seq-ordered timeline of the root plus every causally-downstream event. */
  readonly entries: TimelineEntry[];
  /** Distinct actors touched within the radius, in first-seen order. */
  readonly actors: string[];
  /** Distinct correlation ids touched within the radius, in first-seen order. */
  readonly correlations: string[];
  /** Number of impacted events excluding the root. */
  readonly impactedCount: number;
  /** Count of `action.failed` events within the radius. */
  readonly failures: number;
  /** Count of `action.denied` events within the radius. */
  readonly denials: number;
  /** Count of `action.rolled_back` events within the radius. */
  readonly rollbacks: number;
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

  /**
   * Compute the forward "blast radius" of a root event: the root plus every
   * event causally downstream of it, reached by following `causationId` edges
   * *forward* (a record `c` is downstream of `p` when `c.event.causationId ===
   * p.id`). This is the complement of {@link causeChain}, which walks upstream.
   *
   * Returns a triage-shaped {@link BlastRadiusReport}: the seq-ordered impacted
   * timeline, the distinct actors and correlations touched, and failure/denial/
   * rollback counts within the radius. Traversal is breadth-first with a visited
   * guard, so it is finite and acyclic. Out-of-scope records (per `opts.labels`)
   * are not indexed, so the radius truncates at the tenant boundary. Returns
   * `NOT_FOUND` when the root event does not exist (in scope).
   */
  async blastRadius(
    rootId: string,
    opts?: ForensicsProjectionOptions,
  ): Promise<Result<BlastRadiusReport, VeritrailError>> {
    const records = await this.#ctx.ledger.readAll();

    const byId = new Map<string, LedgerRecord>();
    const children = new Map<string, LedgerRecord[]>();
    for (const record of records) {
      if (!recordHasLabels(record, opts?.labels)) continue; // out-of-scope: invisible.
      byId.set(record.id, record);
      const parentId = record.event.causationId;
      if (parentId !== undefined) {
        const siblings = children.get(parentId);
        if (siblings) siblings.push(record);
        else children.set(parentId, [record]);
      }
    }

    if (!byId.has(rootId)) {
      return err(notFoundError(`event not found: ${rootId}`, { rootId }));
    }

    // BFS forward over causation edges; `enqueued` guards against cycles and
    // re-processing a node reachable by multiple paths.
    const reached: LedgerRecord[] = [];
    const enqueued = new Set<string>([rootId]);
    const queue: string[] = [rootId];
    for (let head = 0; head < queue.length; head += 1) {
      const id = queue[head]!;
      const record = byId.get(id);
      if (!record) continue;
      reached.push(record);
      for (const child of children.get(id) ?? []) {
        if (!enqueued.has(child.id)) {
          enqueued.add(child.id);
          queue.push(child.id);
        }
      }
    }

    reached.sort((a, b) => a.seq - b.seq);

    const entries: TimelineEntry[] = [];
    const actors: string[] = [];
    const seenActors = new Set<string>();
    const correlations: string[] = [];
    const seenCorrelations = new Set<string>();
    let failures = 0;
    let denials = 0;
    let rollbacks = 0;

    for (const record of reached) {
      entries.push(toTimelineEntry(record));

      const type = record.event.type;
      if (type === 'action.failed') failures += 1;
      else if (type === 'action.denied') denials += 1;
      else if (type === 'action.rolled_back') rollbacks += 1;

      const actorId = record.event.actorId;
      if (!seenActors.has(actorId)) {
        seenActors.add(actorId);
        actors.push(actorId);
      }

      const correlationId = record.event.correlationId;
      if (correlationId !== undefined && !seenCorrelations.has(correlationId)) {
        seenCorrelations.add(correlationId);
        correlations.push(correlationId);
      }
    }

    this.#ctx.logger.debug('forensics.blastRadius', {
      rootId,
      impacted: entries.length - 1,
      failures,
      denials,
      rollbacks,
    });

    return ok({
      rootId,
      entries,
      actors,
      correlations,
      impactedCount: entries.length - 1,
      failures,
      denials,
      rollbacks,
    });
  }
}

/** Construct a {@link ForensicsModule} from a module context. */
export function createForensicsModule(ctx: ModuleContext): ForensicsModule {
  return new ForensicsModule(ctx);
}
