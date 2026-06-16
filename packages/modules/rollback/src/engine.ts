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
  readonly status: 'rolled_back' | 'skipped';
  readonly detail: string;
}

/** The aggregate result of executing a {@link RollbackPlan}. */
export interface RollbackResult {
  readonly outcomes: RollbackOutcome[];
}

/**
 * Pluggable side-effect performer. Given a step, run the real inverse operation
 * (call an API, restore a snapshot, …) and report whether it succeeded. The
 * returned `compensationActionId` is recorded on the appended `action.rolled_back`
 * event so the compensation itself is auditable.
 */
export type CompensationExecutor = (
  step: RollbackStep,
) => Promise<{ ok: boolean; detail?: string; compensationActionId?: string }>;

/** Default executor: a no-op that reports success (records intent only). */
const defaultExecutor: CompensationExecutor = async () => ({ ok: true });

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
  async planForAction(actionId: string): Promise<Result<RollbackPlan, VeritrailError>> {
    const records = await this.#ctx.ledger.readAll();

    let action: Action | undefined;
    let executed = false;
    for (const record of records) {
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
   * Plan the reversal of every executed, reversible action in a correlation.
   *
   * Steps are emitted in REVERSE chronological (descending `seq`) order so that
   * effects are undone last-in-first-out — the safe order for dependent work.
   */
  async planForCorrelation(correlationId: string): Promise<RollbackPlan> {
    const records = await this.#ctx.ledger.query({ correlationId });

    const proposedById = new Map<string, Action>();
    const executedSeq = new Map<string, number>();
    for (const record of records) {
      const proposed = proposedAction(record);
      if (proposed !== undefined) {
        proposedById.set(proposed.id, proposed);
        continue;
      }
      if (record.event.type === 'action.executed') {
        executedSeq.set(record.event.payload.actionId, record.seq);
      }
    }

    const steps: Array<{ seq: number; step: RollbackStep }> = [];
    const unreversible: string[] = [];
    for (const [actionId, seq] of executedSeq) {
      const action = proposedById.get(actionId);
      if (action === undefined) continue;
      const reversible = isReversible(action);
      if (reversible) {
        steps.push({ seq, step: stepFromAction(action) });
      } else {
        unreversible.push(actionId);
      }
    }

    steps.sort((a, b) => b.seq - a.seq);
    return { steps: steps.map((s) => s.step), unreversible };
  }

  /**
   * Execute a plan. For each step with a strategy other than `none`, invoke the
   * executor (default: a success no-op). On success, append an
   * `action.rolled_back` event and record a `rolled_back` outcome; on executor
   * failure, record a `skipped` outcome and append nothing. `none` strategies
   * are skipped without invoking the executor.
   */
  async execute(
    plan: RollbackPlan,
    executor: CompensationExecutor = defaultExecutor,
  ): Promise<RollbackResult> {
    const outcomes: RollbackOutcome[] = [];

    for (const step of plan.steps) {
      if (step.strategy === 'none') {
        outcomes.push({ actionId: step.actionId, status: 'skipped', detail: 'strategy is none' });
        continue;
      }

      const result = await executor(step);
      if (!result.ok) {
        outcomes.push({
          actionId: step.actionId,
          status: 'skipped',
          detail: result.detail ?? 'executor reported failure',
        });
        continue;
      }

      const reason = `rolled back via ${step.strategy}`;
      const appended = await this.#ctx.ledger.append({
        type: 'action.rolled_back',
        actorId: this.info.name,
        payload: {
          actionId: step.actionId,
          reason,
          ...(result.compensationActionId !== undefined
            ? { compensationActionId: result.compensationActionId }
            : {}),
        },
      });

      if (appended.ok === false) {
        outcomes.push({
          actionId: step.actionId,
          status: 'skipped',
          detail: `failed to record rollback: ${appended.error.message}`,
        });
        continue;
      }

      outcomes.push({
        actionId: step.actionId,
        status: 'rolled_back',
        detail: result.detail ?? reason,
      });
    }

    return { outcomes };
  }
}

/** Construct a {@link RollbackModule} from a shared {@link ModuleContext}. */
export function createRollbackModule(ctx: ModuleContext): RollbackModule {
  return new RollbackModule(ctx);
}
