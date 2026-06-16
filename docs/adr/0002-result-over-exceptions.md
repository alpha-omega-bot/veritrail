# ADR 0002: `Result<T, E>` at boundaries instead of throwing

- **Status:** Accepted
- **Date:** 2025
- **Deciders:** Veritrail core team

## Context

Veritrail's public operations fail for _expected_ reasons constantly: an event
fails schema validation, an append violates the append-only invariant, a policy
denies an action, a spend would exceed a budget, a referenced entity is missing.
These are not bugs — they are ordinary, anticipated outcomes that callers must
handle.

In JavaScript/TypeScript, the default failure mechanism is the thrown exception.
But thrown exceptions are _invisible to the type system_: a function's signature
says `Promise<LedgerRecord>`, not "or it throws `VeritrailError`." Failures can
silently cross trust boundaries, callers forget to `catch`, and the compiler
offers no help enumerating what can go wrong. For a product whose entire value is
_trustworthy control_, "the error path is untyped and easy to skip" is the wrong
default.

We need failures that are explicit, type-checked, and exhaustively handleable —
while still reserving exceptions for genuine, unrecoverable invariant violations.

## Decision

Public operations that can fail for expected reasons return a `Result<T, E>`
rather than throwing (`packages/core/src/util/result.ts`):

```ts
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}
export type Result<T, E = Error> = Ok<T> | Err<E>;
```

with helpers `ok`, `err`, `isOk`, `isErr`, `unwrap`, `unwrapOr`, `mapResult`,
`mapError`. The error type is a closed taxonomy, `VeritrailError`, carrying a
`code` from a small union (`packages/core/src/util/errors.ts`):

```
VALIDATION | INTEGRITY | CONFLICT | NOT_FOUND |
POLICY_DENIED | BUDGET_EXCEEDED | STORAGE | UNSUPPORTED | INTERNAL
```

Conventions, as applied across the codebase:

- **Boundaries return `Result`.** `Ledger.append` returns
  `Result<LedgerRecord, VeritrailError>` — validation failures become
  `err(validationError(...))`, store conflicts surface as `err(CONFLICT)`. Module
  writes (`permissions.enforce`, `spendGuard.charge/authorize`,
  `evidence.attach`, `decisionMemory.record`, `vendorRisk.register/score`,
  `rollback.planForAction`) all return `Result`.
- **Expected domain outcomes are errors, not throws.** A denied action is
  `err(POLICY_DENIED)`; an over-budget spend is `err(BUDGET_EXCEEDED)`; a missing
  entity is `err(NOT_FOUND)`.
- **Only genuine invariant violations throw.** `unwrap` throws (use it only where
  failure is unrecoverable). `compareMoney` _throws_ on mixed currencies because
  that is a programming error, whereas `addMoney` returns a `Result` because
  callers can reasonably handle it.
- **`VeritrailError` carries structured `details`** and a stable `code`, so
  transports can map codes to HTTP statuses and callers can branch exhaustively.

## Consequences

### Positive

- **Failures are in the type signature.** Callers see `Result<…, VeritrailError>`
  and the compiler steers them to handle both arms; the error path can't be
  silently skipped.
- **Exhaustive, stable branching.** A closed `code` union lets callers `switch`
  exhaustively and lets transports map errors to stable statuses without parsing
  messages.
- **Clear semantics.** "Returns `Result`" = expected failure; "throws" = bug or
  unrecoverable invariant. The `addMoney` vs `compareMoney` split encodes this
  distinction in the API itself.
- **Composability.** `mapResult` / `mapError` thread success/error through
  transformations without try/catch ceremony.

### Negative / costs

- **More verbose call sites.** Every fallible call needs an `isErr`/`.ok` check
  or an explicit `unwrap`; there is no automatic propagation like `?` in Rust or
  exceptions' stack unwinding.
- **Two error channels coexist.** Truly exceptional paths still throw, so callers
  must understand _which_ operations use which mechanism (mitigated by the
  documented convention and by `unwrap` bridging the two).
- **Discipline required.** Nothing in the language forces a boundary to return
  `Result`; the convention is upheld by review and consistency, not by the
  compiler.
- **Async ergonomics.** `Promise<Result<…>>` means handling rejection _and_ the
  `Err` arm conceptually, though in practice boundaries resolve to `Result` and
  reserve rejection for bugs.

## Alternatives considered

1. **Throw everywhere (idiomatic JS).** Rejected: failures are invisible to
   types, easy to forget, and hard to enumerate — unacceptable for a trust
   product whose error handling _is_ the feature.
2. **Throw typed error subclasses + document them.** Still invisible to the type
   checker; documentation rots and `catch (e: unknown)` erases the type anyway.
3. **A heavier FP library (Effect, fp-ts `Either`/`TaskEither`).** More powerful,
   but adds a large dependency and a steep learning curve to a core library that
   prizes minimal dependencies. Our hand-rolled `Result` is ~50 lines, dependency
   free, and covers the need.
4. **Nullable returns (`T | null`).** Loses the _reason_ for failure — fine for
   "not found by id" lookups (which we do use), but inadequate for validation,
   conflict, denial, and budget errors that must carry a code and details.
