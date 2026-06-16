import { z } from 'zod';

import {
  IdSchema,
  JsonValueSchema,
  MoneySchema,
  RiskLevelSchema,
  TimestampSchema,
} from './common.js';

export const ActionStatusSchema = z.enum([
  'proposed', // submitted for evaluation, not yet allowed
  'authorized', // permitted by policy, not yet executed
  'denied', // blocked by policy
  'executed', // carried out successfully
  'failed', // attempted but errored
  'rolled_back', // reversed by a compensating action
]);
export type ActionStatus = z.infer<typeof ActionStatusSchema>;

export const ReversalStrategySchema = z.enum([
  'compensate', // run an inverse action to undo the effect
  'restore', // restore a captured prior state/snapshot
  'none', // not reversible
]);
export type ReversalStrategy = z.infer<typeof ReversalStrategySchema>;

/** Declares how an action can be undone, enabling the rollback engine. */
export const ActionReversalSchema = z
  .object({
    strategy: ReversalStrategySchema,
    /** The inverse operation to run when compensating. */
    inverse: z
      .object({
        type: z.string().min(1),
        target: z.string().default(''),
        params: JsonValueSchema.default({}),
      })
      .strict()
      .optional(),
    /** Opaque reference to a captured snapshot for `restore` strategies. */
    snapshotRef: z.string().optional(),
  })
  .strict();
export type ActionReversal = z.infer<typeof ActionReversalSchema>;

/**
 * An action is something an actor wants to do or has done: a tool call, an HTTP
 * request, a database write, etc. Actions are the unit the permissions engine
 * gates, the spend guard prices, and the rollback engine reverses.
 */
export const ActionSchema = z
  .object({
    id: IdSchema,
    actorId: IdSchema,
    /** Namespaced verb, e.g. `tool.call`, `http.request`, `db.write`. */
    type: z.string().min(1).max(256),
    /** The resource the action touches, e.g. a URL, table, or tool name. */
    target: z.string().default(''),
    params: JsonValueSchema.default({}),
    reversible: z.boolean().default(false),
    reversal: ActionReversalSchema.optional(),
    /** Estimated or actual cost of performing the action. */
    cost: MoneySchema.optional(),
    risk: RiskLevelSchema.optional(),
    status: ActionStatusSchema.default('proposed'),
    /** Arbitrary contextual metadata (run id, prompt hash, etc.). */
    context: JsonValueSchema.default({}),
    createdAt: TimestampSchema.optional(),
  })
  .strict();

export type Action = z.infer<typeof ActionSchema>;
