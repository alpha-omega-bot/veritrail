import { z } from 'zod';

import { IdSchema, LabelsSchema, TimestampSchema, ActorKindSchema } from './common.js';

/**
 * An actor is any principal that can take actions: an autonomous `agent`, a
 * `human` operator, a `service` (non-interactive automation), or the `system`
 * itself. Agents are first-class principals — that is what makes this a control
 * plane for *agents*, not just for users.
 */
export const ActorSchema = z
  .object({
    id: IdSchema,
    kind: ActorKindSchema,
    name: z.string().min(1).max(512),
    /** Optional grouping such as `{ team: 'payments', env: 'prod' }`. */
    labels: LabelsSchema.default({}),
    createdAt: TimestampSchema.optional(),
  })
  .strict();

export type Actor = z.infer<typeof ActorSchema>;
