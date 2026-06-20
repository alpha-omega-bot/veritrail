/**
 * The rollback engine: build and execute compensating plans to reverse
 * recorded actions.
 */

import {
  err,
  notFoundError,
  ok,
  type Action,
  type JsonValue,
  type LedgerRecord,
  type ModuleContext,
  type ReversalStrategy,
  type Result,
  type VeritrailError,
} from '@veritrail/core';

/**
 * One unit of compensation. Describes how a single recorded action should be
 * reversed: the {@link ReversalStrategy} taken from the action's reversal
 * descriptor plus, where available, the concrete inverse operation and/or the
 * snapshot reference an executor needs.
 */
export interface RollbackStep {
  /** The id of the action being reversed. */
  readonly actionId: string;
  /** How this action is reversed (`compensate` | `restore` | `none`). */
  readonly strategy: ReversalStrategy;
  /** The inverse operation to run for `compensate` strategies. */
  readonly inverse?: { type: string; target: string; params: JsonValue };
  /** Opaque reference to a captured snapshot for `restore` strategies. */
  readonly snapshotRef?: string;
}

/**
 * A compensating plan: the ordered steps to run plus the ids of actions that
 * could not be reversed (not reversible, or strategy `none`).
 */
export interface RollbackPlan {
  readonly steps: RollbackStep[];
  readonly unreversible: string[];
}

/** The result of attempting a single {@link RollbackStep}. */
export interface RollbackOutcome {
  readonly actionId: string;
  readonly status: 'rolled_back' | 'already_rolled_back' | 'skipped';
  readonly detail: string;
}

/** The aggregate result of executing a {@link RollbackPlan}. */
export interface RollbackResult {
  readonly outcomes: RollbackOutcome[];
  /**
   * True when the plan applied with no failure: every step was `rolled_back`,
   * `already_rolled_back`, or skipped only because its strategy is `none`. False
   * when any step failed (executor error or a failed `action.rolled_back` append).
   */
  readonly completed: boolean;
  /** Count of outcomes by status. */
  readonly counts: Record<RollbackOutcome['status'], number>;
  /** In `stop_on_failure` mode, the actionId of the step that halted execution. */
  readonly haltedAt?: string;
}

/** How a {@link RollbackPlan} is executed when a step fails. */
export type RollbackMode =
  /** Attempt every step regardless of failures (the default). */
  | 'best_effort'
  /**
   * Stop at the first failing step (executor error or failed record). Use for
   * ordered, dependent unwinds where compensating a later step is unsafe once an
   * earlier one has failed. Benign skips (`none` strategy, already rolled back)
   * do not halt.
   */
  | 'stop_on_failure';

/** Context passed to a {@link CompensationExecutor} for each step. */
export interface CompensationContext {
  /**
   * A stable key for this action's compensation. An executor MUST treat repeated
   * calls with the same key as the same operation (run the side effect at most
   * once) — this is what makes {@link RollbackModule.execute} safe to retry after
   * a crash between performing a side effect and recording it.
   */
  readonly idempotencyKey: string;
}

/**
 * Pluggable side-effect performer. Given a step, run the real inverse operation
 * (call an API, restore a snapshot, …) and report whether it succeeded. The
 * returned `compensationActionId` is recorded on the appended `action.rolled_back`
 * event so the compensation itself is auditable. The `context.idempotencyKey`
 * lets the executor dedupe a retried side effect.
 */
export type CompensationExecutor = (
  step: RollbackStep,
  context: CompensationContext,
) => Promise<{ ok: boolean; detail?: string; compensationActionId?: string }>;

/** Default executor: a no-op that reports success (records intent only). */
const defaultExecutor: CompensationExecutor = async () => ({ ok: true });

/** Optional ledger envelope values for compensating writes. */
export interface RollbackRecordOptions {
  /** Labels to write onto appended `action.rolled_back` event envelopes. */
  readonly labels?: Readonly<Record<string, string>>;
}

/** Options for {@link RollbackModule.execute}. */
export interface RollbackExecuteOptions extends RollbackRecordOptions {
  /** Failure handling. Defaults to `best_effort`. */
  readonly mode?: RollbackMode;
}

/** Optional projection filters for rollback plan reads. */
export interface RollbackProjectionOptions {
  /** Restrict planning to records carrying these exact ledger labels. */
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

/** Extract the {@link Action} from an `action.proposed` record, if present. */
function proposedAction(record: LedgerRecord): Action | undefined {
  if (record.event.type !== 'action.proposed') return undefined;
  return record.event.payload.action;
}

/**
 * Whether an action can actually be reversed. Beyond `reversible` and a strategy
 * other than `none`, a `compensate` strategy needs a concrete `inverse` and a
 * `restore` strategy needs a `snapshotRef` — otherwise there is nothing to run,
 * so the action is reported as unreversible rather than falsely "rolled back".
 */
function isReversible(action: Action): boolean {
  const reversal = action.reversal;
  if (!action.reversible || reversal === undefined || reversal.strategy === 'none') return false;
  if (reversal.strategy === 'compensate') return reversal.inverse !== undefined;
  if (reversal.strategy === 'restore') return reversal.snapshotRef !== undefined;
  return false;
}

/** Build a {@link RollbackStep} from a proposed action's reversal descriptor. */
function stepFromAction(action: Action): RollbackStep {
  const reversal = action.reversal;
  const strategy: ReversalStrategy = reversal?.strategy ?? 'none';
  return {
    actionId: action.id,
    strategy,
    ...(reversal?.inverse !== undefined ? { inverse: reversal.inverse } : {}),
    ...(reversal?.snapshotRef !== undefined ? { snapshotRef: reversal.snapshotRef } : {}),
  };
}

/**
 * Build and execute compensating plans to reverse recorded actions.
 *
 * Reads are pure projections over the ledger; execution appends
 * `action.rolled_back` facts. The engine holds no state of its own.
 */
export class RollbackModule {
  readonly info = {
    name: '@veritrail/rollback',
    version: '0.1.0',
    capability: 'rollback' as const,
  };

  readonly #ctx: ModuleContext;

  constructor(ctx: ModuleContext) {
    this.#ctx = ctx;
  }

  /**
   * Plan the reversal of a single action.
   *
   * Locates the `action.proposed` event (source of the reversal descriptor) and
   * confirms an `action.executed` receipt exists. A reversible action yields a
   * single step; a non-reversible one (or strategy `none`) is reported in
   * `unreversible`. Returns NOT_FOUND when the action was never proposed.
   */
  async planForAction(
    actionId: string,
    opts?: RollbackProjectionOptions,
  ): Promise<Result<RollbackPlan, VeritrailError>> {
    const records = await this.#ctx.ledger.readAll();

    let action: Action | undefined;
    let executed = false;
    for (const record of records) {
      // Out-of-scope records are invisible, so planning another tenant's action
      // returns NOT_FOUND rather than leaking its reversal descriptor.
      if (!recordHasLabels(record, opts?.labels)) continue;
      const proposed = proposedAction(record);
      if (proposed !== undefined && proposed.id === actionId) {
        action = proposed;
        continue;
      }
      if (record.event.type === 'action.executed' && record.event.payload.actionId === actionId) {
        executed = true;
      }
    }

    if (action === undefined) {
      return err(notFoundError(`No proposed action ${actionId} found in the ledger`, { actionId }));
    }

    const reversible = isReversible(action);
    if (!reversible || !executed) {
      this.#ctx.logger.debug('action not reversible or not executed', {
        actionId,
        reversible: action.reversible,
        executed,
      });
      return ok({ steps: [], unreversible: [actionId] });
    }

    return ok({ steps: [stepFromAction(action)], unreversible: [] });
  }

  /**
   * Plan the reversal of every executed, reversible action whose **proposal**
   * belongs to a correlation.
   *
   * Membership is defined by the `action.proposed` events carrying the
   * `correlationId` (the authoritative source of each reversal descriptor).
   * Execution is then resolved **globally by `actionId`**, so an
   * `action.executed` receipt that omits the `correlationId` still counts — this
   * is the fix for receipts that lose their correlation. An action *proposed*
   * under a different correlation is intentionally excluded: it belongs to that
   * correlation's plan, not this one.
   *
   * Steps are emitted in REVERSE chronological (descending execution `seq`) order
   * so that effects are undone last-in-first-out — the safe order for dependent
   * work.
   */
  async planForCorrelation(
    correlationId: string,
    opts?: RollbackProjectionOptions,
  ): Promise<RollbackPlan> {
    const labelFilter = opts?.labels !== undefined ? { labels: opts.labels } : {};
    const proposalRecords = await this.#ctx.ledger.query({ correlationId, ...labelFilter });

    const proposedById = new Map<string, Action>();
    for (const record of proposalRecords) {
      const proposed = proposedAction(record);
      if (proposed !== undefined) proposedById.set(proposed.id, proposed);
    }

    // Resolve executions globally: a receipt may carry a different (or no)
    // correlationId than its proposal, so we must not restrict by correlation.
    const executionRecords = await this.#ctx.ledger.query({
      types: ['action.executed'],
      ...labelFilter,
    });
    const executedSeq = new Map<string, number>();
    for (const record of executionRecords) {
      if (record.event.type !== 'action.executed') continue;
      const { actionId } = record.event.payload;
      if (proposedById.has(actionId)) executedSeq.set(actionId, record.seq);
    }

    const steps: Array<{ seq: number; step: RollbackStep }> = [];
    const unreversible: string[] = [];
    for (const [actionId, seq] of executedSeq) {
      const action = proposedById.get(actionId);
      if (action === undefined) continue;
      if (isReversible(action)) {
        steps.push({ seq, step: stepFromAction(action) });
      } else {
        unreversible.push(actionId);
      }
    }

    steps.sort((a, b) => b.seq - a.seq);
    return { steps: steps.map((s) => s.step), unreversible };
  }

  /**
   * Execute a plan, idempotently. The compensation is the risky step: a real
   * side effect may succeed and then the `action.rolled_back` append may fail,
   * leaving the effect done but unrecorded. To make `execute` safe to retry:
   *
   * - Steps whose `action.rolled_back` fact is already on the ledger are skipped
   *   (`already_rolled_back`), so re-running a partially-completed plan does not
   *   re-compensate work that was recorded.
   * - The executor receives an `idempotencyKey` (the `actionId`) so it can dedupe
   *   the one in-flight side effect that ran but was not recorded before a crash.
   *
   * For each remaining step with a strategy other than `none`: invoke the
   * executor (default: a success no-op); on success append `action.rolled_back`
   * and report `rolled_back`; on executor failure (or a failed append) report
   * `skipped` and append nothing. `none` strategies are skipped without invoking
   * the executor.
   *
   * With `mode: 'stop_on_failure'`, execution halts at the first failing step
   * (executor error or failed append) and reports it in `haltedAt`; remaining
   * steps are not attempted. The default `best_effort` mode attempts every step.
   * The returned {@link RollbackResult} summarizes the run (`completed`, per-status
   * `counts`).
   */
  async execute(
    plan: RollbackPlan,
    executor: CompensationExecutor = defaultExecutor,
    opts?: RollbackExecuteOptions,
  ): Promise<RollbackResult> {
    const mode: RollbackMode = opts?.mode ?? 'best_effort';
    const outcomes: RollbackOutcome[] = [];
    const alreadyRolledBack = await this.#rolledBackActionIds(opts);
    let haltedAt: string | undefined;
    let failureOccurred = false;

    for (const step of plan.steps) {
      const { outcome, failed } = await this.#executeStep(step, executor, alreadyRolledBack, opts);
      outcomes.push(outcome);
      if (failed) {
        failureOccurred = true;
        if (mode === 'stop_on_failure') {
          haltedAt = step.actionId;
          break;
        }
      }
    }

    const counts: Record<RollbackOutcome['status'], number> = {
      rolled_back: 0,
      already_rolled_back: 0,
      skipped: 0,
    };
    for (const outcome of outcomes) counts[outcome.status] += 1;

    return {
      outcomes,
      completed: !failureOccurred,
      counts,
      ...(haltedAt !== undefined ? { haltedAt } : {}),
    };
  }

  /**
   * Attempt one step. Returns the outcome plus whether it was a *failure* (an
   * executor error or a failed record) — as opposed to a benign skip (`none`
   * strategy or an already-recorded rollback), which does not halt a
   * `stop_on_failure` run.
   */
  async #executeStep(
    step: RollbackStep,
    executor: CompensationExecutor,
    alreadyRolledBack: Set<string>,
    opts: RollbackRecordOptions | undefined,
  ): Promise<{ outcome: RollbackOutcome; failed: boolean }> {
    if (step.strategy === 'none') {
      return {
        outcome: { actionId: step.actionId, status: 'skipped', detail: 'strategy is none' },
        failed: false,
      };
    }

    if (alreadyRolledBack.has(step.actionId)) {
      return {
        outcome: {
          actionId: step.actionId,
          status: 'already_rolled_back',
          detail: 'compensation already recorded on the ledger',
        },
        failed: false,
      };
    }

    const result = await executor(step, { idempotencyKey: step.actionId });
    if (!result.ok) {
      return {
        outcome: {
          actionId: step.actionId,
          status: 'skipped',
          detail: result.detail ?? 'executor reported failure',
        },
        failed: true,
      };
    }

    const reason = `rolled back via ${step.strategy}`;
    const appended = await this.#ctx.ledger.append({
      type: 'action.rolled_back',
      actorId: this.info.name,
      ...(opts?.labels !== undefined ? { labels: opts.labels } : {}),
      payload: {
        actionId: step.actionId,
        reason,
        ...(result.compensationActionId !== undefined
          ? { compensationActionId: result.compensationActionId }
          : {}),
      },
    });

    if (appended.ok === false) {
      // The side effect ran but recording it failed. Reported as a failure skip;
      // a retry will re-invoke the executor with the same idempotencyKey (so it
      // can dedupe) and record the rollback then.
      return {
        outcome: {
          actionId: step.actionId,
          status: 'skipped',
          detail: `failed to record rollback: ${appended.error.message}`,
        },
        failed: true,
      };
    }

    // Guard against re-recording within this same call should a duplicate step
    // appear in the plan.
    alreadyRolledBack.add(step.actionId);
    return {
      outcome: { actionId: step.actionId, status: 'rolled_back', detail: result.detail ?? reason },
      failed: false,
    };
  }

  /** Action ids that already have an `action.rolled_back` fact on the ledger. */
  async #rolledBackActionIds(opts?: RollbackProjectionOptions): Promise<Set<string>> {
    const records = await this.#ctx.ledger.query({
      types: ['action.rolled_back'],
      ...(opts?.labels !== undefined ? { labels: opts.labels } : {}),
    });
    const ids = new Set<string>();
    for (const record of records) {
      if (record.event.type === 'action.rolled_back') ids.add(record.event.payload.actionId);
    }
    return ids;
  }
}

/** Construct a {@link RollbackModule} from a shared {@link ModuleContext}. */
export function createRollbackModule(ctx: ModuleContext): RollbackModule {
  return new RollbackModule(ctx);
}
