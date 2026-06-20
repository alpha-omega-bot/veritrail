# @veritrail/permissions

A **deny-by-default** policy engine that gates agent actions. One of the eight
governance engines in [Veritrail](../../../README.md); like every module it is a
projection over (and writer to) the single tamper-evident `@veritrail/core`
ledger — there is no separate decision store.

## What it does

- Holds an in-memory set of `Policy` rules (validated with the core
  `PolicySchema`).
- **Evaluates** an action against those rules as a pure function: among enabled
  policies whose `match` block applies, the highest `priority` wins; equal
  priorities resolve `deny > require_approval > allow`. When nothing matches it
  applies the configured default effect, which defaults to **`deny`** — the safe
  default.
- **Enforces** a decision by appending the corresponding facts to the ledger,
  so every gate is auditable and hash-chained.

## Public API

```ts
type PolicyDecision = { effect: PolicyEffect; matchedPolicyId?: string; reason: string };

interface PermissionsConfig {
  defaultEffect?: PolicyEffect; // default 'deny'
}

class PermissionsModule implements VeritrailModule {
  readonly info: { name: '@veritrail/permissions'; version: '0.1.0'; capability: 'permissions' };
  constructor(ctx: ModuleContext, config?: PermissionsConfig);

  addPolicy(input: unknown): Result<Policy, VeritrailError>; // mints id via ids.next('pol') if absent
  removePolicy(id: string): boolean;
  listPolicies(scope?: PolicyScope): Policy[]; // priority desc; scope filters to global + in-scope

  evaluate(action: Action, opts?: { actor?: Actor; scope?: PolicyScope }): PolicyDecision; // PURE, no I/O
  enforce(
    action: Action,
    opts?: { actor?: Actor; scope?: PolicyScope; labels?: Readonly<Record<string, string>> },
  ): Promise<Result<PolicyDecision, VeritrailError>>;
}

// PolicyScope = Readonly<Record<string, string>> — a principal's exact tenant labels.

function createPermissionsModule(ctx: ModuleContext, config?: PermissionsConfig): PermissionsModule;
```

### Tenant scoping (`Policy.tenant`)

A policy with no `tenant` is **global** and applies to every principal. A policy
with `tenant` labels applies only to a principal whose `scope` contains every one
of those labels. `listPolicies`/`evaluate`/`enforce` take an optional `scope`:
when set, only global and in-scope policies are considered, so a tenant is judged
only by the rules that govern it. **Deny-by-default is preserved** — when no
in-scope policy matches, the default effect (`deny`) still applies, so
partitioning never implicitly allows. An unscoped principal (no `scope`) sees
every policy. `enforce`'s `labels` are stamped onto the emitted
`policy.evaluated` / `action.authorized` / `action.denied` facts so each tenant's
projections see only its own enforcement decisions. See
[ADR-0004](../../../docs/adr/0004-policy-tenant-scoping.md).

### Matching semantics (`Policy.match`)

An empty `match` (`{}`) matches everything. All present conditions must hold
(AND); within a list, any element matching is enough (OR).

| Condition     | Meaning                                                                       |
| ------------- | ----------------------------------------------------------------------------- |
| `actorKinds`  | requires `opts.actor`; matches `actor.kind`. Missing actor → fails.           |
| `actorIds`    | matches `action.actorId`.                                                     |
| `actionTypes` | exact, or trailing-`*` prefix glob (e.g. `http.*`).                           |
| `targets`     | glob against `action.target` (`*` → `.*`, all other regex metachars escaped). |
| `minRisk`     | `action.risk` set **and** `RISK_ORDER[action.risk] >= RISK_ORDER[minRisk]`.   |
| `labels`      | every key/value present in `opts.actor?.labels`.                              |

### Enforcement → ledger effects

`enforce` always appends a `policy.evaluated` event, then:

- **allow** → appends `action.authorized`; returns `ok(decision)`.
- **deny** → appends `action.denied`; returns `err(POLICY_DENIED)`.
- **require_approval** → appends nothing further; returns `ok(decision)`.

## Example

```ts
import {
  createInMemoryLedger,
  FixedClock,
  SequentialIdGenerator,
  noopLogger,
  isErr,
} from '@veritrail/core';
import { createPermissionsModule } from '@veritrail/permissions';

const ledger = createInMemoryLedger({ clock: new FixedClock(0), ids: new SequentialIdGenerator() });
const perms = createPermissionsModule({
  ledger,
  clock: new FixedClock(0),
  ids: new SequentialIdGenerator(),
  logger: noopLogger,
});

perms.addPolicy({
  name: 'allow read-only HTTP to our API',
  effect: 'allow',
  priority: 10,
  match: { actionTypes: ['http.*'], targets: ['https://api.example.com/*'] },
});

const action = {
  id: 'act_1',
  actorId: 'agent_1',
  type: 'http.request',
  target: 'https://api.example.com/v1/users',
  params: {},
  reversible: false,
  status: 'proposed',
  context: {},
} as const;

const result = await perms.enforce(action);
if (isErr(result)) {
  console.error('denied:', result.error.message); // POLICY_DENIED on deny
}
// On allow, the ledger now holds policy.evaluated + action.authorized.
```

## Notes

- Policies live in memory; the _ledger_ is the durable system of record for
  every evaluated decision. Re-registering policies on startup is the caller's
  responsibility (Phase 1 will add policy lifecycle events).
- No `console.*`: diagnostics go through the injected `ctx.logger`.
