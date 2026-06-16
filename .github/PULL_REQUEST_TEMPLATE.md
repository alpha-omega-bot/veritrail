# Summary

<!-- What does this change do, and why? Link the issue it closes. -->

Closes #

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds capability)
- [ ] Breaking change (fix or feature that changes existing behaviour)
- [ ] Docs / tooling only

## Trust & correctness checklist

- [ ] New inputs are validated at the boundary with a schema (no unchecked `any` crossing a trust boundary).
- [ ] Changes to the ledger or its hashing preserve append-only, tamper-evident semantics (and `verify()` still passes).
- [ ] Errors are returned via `Result`, not thrown across module boundaries (unless a documented invariant is violated).
- [ ] New behaviour has tests, including at least one failure / adversarial case.
- [ ] Safe-by-default: the change does not loosen a default toward "allow"/"unbounded" without an explicit opt-in.

## Verification

```
pnpm run verify   # format:check + lint + typecheck + test
```

<!-- Paste relevant output or describe manual testing. -->
