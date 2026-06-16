# ADR 0003: Money as integer minor units

- **Status:** Accepted
- **Date:** 2025
- **Deciders:** Veritrail core team

## Context

The spend guard accumulates cost across many actions and enforces hard-stop
budgets: it sums `budget.charged` amounts over a window and compares the total
against a limit. Two properties are non-negotiable for that to be trustworthy:

1. **Exactness.** Summing many charges must not drift. Binary floating point
   (`number` as IEEE-754 `double`) cannot represent most decimal fractions
   exactly — `0.1 + 0.2 !== 0.3` — so repeated accumulation introduces error.
   When that error sits between a running total and a budget limit, the guard can
   admit a charge it should block, or block one it should admit. A control plane
   that is "off by a rounding error" near the limit is not a control plane.

2. **Reproducibility.** Amounts ride inside ledger events, and the ledger hashes
   the canonical form of every record. Non-finite numbers have no portable JSON
   representation; even finite floats risk representation differences. Money must
   serialize to stable, exact bytes so hashes are reproducible across runtimes.

We also need to forbid silently mixing currencies in arithmetic and comparison.

## Decision

Money is an integer count of the currency's **minor unit** (e.g. cents), paired
with an ISO-4217-style currency code (`packages/core/src/domain/common.ts`):

```ts
export const MoneySchema = z
  .object({
    currency: CurrencySchema, // /^[A-Z]{3}$/
    amountMinor: z.number().int(), // integer minor units
  })
  .strict();
export type Money = z.infer<typeof MoneySchema>;
```

So `1.10 USD` is `{ currency: 'USD', amountMinor: 110 }`. Helpers and rules:

- `money(amountMinor, currency = 'USD')` and `zeroMoney(currency)` construct
  amounts; `amountMinor` is validated as an integer.
- **Addition returns a `Result`.** `addMoney(a, b)` returns
  `err(VALIDATION 'cannot add X and Y')` on mismatched currencies, else
  `ok({ currency, amountMinor: a + b })`. Mixing currencies is a recoverable
  caller error, so it is surfaced as a `Result` (per ADR 0002).
- **Comparison throws on mismatch.** `compareMoney(a, b)` returns `a - b` (in
  minor units) for the same currency and _throws_ a `VALIDATION` error on
  different currencies — comparing incomparable amounts is a programming error.
- **Budgets enforce non-negative limits;** "reaching the limit exactly is
  allowed, exceeding it is not" is expressed as exact integer comparisons in the
  spend guard, with no tolerance band.

## Consequences

### Positive

- **Exact accumulation.** Integer addition is exact; summing thousands of charges
  never drifts, so budget enforcement at the limit is precise.
- **Stable hashing.** Integers serialize to canonical, reproducible JSON, so
  money inside events hashes identically everywhere — consistent with the
  ledger's finite-number rule.
- **Currency safety by construction.** You cannot accidentally add USD to EUR
  (you get an `Err`) or compare them (you get a throw); every `Money` is
  self-describing with its currency.
- **No locale/format ambiguity in storage.** The stored value is a count, not a
  formatted decimal string; presentation/locale formatting is a display concern.

### Negative / costs

- **Callers must think in minor units.** `$1.10` is `110`; forgetting the ×100
  is an easy mistake at the boundary. Mitigated by the `money()` helper and
  schema validation, but the unit convention must be learned.
- **Two-arithmetic-styles split.** `addMoney` returns `Result` while
  `compareMoney` throws; callers must remember which is which (this is the ADR
  0002 convention, applied to money).
- **Zero-decimal and three-decimal currencies.** The "minor unit" differs by
  currency (JPY has 0 decimals, some have 3). The amount is just an integer count
  of _that currency's_ minor unit; correctly interpreting the scale per currency
  is left to the caller/presentation layer.
- **Bounded range.** `amountMinor` is a JS `number` integer, safe up to
  `Number.MAX_SAFE_INTEGER`. That is ample for realistic spend, but extreme
  magnitudes would require a bigint representation (not currently needed).

## Alternatives considered

1. **Floating-point decimals (`number` of major units, e.g. `1.10`).** Rejected:
   accumulation drift and non-reproducible serialization defeat both exact
   enforcement and stable hashing — the two reasons this ADR exists.
2. **Decimal strings (`"1.10"`).** Exact in storage, but every operation must
   parse/format, comparison is error-prone, and it invites locale issues.
   Integers give exactness _and_ trivial arithmetic.
3. **A bigint or arbitrary-precision decimal library.** Solves range/precision
   beyond `MAX_SAFE_INTEGER` but adds a dependency and serialization complexity
   for a need we do not have. Integer minor units are sufficient and dependency
   free; we can revisit if extreme magnitudes ever arise.
4. **Currency-agnostic bare number.** Rejected: it allows silently mixing
   currencies, which is precisely what `addMoney`/`compareMoney` are designed to
   prevent.
