import type { EventType, LedgerReader } from '@veritrail/core';

import { requireFramework, type Control, type Framework } from './frameworks.js';

/**
 * Evidence assembled for one control during a report window. The
 * `evidenceEventIds` list is the auditor-verifiable claim: every id is the
 * ledger id of an event whose type matches one of the control's
 * `requiredEventTypes`. Auditors can reproduce these by re-querying the
 * ledger and confirming the hash-chain receipts.
 */
export interface ControlEvidence {
  /** The control this evidence batch was collected for. */
  readonly control: Control;
  /** Ledger event ids that satisfy this control, in sequence order. */
  readonly evidenceEventIds: readonly string[];
  /** Convenience count of `evidenceEventIds`. */
  readonly evidenceCount: number;
  /**
   * `true` when at least one event of every `requiredEventTypes` entry was
   * observed in the report window. `false` flags an auditor-visible gap.
   */
  readonly satisfied: boolean;
  /**
   * Required event types for which no matching event was observed in the
   * window. Empty when `satisfied` is `true`.
   */
  readonly missingEventTypes: readonly EventType[];
}

/**
 * The half-open report window `[fromMs, toMs)` used when collecting
 * evidence. Both bounds are epoch milliseconds against the ledger's
 * authoritative `timestamp` field, not the source `occurredAt`.
 */
export interface EvidenceWindow {
  /** Inclusive lower bound on the ledger receipt timestamp. */
  readonly fromMs: number;
  /** Exclusive upper bound on the ledger receipt timestamp. */
  readonly toMs: number;
}

/** Optional overrides for {@link collectEvidence}. */
export interface CollectEvidenceOptions {
  /** Cap on event ids returned per control. Defaults to `100`. */
  readonly perControlLimit?: number;
}

const DEFAULT_PER_CONTROL_LIMIT = 100;

/**
 * Compute the report window for a `windowMs` lookback ending at `now`. The
 * returned `[fromMs, toMs)` window is half-open: the upper bound is
 * exclusive so consecutive windows tile without overlap.
 */
export function windowEndingAt(now: number, windowMs: number): EvidenceWindow {
  const safeWindow = Math.max(0, Math.floor(windowMs));
  return { fromMs: now - safeWindow, toMs: now };
}

/**
 * Walk the ledger for the given framework and bucket matching event ids
 * under the controls that require them. Every event the ledger emits in
 * the window is read exactly once; per-control filtering is done in memory
 * because the underlying store query has no `or` over disjoint type sets.
 *
 * The result preserves the framework's control order so reports stay
 * deterministic.
 */
export async function collectEvidence(
  ledger: LedgerReader,
  frameworkOrId: Framework | string,
  window: EvidenceWindow,
  options: CollectEvidenceOptions = {},
): Promise<ControlEvidence[]> {
  const framework =
    typeof frameworkOrId === 'string' ? requireFramework(frameworkOrId) : frameworkOrId;
  const perControlLimit = options.perControlLimit ?? DEFAULT_PER_CONTROL_LIMIT;

  const neededTypes = new Set<EventType>();
  for (const control of framework.controls) {
    for (const type of control.requiredEventTypes) neededTypes.add(type);
  }

  const records =
    neededTypes.size === 0 ? [] : await ledger.query({ types: Array.from(neededTypes) });

  return framework.controls.map((control) => {
    const required = new Set<EventType>(control.requiredEventTypes);
    const seenTypes = new Set<EventType>();
    const evidenceEventIds: string[] = [];

    for (const record of records) {
      if (record.timestamp < window.fromMs || record.timestamp >= window.toMs) continue;
      if (!required.has(record.event.type)) continue;
      seenTypes.add(record.event.type);
      if (evidenceEventIds.length < perControlLimit) {
        evidenceEventIds.push(record.id);
      }
    }

    const missingEventTypes = control.requiredEventTypes.filter((type) => !seenTypes.has(type));
    const satisfied = missingEventTypes.length === 0;

    return {
      control,
      evidenceEventIds,
      evidenceCount: evidenceEventIds.length,
      satisfied,
      missingEventTypes,
    };
  });
}

/**
 * Compute an integer 0..100 compliance score over a collected evidence
 * batch. `must` controls are weighted at `3` and `should` controls at `1`,
 * so a single missing `must` is more costly than a missing `should`.
 *
 * Returns `100` when the batch is empty — an empty framework cannot fail.
 */
export function compliancePercent(evidence: readonly ControlEvidence[]): number {
  if (evidence.length === 0) return 100;
  let total = 0;
  let earned = 0;
  for (const item of evidence) {
    const weight = item.control.severity === 'must' ? 3 : 1;
    total += weight;
    if (item.satisfied) earned += weight;
  }
  if (total === 0) return 100;
  return Math.round((earned / total) * 100);
}
