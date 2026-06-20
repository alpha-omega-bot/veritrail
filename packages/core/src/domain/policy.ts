import { z } from 'zod';

import {
  ActorKindSchema,
  IdSchema,
  LabelsSchema,
  RiskLevelSchema,
  TimestampSchema,
} from './common.js';

export const PolicyEffectSchema = z.enum(['allow', 'deny', 'require_approval']);
export type PolicyEffect = z.infer<typeof PolicyEffectSchema>;

/**
 * Conditions a policy matches against an action and its actor. An empty match
 * object matches everything (useful for a catch-all default). All present
 * conditions must hold (logical AND); list-valued conditions match if any
 * element matches (logical OR within the list).
 */
export const PolicyMatchSchema = z
  .object({
    actorKinds: z.array(ActorKindSchema).optional(),
    actorIds: z.array(IdSchema).optional(),
    /** Action types; supports a trailing `*` wildcard, e.g. `tool.*`. */
    actionTypes: z.array(z.string().min(1)).optional(),
    /** Target glob patterns, e.g. `https://api.example.com/*`. */
    targets: z.array(z.string().min(1)).optional(),
    /** Matches when the action's risk is at least this level. */
    minRisk: RiskLevelSchema.optional(),
    /** Every key/value here must be present on the action's actor labels. */
    labels: LabelsSchema.optional(),
  })
  .strict();
export type PolicyMatch = z.infer<typeof PolicyMatchSchema>;

/**
 * A single policy rule. The permissions engine evaluates all enabled policies,
 * orders matches by `priority` (higher wins), and applies a configurable default
 * effect when nothing matches.
 */
export const PolicySchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1).max(256),
    description: z.string().default(''),
    effect: PolicyEffectSchema,
    match: PolicyMatchSchema.default({}),
    /**
     * Tenant scope. A policy with no `tenant` is GLOBAL and applies to every
     * principal. A policy with `tenant` labels applies only to principals whose
     * label scope contains every one of those labels. See ADR-0004.
     */
    tenant: LabelsSchema.optional(),
    /** Higher priority wins ties; equal priority resolves deny > require_approval > allow. */
    priority: z.number().int().default(0),
    enabled: z.boolean().default(true),
    createdAt: TimestampSchema.optional(),
  })
  .strict();

export type Policy = z.infer<typeof PolicySchema>;
