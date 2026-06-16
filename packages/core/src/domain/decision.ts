import { z } from 'zod';

import { IdSchema, TimestampSchema } from './common.js';

/** One option that was weighed when making a decision. */
export const DecisionOptionSchema = z
  .object({
    label: z.string().min(1),
    rationale: z.string().default(''),
    rejected: z.boolean().default(false),
  })
  .strict();
export type DecisionOption = z.infer<typeof DecisionOptionSchema>;

/**
 * A recorded decision: what was chosen, why, what alternatives were considered,
 * and which evidence informed it. Decision memory turns these into an auditable,
 * searchable record of *why* an agent did what it did.
 */
export const DecisionSchema = z
  .object({
    id: IdSchema,
    actorId: IdSchema,
    summary: z.string().min(1).max(2000),
    rationale: z.string().default(''),
    options: z.array(DecisionOptionSchema).default([]),
    /** The chosen option's label. */
    chosen: z.string().default(''),
    /** Evidence that informed the decision (see the evidence module). */
    evidenceIds: z.array(IdSchema).default([]),
    /** Calibrated confidence in [0, 1]. */
    confidence: z.number().min(0).max(1).optional(),
    /** Actions taken as a consequence of this decision. */
    relatedActionIds: z.array(IdSchema).default([]),
    createdAt: TimestampSchema.optional(),
  })
  .strict();

export type Decision = z.infer<typeof DecisionSchema>;
