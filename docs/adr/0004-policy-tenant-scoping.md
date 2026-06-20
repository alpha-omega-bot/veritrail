# ADR 0004: Tenant scoping for permission policies

- **Status:** Accepted
- **Date:** 2026-06-20
- **Deciders:** Veritrail engineering

## Context

The server's API keys (and OIDC principals) can carry a `labelScope` — a set of
exact ledger labels such as `{ tenant: 'acme', project: 'alpha' }`. Scoped
principals already see tenant-partitioned views of every _ledger projection_:
audit events, spend, decisions, evidence, vendor risk, and forensics/rollback all
filter their reads (and stamp their writes) by the principal's label scope.

Permissions is the one capability that did **not** participate, and it is
structurally different. Per [ADR-0001](./0001-single-ledger-spine.md) and the
"one ledger, no parallel store" invariant, the permissions engine holds its
policy rules as **operator configuration in memory** — `this.#policies`, a `Map`
— not as ledger facts. The _decisions_ it makes are appended to the ledger
(`policy.evaluated`, `action.authorized`, `action.denied`), but the _rules_ are
config. So there is no `event.labels` envelope on a policy to filter on, and the
mechanical projection-scoping used for the other modules does not apply.

Leaving permissions global created a correctness gap for multi-tenant
deployments: a single global policy set governs every tenant's actions, and a
tenant operator scoped to `tenant=acme` cannot manage its own rules without
seeing and editing every other tenant's. The dangerous half-measure — let a
scoped admin create policies but apply all policies to everyone — would let one
tenant's admin author a rule that silently governs another tenant's actions.

## Decision

Give a **policy an optional tenant scope**, keep global policies as the default,
and partition evaluation and management by the principal's label scope.

1. **Schema.** `PolicySchema` gains an optional `tenant: LabelsSchema`. A policy
   **without** `tenant` is **global** and applies to every tenant — this is the
   pre-existing v0.1 behavior, so existing policies and callers are unchanged. A
   policy **with** `tenant` applies only to principals whose label scope matches
   every one of those labels.

2. **Evaluation.** `evaluate`/`enforce` take an optional `scope` (the principal's
   label scope). The candidate set is filtered to policies that are **global OR
   in-scope** for that principal before the existing priority/effect ranking runs.
   A principal with **no** scope (an unscoped operator/admin) sees **all**
   policies, global and tenant-specific. Deny-by-default is preserved unchanged:
   when no in-scope policy matches, the configured default effect (`deny`) still
   applies, so a tenant is never left implicitly `allow` by partitioning.

3. **Management is scope-confined (the safety rule).** A label-scoped admin may
   create and remove policies **only within its own scope**: the server stamps a
   scoped admin's `labelScope` onto the policy's `tenant`, rejects a create whose
   body names a different tenant, and hides out-of-scope policies from a scoped
   admin's list/delete. Only an **unscoped** admin can create or remove **global**
   policies. This closes the footgun: a tenant admin can never author a rule that
   governs another tenant.

4. **Emitted facts** keep carrying the acting principal's labels (on
   `policy.evaluated` / `action.authorized` / `action.denied`), so a tenant's
   audit/forensics projections see exactly its own enforcement decisions —
   consistent with every other scoped write route.

The policy store stays a single in-memory `Map`; the tenant lives on each
`Policy`, and filtering happens at evaluate/list time. We do **not** introduce a
separate per-tenant store (that would re-create the "parallel source of truth"
problem at the config layer) and we do **not** move policies onto the ledger in
this change — versioning policies as ledger facts is the larger
[policy-as-code](../../ROADMAP.md) milestone and is explicitly out of scope here.

## Consequences

### Positive

- Multi-tenant deployments get real policy isolation: a tenant operator manages
  only its own rules, while org-wide rules remain expressible as global policies.
- Deny-by-default and the existing priority/effect ranking are untouched; the
  only change to evaluation is a pre-filter of the candidate set.
- Backward compatible: a policy with no `tenant` behaves exactly as before, so
  existing single-tenant deployments and tests need no change.
- No new store and no ledger-schema change — the trust core's invariants hold.

### Negative / costs

- Global policies still apply to every tenant by design. That is the intended
  semantics for org-wide rules, but operators must understand that a global
  `deny` governs all tenants; the safety rule ensures only an unscoped admin can
  create one.
- The tenant match is exact-label containment, mirroring the rest of the system;
  it is not (yet) a hierarchy or wildcard model. Richer composition is deferred to
  policy-as-code.
- Policies remain in-memory config, so tenant policy sets are not themselves
  tamper-evident history. Recording policy changes as ledger facts (already done
  for the _administrative action_ via `admin.action`) remains the audit trail;
  full policy versioning is future work.

## Alternatives considered

1. **Separate policy store per tenant.** Rejected: re-introduces parallel sources
   of truth at the config layer and complicates global rules; a single map with a
   tenant field on each policy is simpler and sufficient.
2. **Move policies onto the ledger as `policy.defined` events.** This is the
   right long-term model (versioning, audit, replay) but is the policy-as-code
   milestone, not a scoping fix. Doing it here would couple a security gap-closure
   to a large redesign and delay both.
3. **Label only the emitted decision facts, keep policies global.** Rejected: a
   tenant operator still could not manage its own rules, and global policies would
   silently govern every tenant — the exact footgun this ADR exists to prevent.
4. **Match policy tenant against the action's actor labels** (like
   `PolicyMatch.labels`). Rejected as the _scoping_ mechanism: scoping must follow
   the authenticated principal's label scope (consistent with every other route),
   independent of attacker-influenced action content. `PolicyMatch.labels`
   remains available as an orthogonal matching condition.
