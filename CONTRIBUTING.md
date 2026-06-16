# Contributing to Veritrail

Thanks for helping build trustworthy infrastructure for AI agents. This guide
gets you productive and explains the standards we hold the code to.

## Prerequisites

- **Node** ≥ 20.11 (see [`.nvmrc`](./.nvmrc) — `nvm use`).
- **pnpm** 9 via Corepack: `corepack enable && corepack prepare pnpm@9.15.0 --activate`.

## Setup

```bash
git clone https://github.com/veritrail/veritrail
cd veritrail
pnpm install
pnpm run verify   # format:check + lint + typecheck + test  (run this before pushing)
```

Useful scripts:

| Command                              | What it does                          |
| ------------------------------------ | ------------------------------------- |
| `pnpm test`                          | Run the full test suite (Vitest).     |
| `pnpm test:watch`                    | Watch mode.                           |
| `pnpm test:coverage`                 | Tests with coverage.                  |
| `pnpm typecheck`                     | Strict typecheck across all packages. |
| `pnpm lint` / `lint:fix`             | ESLint.                               |
| `pnpm format`                        | Prettier write.                       |
| `pnpm build`                         | Build all publishable packages.       |
| `pnpm --filter @veritrail/core test` | Test a single package.                |

Tests and typecheck resolve workspace packages **from source**, so you don't need
to build before testing.

## Repository conventions

These are enforced by CI; matching them locally avoids round-trips.

### TypeScript

- **ESM + NodeNext.** Every relative import ends in `.js`
  (`import { x } from './engine.js'`). Import packages by name
  (`import { Ledger } from '@veritrail/core'`).
- **Strict everything**: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
  `noUnused*`, `verbatimModuleSyntax`. Use `import type` for type-only imports.
  For optional properties, conditionally spread rather than assign `undefined`.

### Correctness & trust

- **Validate untrusted input with Zod** at the boundary. Reuse core schemas.
- **Return `Result<T, VeritrailError>`** for expected failures; throw only for
  invariant violations. ([ADR-0002](./docs/adr/0002-result-over-exceptions.md))
- **Never weaken a safe default** (deny → allow, hard-stop → soft, tamper-evident →
  off) without an explicit, documented opt-in.
- **Money is integer minor units.** Never use floats for amounts.
- **Don't bypass the ledger.** New capabilities project over events; they don't
  create a parallel store. New facts extend `EventInputSchema`.

### Style

- Small, focused files; doc comments on exported symbols; no dead code.
- Logging goes through the `Logger` port — no `console.*` in library code.
- Time and ids come from the `Clock`/`IdGenerator` ports — never `Date.now()` or
  random directly in domain code (it breaks determinism and auditability).

## Tests

- Every change ships with tests, including at least one **failure/adversarial**
  case. Changes to the ledger or hashing must keep `verify()` green and add a
  tamper case if relevant.
- Use `createInMemoryLedger({ clock: new FixedClock(...), ids: new
SequentialIdGenerator() })` for deterministic ledgers.

## Commits & PRs

- Use clear, imperative commit subjects (Conventional Commits encouraged:
  `feat(spend-guard): …`, `fix(core): …`, `docs: …`).
- Fill in the [PR template](./.github/PULL_REQUEST_TEMPLATE.md), including the
  trust & correctness checklist.
- Keep PRs focused. Touching the core or `@veritrail/audit` requests core-team
  review (see [CODEOWNERS](./CODEOWNERS)).
- Security-relevant changes: link the relevant threat ID in
  [`docs/THREAT-MODEL.md`](./docs/THREAT-MODEL.md). For vulnerabilities, follow
  [SECURITY.md](./SECURITY.md) — do not open a public issue.

## Adding a new package

1. Create `packages/<name>/` with a `package.json` (`@veritrail/<name>`) and a
   `tsconfig.json` extending the root base (see `packages/modules/audit` for the
   template).
2. Add its name → source path to the `paths` map in `tsconfig.json` and the alias
   map in `vitest.config.ts` so it resolves from source.
3. Modules implement `VeritrailModule` and are constructed from a `ModuleContext`.

## Code of conduct

Participation is governed by our [Code of Conduct](./CODE_OF_CONDUCT.md).
