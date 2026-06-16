import { z } from 'zod';

import { type JsonValue } from '../util/canonical.js';
import { ok, err, type Result } from '../util/result.js';
import { validationError, type VeritrailError } from '../util/errors.js';

/** Recursive Zod schema for arbitrary JSON. Numbers must be finite. */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/** True if the string contains an ASCII control character (rejected in ids). */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** An identifier: non-empty, bounded, free of control characters. */
export const IdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !hasControlCharacter(value), 'id must not contain control characters');

/** Epoch milliseconds. */
export const TimestampSchema = z.number().int().nonnegative();

/** Free-form string-to-string tags used for scoping policies, budgets, and queries. */
export const LabelsSchema = z.record(z.string().min(1), z.string());

export const ActorKindSchema = z.enum(['agent', 'human', 'service', 'system']);
export type ActorKind = z.infer<typeof ActorKindSchema>;

export const RiskLevelSchema = z.enum(['low', 'medium', 'high', 'critical']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

/** Ordered ranking of risk for threshold comparisons. */
export const RISK_ORDER: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** ISO 4217-style 3-letter currency code. */
export const CurrencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO code');

/**
 * Money is stored as an integer count of the currency's minor unit (e.g. cents)
 * to avoid floating-point drift in financial accumulation. `1.10 USD` is
 * `{ currency: 'USD', amountMinor: 110 }`.
 */
export const MoneySchema = z
  .object({
    currency: CurrencySchema,
    // `.safe()` bounds the value to ±(2^53 - 1) so integer accumulation stays exact.
    amountMinor: z.number().int().safe(),
  })
  .strict();
export type Money = z.infer<typeof MoneySchema>;

export const zeroMoney = (currency: string): Money => ({ currency, amountMinor: 0 });

export const money = (amountMinor: number, currency = 'USD'): Money => ({ currency, amountMinor });

/** Add two amounts of the same currency. Mixing currencies is a validation error. */
export function addMoney(a: Money, b: Money): Result<Money, VeritrailError> {
  if (a.currency !== b.currency) {
    return err(validationError(`cannot add ${a.currency} and ${b.currency}`));
  }
  return ok({ currency: a.currency, amountMinor: a.amountMinor + b.amountMinor });
}

/**
 * Compare two amounts of the same currency. Returns negative if `a < b`, zero if
 * equal, positive if `a > b`. Comparing different currencies is a programming
 * error and throws.
 */
export function compareMoney(a: Money, b: Money): number {
  if (a.currency !== b.currency) {
    throw validationError(`cannot compare ${a.currency} and ${b.currency}`);
  }
  return a.amountMinor - b.amountMinor;
}
