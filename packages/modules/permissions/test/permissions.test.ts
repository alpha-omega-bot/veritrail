import { describe, expect, it } from 'vitest';

import type { Action, Actor, Ledger } from '@veritrail/core';
import {
  FixedClock,
  SequentialIdGenerator,
  createInMemoryLedger,
  isErr,
  isOk,
  noopLogger,
} from '@veritrail/core';

import type { ModuleContext } from '@veritrail/core';
import { PermissionsModule, createPermissionsModule, globToRegExp } from '../src/index.js';

function makeCtx(): { ctx: ModuleContext; ledger: Ledger } {
  const ledger = createInMemoryLedger({
    clock: new FixedClock(1_700_000_000_000),
    ids: new SequentialIdGenerator(),
  });
  const ctx: ModuleContext = {
    ledger,
    clock: new FixedClock(1_700_000_000_000),
    ids: new SequentialIdGenerator(),
    logger: noopLogger,
  };
  return { ctx, ledger };
}

function action(overrides: Partial<Action> = {}): Action {
  return {
    id: 'act_1',
    actorId: 'agent_1',
    type: 'http.request',
    target: 'https://api.example.com/v1/users',
    params: {},
    reversible: false,
    status: 'proposed',
    context: {},
    ...overrides,
  };
}

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    id: 'agent_1',
    kind: 'agent',
    name: 'Test Agent',
    labels: {},
    ...overrides,
  };
}

describe('PermissionsModule.info', () => {
  it('exposes the permissions capability', () => {
    const { ctx } = makeCtx();
    const mod = new PermissionsModule(ctx);
    expect(mod.info).toEqual({
      name: '@veritrail/permissions',
      version: '0.1.0',
      capability: 'permissions',
    });
  });
});

describe('addPolicy / validation', () => {
  it('mints an id when absent and stores the policy', () => {
    const { ctx } = makeCtx();
    const mod = createPermissionsModule(ctx);
    const res = mod.addPolicy({ name: 'allow all', effect: 'allow' });
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.id).toMatch(/^pol_/);
    expect(mod.listPolicies()).toHaveLength(1);
  });

  it('respects a caller-supplied id', () => {
    const { ctx } = makeCtx();
    const mod = createPermissionsModule(ctx);
    const res = mod.addPolicy({ id: 'pol_custom', name: 'p', effect: 'deny' });
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.id).toBe('pol_custom');
  });

  it('returns a VALIDATION error for malformed input', () => {
    const { ctx } = makeCtx();
    const mod = createPermissionsModule(ctx);
    const res = mod.addPolicy({ name: 'bad', effect: 'maybe' });
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe('VALIDATION');
  });

  it('returns a VALIDATION error for non-object input', () => {
    const { ctx } = makeCtx();
    const mod = createPermissionsModule(ctx);
    expect(isErr(mod.addPolicy(null))).toBe(true);
    expect(isErr(mod.addPolicy('nope'))).toBe(true);
  });
});

describe('removePolicy / listPolicies', () => {
  it('removes by id and reports success', () => {
    const { ctx } = makeCtx();
    const mod = createPermissionsModule(ctx);
    const res = mod.addPolicy({ id: 'pol_x', name: 'x', effect: 'allow' });
    expect(isOk(res)).toBe(true);
    expect(mod.removePolicy('pol_x')).toBe(true);
    expect(mod.removePolicy('pol_x')).toBe(false);
    expect(mod.listPolicies()).toHaveLength(0);
  });

  it('lists policies by priority descending', () => {
    const { ctx } = makeCtx();
    const mod = createPermissionsModule(ctx);
    mod.addPolicy({ id: 'pol_lo', name: 'lo', effect: 'allow', priority: 1 });
    mod.addPolicy({ id: 'pol_hi', name: 'hi', effect: 'allow', priority: 10 });
    mod.addPolicy({ id: 'pol_mid', name: 'mid', effect: 'allow', priority: 5 });
    expect(mod.listPolicies().map((p) => p.id)).toEqual(['pol_hi', 'pol_mid', 'pol_lo']);
  });
});

describe('evaluate — deny by default', () => {
  it('denies when there are no policies', () => {
    const { ctx } = makeCtx();
    const mod = createPermissionsModule(ctx);
    const decision = mod.evaluate(action());
    expect(decision.effect).toBe('deny');
    expect(decision.matchedPolicyId).toBeUndefined();
    expect(decision.reason).toContain('default');
  });

  it('honours a configured non-deny default', () => {
    const { ctx } = makeCtx();
    const mod = createPermissionsModule(ctx, { defaultEffect: 'require_approval' });
    expect(mod.evaluate(action()).effect).toBe('require_approval');
  });

  it('ignores disabled policies (still falls through to default)', () => {
    const { ctx } = makeCtx();
    const mod = createPermissionsModule(ctx);
    mod.addPolicy({ id: 'pol_off', name: 'off', effect: 'allow', enabled: false });
    expect(mod.evaluate(action()).effect).toBe('deny');
  });
});

describe('evaluate — matching', () => {
  it('matches an empty match block against any action', () => {
    const { ctx } = makeCtx();
    const mod = createPermissionsModule(ctx);
    mod.addPolicy({ id: 'pol_all', name: 'all', effect: 'allow' });
    const d = mod.evaluate(action());
    expect(d.effect).toBe('allow');
    expect(d.matchedPolicyId).toBe('pol_all');
  });

  it('matches actorIds against action.actorId', () => {
    const { ctx } = makeCtx();
    const mod = createPermissionsModule(ctx);
    mod.addPolicy({ id: 'pol_a', name: 'a', effect: 'allow', match: { actorIds: ['agent_1'] } });
    expect(mod.evaluate(action({ actorId: 'agent_1' })).effect).toBe('allow');
    expect(mod.evaluate(action({ actorId: 'agent_2' })).effect).toBe('deny');
  });

  it('matches actorKinds only when an actor is supplied', () => {
    const { ctx } = makeCtx();
    const mod = createPermissionsModule(ctx);
    mod.addPolicy({ id: 'pol_k', name: 'k', effect: 'allow', match: { actorKinds: ['human'] } });
    expect(mod.evaluate(action(), { actor: actor({ kind: 'human' }) }).effect).toBe('allow');
    expect(mod.evaluate(action(), { actor: actor({ kind: 'agent' }) }).effect).toBe('deny');
    // No actor at all -> condition fails -> default deny.
    expect(mod.evaluate(action()).effect).toBe('deny');
  });
});

describe('evaluate — actionType and target wildcards', () => {
  it('supports a trailing * on actionTypes', () => {
    const { ctx } = makeCtx();
    const mod = createPermissionsModule(ctx);
    mod.addPolicy({ id: 'pol_t', name: 't', effect: 'allow', match: { actionTypes: ['http.*'] } });
    expect(mod.evaluate(action({ type: 'http.request' })).effect).toBe('allow');
    expect(mod.evaluate(action({ type: 'http.delete' })).effect).toBe('allow');
    expect(mod.evaluate(action({ type: 'db.write' })).effect).toBe('deny');
  });

  it('matches an exact actionType when no wildcard', () => {
    const { ctx } = makeCtx();
    const mod = createPermissionsModule(ctx);
    mod.addPolicy({
      id: 'pol_e',
      name: 'e',
      effect: 'allow',
      match: { actionTypes: ['db.write'] },
    });
    expect(mod.evaluate(action({ type: 'db.write' })).effect).toBe('allow');
    expect(mod.evaluate(action({ type: 'db.write.batch' })).effect).toBe('deny');
  });

  it('matches target globs with embedded wildcards', () => {
    const { ctx } = makeCtx();
    const mod = createPermissionsModule(ctx);
    mod.addPolicy({
      id: 'pol_g',
      name: 'g',
      effect: 'allow',
      match: { targets: ['https://api.example.com/*'] },
    });
    expect(mod.evaluate(action({ target: 'https://api.example.com/v1/users' })).effect).toBe(
      'allow',
    );
    expect(mod.evaluate(action({ target: 'https://evil.example.com/x' })).effect).toBe('deny');
  });

  it('escapes regex metacharacters in target patterns', () => {
    // A '.' must be literal, not a wildcard.
    expect(globToRegExp('a.b').test('axb')).toBe(false);
    expect(globToRegExp('a.b').test('a.b')).toBe(true);
    expect(globToRegExp('a*b').test('axxxb')).toBe(true);
  });
});

describe('evaluate — minRisk threshold', () => {
  it('matches only when action risk >= minRisk', () => {
    const { ctx } = makeCtx();
    const mod = createPermissionsModule(ctx);
    mod.addPolicy({ id: 'pol_r', name: 'r', effect: 'deny', match: { minRisk: 'high' } });
    expect(mod.evaluate(action({ risk: 'critical' })).effect).toBe('deny');
    expect(mod.evaluate(action({ risk: 'high' })).effect).toBe('deny');
    // medium is below high -> no match -> default deny too, so add an allow-all baseline.
    mod.addPolicy({ id: 'pol_base', name: 'base', effect: 'allow', priority: -1 });
    expect(mod.evaluate(action({ risk: 'medium' })).effect).toBe('allow');
    // No risk set on the action -> minRisk condition fails.
    expect(mod.evaluate(action()).effect).toBe('allow');
  });
});

describe('evaluate — labels', () => {
  it('requires every label key/value to be present on the actor', () => {
    const { ctx } = makeCtx();
    const mod = createPermissionsModule(ctx);
    mod.addPolicy({
      id: 'pol_l',
      name: 'l',
      effect: 'allow',
      match: { labels: { team: 'payments', env: 'prod' } },
    });
    const ok = actor({ labels: { team: 'payments', env: 'prod', extra: 'y' } });
    const partial = actor({ labels: { team: 'payments' } });
    expect(mod.evaluate(action(), { actor: ok }).effect).toBe('allow');
    expect(mod.evaluate(action(), { actor: partial }).effect).toBe('deny');
    expect(mod.evaluate(action()).effect).toBe('deny');
  });
});

describe('evaluate — priority and tie-break', () => {
  it('higher priority wins', () => {
    const { ctx } = makeCtx();
    const mod = createPermissionsModule(ctx);
    mod.addPolicy({ id: 'pol_allow', name: 'allow', effect: 'allow', priority: 1 });
    mod.addPolicy({ id: 'pol_deny', name: 'deny', effect: 'deny', priority: 5 });
    const d = mod.evaluate(action());
    expect(d.effect).toBe('deny');
    expect(d.matchedPolicyId).toBe('pol_deny');
  });

  it('equal priority resolves deny > require_approval > allow', () => {
    const { ctx } = makeCtx();
    const mod = createPermissionsModule(ctx);
    mod.addPolicy({ id: 'pol_allow', name: 'allow', effect: 'allow', priority: 3 });
    mod.addPolicy({ id: 'pol_appr', name: 'appr', effect: 'require_approval', priority: 3 });
    mod.addPolicy({ id: 'pol_deny', name: 'deny', effect: 'deny', priority: 3 });
    expect(mod.evaluate(action()).matchedPolicyId).toBe('pol_deny');

    mod.removePolicy('pol_deny');
    expect(mod.evaluate(action()).effect).toBe('require_approval');
  });
});

describe('enforce — ledger effects', () => {
  it('appends policy.evaluated + action.authorized on allow', async () => {
    const { ctx, ledger } = makeCtx();
    const mod = createPermissionsModule(ctx);
    mod.addPolicy({ id: 'pol_all', name: 'all', effect: 'allow' });

    const res = await mod.enforce(action());
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.effect).toBe('allow');

    const evaluated = await ledger.query({ types: ['policy.evaluated'] });
    const authorized = await ledger.query({ types: ['action.authorized'] });
    expect(evaluated).toHaveLength(1);
    expect(authorized).toHaveLength(1);
    const evt = evaluated[0];
    expect(evt).toBeDefined();
    if (evt && evt.event.type === 'policy.evaluated') {
      expect(evt.event.payload.effect).toBe('allow');
      expect(evt.event.payload.matchedPolicyId).toBe('pol_all');
      expect(evt.event.payload.actionId).toBe('act_1');
    }
    const auth = authorized[0];
    if (auth && auth.event.type === 'action.authorized') {
      expect(auth.event.payload.policyId).toBe('pol_all');
    }
  });

  it('appends action.denied and returns POLICY_DENIED on deny', async () => {
    const { ctx, ledger } = makeCtx();
    const mod = createPermissionsModule(ctx);
    // No policies -> deny by default.
    const res = await mod.enforce(action());
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe('POLICY_DENIED');

    const evaluated = await ledger.query({ types: ['policy.evaluated'] });
    const denied = await ledger.query({ types: ['action.denied'] });
    const authorized = await ledger.query({ types: ['action.authorized'] });
    expect(evaluated).toHaveLength(1);
    expect(denied).toHaveLength(1);
    expect(authorized).toHaveLength(0);
    const d = denied[0];
    if (d && d.event.type === 'action.denied') {
      expect(d.event.payload.actionId).toBe('act_1');
      expect(d.event.payload.reason).toContain('default');
    }
  });

  it('appends only policy.evaluated on require_approval', async () => {
    const { ctx, ledger } = makeCtx();
    const mod = createPermissionsModule(ctx);
    mod.addPolicy({ id: 'pol_appr', name: 'appr', effect: 'require_approval' });

    const res = await mod.enforce(action());
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.effect).toBe('require_approval');

    expect(await ledger.query({ types: ['policy.evaluated'] })).toHaveLength(1);
    expect(await ledger.query({ types: ['action.authorized'] })).toHaveLength(0);
    expect(await ledger.query({ types: ['action.denied'] })).toHaveLength(0);
  });

  it('keeps the ledger chain intact after enforcement', async () => {
    const { ctx, ledger } = makeCtx();
    const mod = createPermissionsModule(ctx);
    mod.addPolicy({ id: 'pol_all', name: 'all', effect: 'allow' });
    await mod.enforce(action());
    await mod.enforce(action({ id: 'act_2' }));
    const report = await ledger.verify();
    expect(report.ok).toBe(true);
  });
});

describe('tenant scoping', () => {
  const acme = { tenant: 'acme', project: 'alpha' };
  const other = { tenant: 'other', project: 'alpha' };

  function seeded(): PermissionsModule {
    const { ctx } = makeCtx();
    const mod = createPermissionsModule(ctx);
    // Global deny for email; acme-only allow for tools.
    mod.addPolicy({
      id: 'pol_global',
      name: 'global deny email',
      effect: 'deny',
      match: { actionTypes: ['email.*'] },
    });
    mod.addPolicy({
      id: 'pol_acme',
      name: 'acme allow tools',
      effect: 'allow',
      match: { actionTypes: ['tool.*'] },
      tenant: acme,
    });
    return mod;
  }

  it('lists global plus in-scope policies for a scoped principal', () => {
    const mod = seeded();
    expect(
      mod
        .listPolicies(acme)
        .map((p) => p.id)
        .sort(),
    ).toEqual(['pol_acme', 'pol_global']);
    expect(mod.listPolicies(other).map((p) => p.id)).toEqual(['pol_global']);
    // Unscoped sees everything.
    expect(
      mod
        .listPolicies()
        .map((p) => p.id)
        .sort(),
    ).toEqual(['pol_acme', 'pol_global']);
  });

  it('applies a tenant policy only within its scope', () => {
    const mod = seeded();
    const toolAction = action({ id: 'a', type: 'tool.search' });
    expect(mod.evaluate(toolAction, { scope: acme }).effect).toBe('allow');
    // Other tenant: the acme allow is filtered out, nothing matches → deny-default.
    expect(mod.evaluate(toolAction, { scope: other }).effect).toBe('deny');
  });

  it('always applies a global policy regardless of scope', () => {
    const mod = seeded();
    const emailAction = action({ id: 'a', type: 'email.send' });
    expect(mod.evaluate(emailAction, { scope: acme }).effect).toBe('deny');
    expect(mod.evaluate(emailAction, { scope: other }).effect).toBe('deny');
    expect(mod.evaluate(emailAction).effect).toBe('deny');
  });

  it('stamps the configured labels onto enforcement facts', async () => {
    const { ctx, ledger } = makeCtx();
    const mod = createPermissionsModule(ctx);
    mod.addPolicy({
      id: 'pol_acme',
      name: 'acme allow',
      effect: 'allow',
      match: { actionTypes: ['tool.*'] },
      tenant: acme,
    });
    const res = await mod.enforce(action({ id: 'a', type: 'tool.search' }), {
      scope: acme,
      labels: acme,
    });
    expect(isOk(res)).toBe(true);

    const authorized = await ledger.query({ types: ['action.authorized'] });
    expect(authorized[0]?.event.labels).toEqual(acme);
    const evaluated = await ledger.query({ types: ['policy.evaluated'] });
    expect(evaluated[0]?.event.labels).toEqual(acme);
  });
});
