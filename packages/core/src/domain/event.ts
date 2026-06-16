import { z } from 'zod';

import { ActionSchema } from './action.js';
import { BudgetScopeSchema } from './budget.js';
import { IdSchema, JsonValueSchema, LabelsSchema, MoneySchema, TimestampSchema } from './common.js';
import { DecisionSchema } from './decision.js';
import { EvidenceSchema } from './evidence.js';
import { PolicyEffectSchema } from './policy.js';
import { VendorSchema, VendorSignalSchema } from './vendor.js';

/**
 * The closed set of event types the core understands. Every capability in the
 * platform is expressed as one or more of these facts appended to the ledger;
 * the modules are projections over this stream. New capabilities extend this
 * union rather than introducing a parallel store.
 */
export const EVENT_TYPES = [
  'action.proposed',
  'action.authorized',
  'action.denied',
  'action.executed',
  'action.failed',
  'action.rolled_back',
  'decision.recorded',
  'evidence.attached',
  'policy.evaluated',
  'budget.charged',
  'budget.exceeded',
  'vendor.registered',
  'vendor.signal',
  'note',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

export const isEventType = (value: string): value is EventType => EVENT_TYPE_SET.has(value);

/**
 * Shared envelope present on every event:
 * - `actorId`     — who/what caused the event.
 * - `correlationId` — groups events belonging to the same run/incident/trace.
 * - `causationId`   — the id of the action/event that directly caused this one,
 *                     forming the causal graph the forensics engine replays.
 * - `occurredAt`  — when it happened in the source system (the ledger separately
 *                   records its own authoritative receipt timestamp).
 */
const envelope = {
  actorId: IdSchema,
  correlationId: IdSchema.optional(),
  causationId: IdSchema.optional(),
  labels: LabelsSchema.default({}),
  occurredAt: TimestampSchema.optional(),
} as const;

export const EventInputSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...envelope,
      type: z.literal('action.proposed'),
      payload: z.object({ action: ActionSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('action.authorized'),
      payload: z
        .object({
          actionId: IdSchema,
          authorizedBy: IdSchema.optional(),
          policyId: IdSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('action.denied'),
      payload: z
        .object({
          actionId: IdSchema,
          reason: z.string().default(''),
          policyId: IdSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('action.executed'),
      payload: z
        .object({
          actionId: IdSchema,
          outcome: z.enum(['success', 'partial']).default('success'),
          durationMs: z.number().int().nonnegative().optional(),
          cost: MoneySchema.optional(),
          result: JsonValueSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('action.failed'),
      payload: z
        .object({
          actionId: IdSchema,
          error: z.string().min(1),
          durationMs: z.number().int().nonnegative().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('action.rolled_back'),
      payload: z
        .object({
          actionId: IdSchema,
          compensationActionId: IdSchema.optional(),
          reason: z.string().default(''),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('decision.recorded'),
      payload: z.object({ decision: DecisionSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('evidence.attached'),
      payload: z.object({ evidence: EvidenceSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('policy.evaluated'),
      payload: z
        .object({
          actionId: IdSchema,
          effect: PolicyEffectSchema,
          matchedPolicyId: IdSchema.optional(),
          reason: z.string().default(''),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('budget.charged'),
      payload: z
        .object({
          scope: BudgetScopeSchema,
          amount: MoneySchema,
          budgetId: IdSchema.optional(),
          actionId: IdSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('budget.exceeded'),
      payload: z
        .object({
          budgetId: IdSchema,
          scope: BudgetScopeSchema,
          attempted: MoneySchema,
          limit: MoneySchema,
          actionId: IdSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('vendor.registered'),
      payload: z.object({ vendor: VendorSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('vendor.signal'),
      payload: z.object({ signal: VendorSignalSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('note'),
      payload: z.object({ text: z.string().min(1), data: JsonValueSchema.optional() }).strict(),
    })
    .strict(),
]);

/** A validated event ready to be appended to the ledger. */
export type EventInput = z.infer<typeof EventInputSchema>;

/** Narrow `EventInput` to a single event type. */
export type EventOf<T extends EventType> = Extract<EventInput, { type: T }>;
