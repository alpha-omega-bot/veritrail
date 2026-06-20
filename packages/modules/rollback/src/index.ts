/**
 * `@veritrail/rollback` — the rollback engine.
 *
 * Rollback is a projection-plus-writer over the single tamper-evident ledger.
 * It reads the recorded history of an action (its `action.proposed` reversal
 * descriptor and its `action.executed` receipt) to build a compensating plan,
 * then executes that plan by appending `action.rolled_back` events. It never
 * keeps a parallel store: the ledger remains the system of record.
 *
 * This is a SCAFFOLD: it provides a correct, deterministic baseline (plan from
 * a single action or a whole correlation, execute with a pluggable executor)
 * while deferring saga/partial-failure semantics, idempotency, and real
 * executor adapters to Phase 1 (see README).
 */

export type {
  RollbackStep,
  RollbackPlan,
  RollbackOutcome,
  RollbackResult,
  CompensationExecutor,
  RollbackRecordOptions,
  RollbackProjectionOptions,
} from './engine.js';

export { RollbackModule, createRollbackModule } from './engine.js';
