import { z } from 'zod';

import { IdSchema, MoneySchema, TimestampSchema } from './common.js';

export const BudgetWindowSchema = z.enum(['total', 'daily', 'weekly', 'monthly']);
export type BudgetWindow = z.infer<typeof BudgetWindowSchema>;

/** What a budget applies to: everything, one actor, or everything carrying a label. */
export const BudgetScopeSchema = z
  .object({
    kind: z.enum(['global', 'actor', 'label']),
    /** actorId for `actor`; `key=value` for `label`; empty for `global`. */
    value: z.string().default(''),
  })
  .strict();
export type BudgetScope = z.infer<typeof BudgetScopeSchema>;

/**
 * A spend limit over a scope and time window. `hardStop` defaults to `true`: the
 * safe default is to *block* spend that would exceed the limit rather than merely
 * warn. Operators must explicitly opt into soft (warn-only) budgets.
 */
export const BudgetSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1).max(256),
    scope: BudgetScopeSchema,
    limit: MoneySchema.refine((m) => m.amountMinor >= 0, 'budget limit must be non-negative'),
    window: BudgetWindowSchema.default('total'),
    hardStop: z.boolean().default(true),
    enabled: z.boolean().default(true),
    createdAt: TimestampSchema.optional(),
  })
  .strict();

export type Budget = z.infer<typeof BudgetSchema>;
