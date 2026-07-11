import type {
  Action,
  EventInput,
  EventQuery,
  LedgerReader,
  LedgerRecord,
  Policy,
  PolicyEffect,
} from '@veritrail/core';
import { createPermissionsModule, type PermissionsConfig } from '@veritrail/permissions';

/** What a single replay step produced. */
export interface ReplayDecision {
  readonly seq: number;
  readonly recordId: string;
  readonly actorId: string;
  readonly action: Action;
  readonly originalEffect: PolicyEffect | 'unknown';
  readonly originalMatchedPolicyId?: string;
  readonly proposedEffect: PolicyEffect;
  readonly proposedMatchedPolicyId?: string;
  /** True when the original and proposed decisions differ. */
  readonly changed: boolean;
}

export interface ReplayDiff {
  readonly nowAllow_thenDeny: number;
  readonly nowDeny_thenAllow: number;
  readonly nowAllow_thenApproval: number;
  readonly nowDeny_thenApproval: number;
  readonly nowApproval_thenAllow: number;
  readonly nowApproval_thenDeny: number;
  readonly unchanged: number;
}

export interface BlastRadius {
  /** Distinct actors whose decisions changed. */
  readonly affectedActors: ReadonlyArray<string>;
  /** Distinct action types whose decisions changed. */
  readonly affectedActionTypes: ReadonlyArray<string>;
  /** Total events replayed. */
  readonly eventsReplayed: number;
  /** Events whose decision changed. */
  readonly eventsChanged: number;
  /** changed / replayed (0..1). */
  readonly changeRate: number;
}

export interface SimulationResult {
  readonly decisions: ReadonlyArray<ReplayDecision>;
  readonly diff: ReplayDiff;
  readonly blastRadius: BlastRadius;
  /** New deny decisions become breaking changes for ongoing workflows. */
  readonly newlyDeniedSamples: ReadonlyArray<ReplayDecision>;
}

export interface SimulateOptions {
  /** The historical ledger to replay against. */
  readonly ledger: LedgerReader;
  /** The proposed policy set. */
  readonly proposedPolicies: ReadonlyArray<Policy>;
  /** Optional configuration matching the production permissions engine. */
  readonly permissionsConfig?: PermissionsConfig;
  /** Optional ledger query window (fromSeq/toSeq/labels). */
  readonly window?: EventQuery;
  /** How many denied-changed samples to retain (default 20). */
  readonly sampleSize?: number;
}

/**
 * Replay the proposed policy set against historical `action.proposed` records.
 *
 * Why `action.proposed`?
 *   - Every action enters the ledger as "proposed" *before* the original
 *     permissions check; `action.authorized` and `action.denied` are the
 *     outcome events that capture the decision. To answer "what would
 *     the new policy do?", we need the input (the action) and a way to
 *     find the original outcome — both keyed by the proposing record's id.
 */
export async function simulatePolicies(options: SimulateOptions): Promise<SimulationResult> {
  const { ledger, proposedPolicies, permissionsConfig, window } = options;
  const sampleSize = options.sampleSize ?? 20;

  // Build a one-shot permissions module loaded with the proposed policies.
  // We don't use the production module's enforce() — we want a pure dry-run.
  interface NoopLogger {
    debug(): void;
    info(): void;
    warn(): void;
    error(): void;
    child(): NoopLogger;
  }
  const noopLogger: NoopLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return noopLogger;
    },
  };
  const dryRun = createPermissionsModule(
    {
      // The simulator never appends to a ledger. Provide a minimal stub.
      ledger: {} as never,
      clock: { now: () => 0 },
      ids: { next: () => 'sim' },
      logger: noopLogger,
    },
    permissionsConfig,
  );
  for (const policy of proposedPolicies) {
    const added = dryRun.addPolicy(policy);
    if (!added.ok) {
      throw new Error(`invalid proposed policy: ${added.error.message}`);
    }
  }

  // Pull historical records relevant to permission decisions.
  const proposed = await ledger.query({
    ...(window ?? {}),
    types: ['action.proposed'],
  });
  const authorizedById = new Map<string, LedgerRecord>();
  const deniedById = new Map<string, LedgerRecord>();
  const authorized = await ledger.query({ ...(window ?? {}), types: ['action.authorized'] });
  for (const r of authorized) {
    const event = r.event as EventInput;
    if (event.type === 'action.authorized') {
      authorizedById.set(event.payload.actionId, r);
    }
  }
  const denied = await ledger.query({ ...(window ?? {}), types: ['action.denied'] });
  for (const r of denied) {
    const event = r.event as EventInput;
    if (event.type === 'action.denied') {
      deniedById.set(event.payload.actionId, r);
    }
  }

  const decisions: ReplayDecision[] = [];
  const diff: Record<keyof ReplayDiff, number> = {
    nowAllow_thenDeny: 0,
    nowDeny_thenAllow: 0,
    nowAllow_thenApproval: 0,
    nowDeny_thenApproval: 0,
    nowApproval_thenAllow: 0,
    nowApproval_thenDeny: 0,
    unchanged: 0,
  };
  const affectedActors = new Set<string>();
  const affectedActionTypes = new Set<string>();
  const newlyDeniedSamples: ReplayDecision[] = [];

  for (const record of proposed) {
    const event = record.event as EventInput;
    if (event.type !== 'action.proposed') continue;
    const action = event.payload.action;
    const actorId = event.actorId;

    const originalEffect = originalEffectFor(event.payload.action.id, authorizedById, deniedById);
    const originalMatchedPolicyId = originalMatched(
      event.payload.action.id,
      authorizedById,
      deniedById,
    );
    const proposedDecision = dryRun.evaluate(action, {
      actor: { id: actorId, kind: 'agent', name: actorId, labels: {} },
    });

    const changed = originalEffect !== proposedDecision.effect;
    const replay: ReplayDecision = {
      seq: record.seq,
      recordId: record.id,
      actorId,
      action,
      originalEffect,
      ...(originalMatchedPolicyId !== undefined ? { originalMatchedPolicyId } : {}),
      proposedEffect: proposedDecision.effect,
      ...(proposedDecision.matchedPolicyId !== undefined
        ? { proposedMatchedPolicyId: proposedDecision.matchedPolicyId }
        : {}),
      changed,
    };
    decisions.push(replay);

    if (!changed) {
      diff.unchanged += 1;
    } else {
      affectedActors.add(actorId);
      affectedActionTypes.add(action.type);
      diff[bucket(originalEffect, proposedDecision.effect)] += 1;
      if (proposedDecision.effect === 'deny' && originalEffect !== 'deny') {
        if (newlyDeniedSamples.length < sampleSize) newlyDeniedSamples.push(replay);
      }
    }
  }

  const eventsReplayed = decisions.length;
  const eventsChanged = eventsReplayed - diff.unchanged;
  return {
    decisions,
    diff,
    blastRadius: {
      affectedActors: [...affectedActors].sort(),
      affectedActionTypes: [...affectedActionTypes].sort(),
      eventsReplayed,
      eventsChanged,
      changeRate: eventsReplayed === 0 ? 0 : eventsChanged / eventsReplayed,
    },
    newlyDeniedSamples,
  };
}

function originalEffectFor(
  actionId: string,
  authorizedById: Map<string, LedgerRecord>,
  deniedById: Map<string, LedgerRecord>,
): PolicyEffect | 'unknown' {
  if (authorizedById.has(actionId)) return 'allow';
  if (deniedById.has(actionId)) return 'deny';
  return 'unknown';
}

function originalMatched(
  actionId: string,
  authorizedById: Map<string, LedgerRecord>,
  deniedById: Map<string, LedgerRecord>,
): string | undefined {
  const record = authorizedById.get(actionId) ?? deniedById.get(actionId);
  if (!record) return undefined;
  const event = record.event as EventInput;
  if (event.type === 'action.authorized') return event.payload.policyId;
  if (event.type === 'action.denied') return event.payload.policyId;
  return undefined;
}

function bucket(
  original: PolicyEffect | 'unknown',
  proposed: PolicyEffect,
): keyof Omit<ReplayDiff, 'unchanged'> {
  // 'unknown' is treated as 'allow' for diff purposes — historically the action
  // wasn't denied (no `action.denied` record), so it effectively went through.
  const o = original === 'unknown' ? 'allow' : original;
  const o_p = `${o}_${proposed}` as const;
  switch (o_p) {
    case 'allow_deny':
      return 'nowAllow_thenDeny';
    case 'deny_allow':
      return 'nowDeny_thenAllow';
    case 'allow_require_approval':
      return 'nowAllow_thenApproval';
    case 'deny_require_approval':
      return 'nowDeny_thenApproval';
    case 'require_approval_allow':
      return 'nowApproval_thenAllow';
    case 'require_approval_deny':
      return 'nowApproval_thenDeny';
    // Same-bucket cases (allow_allow, deny_deny, approval_approval) get counted
    // in `unchanged` upstream, so they never reach here.
    default:
      return 'nowAllow_thenDeny';
  }
}
