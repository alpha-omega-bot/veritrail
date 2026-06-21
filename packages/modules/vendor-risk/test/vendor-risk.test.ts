import { describe, expect, it } from 'vitest';
import {
  FixedClock,
  SequentialIdGenerator,
  createInMemoryLedger,
  noopLogger,
  type ModuleContext,
  type VendorSignal,
} from '@veritrail/core';

import {
  bandFor,
  createVendorRiskModule,
  type MonitorSource,
  type VendorRiskModule,
} from '../src/index.js';

const START = 1_700_000_000_000;
const DAY = 86_400_000;

function setup(): { module: VendorRiskModule; ctx: ModuleContext; clock: FixedClock } {
  const clock = new FixedClock(START);
  const ledger = createInMemoryLedger({ clock, ids: new SequentialIdGenerator() });
  const ctx: ModuleContext = {
    ledger,
    clock,
    ids: new SequentialIdGenerator(),
    logger: noopLogger,
  };
  return { module: createVendorRiskModule(ctx), ctx, clock };
}

describe('VendorRiskModule.info', () => {
  it('declares the vendor-risk capability', () => {
    const { module } = setup();
    expect(module.info).toEqual({
      name: '@veritrail/vendor-risk',
      version: '0.1.0',
      capability: 'vendor-risk',
    });
  });
});

describe('register + listVendors', () => {
  it('assigns an id and projects the inventory', async () => {
    const { module } = setup();
    const res = await module.register({ name: 'OpenAI', category: 'llm', criticality: 'high' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.event.type).toBe('vendor.registered');

    const vendors = await module.listVendors();
    expect(vendors).toHaveLength(1);
    const v = vendors[0];
    expect(v?.name).toBe('OpenAI');
    expect(v?.id).toMatch(/^ven_/);
  });

  it('respects a caller-supplied id', async () => {
    const { module } = setup();
    await module.register({ id: 'ven_custom', name: 'Acme', category: 'api' });
    const vendors = await module.listVendors();
    expect(vendors[0]?.id).toBe('ven_custom');
  });

  it('rejects invalid vendor input with a VALIDATION error', async () => {
    const { module } = setup();
    const res = await module.register({ name: '', category: 'nope' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('VALIDATION');
  });
});

describe('recordSignal + signalsFor', () => {
  it('records a signal and projects it for the vendor', async () => {
    const { module } = setup();
    const reg = await module.register({ id: 'ven_1', name: 'Acme', category: 'api' });
    expect(reg.ok).toBe(true);

    const sig = await module.recordSignal({
      vendorId: 'ven_1',
      kind: 'incident',
      severity: 'high',
      summary: 'API outage',
    });
    expect(sig.ok).toBe(true);
    if (sig.ok) expect(sig.value.event.type).toBe('vendor.signal');

    const signals = await module.signalsFor('ven_1');
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe('high');
    expect(signals[0]?.id).toMatch(/^sig_/);
  });

  it('does not leak signals across vendors', async () => {
    const { module } = setup();
    await module.register({ id: 'ven_a', name: 'A', category: 'api' });
    await module.register({ id: 'ven_b', name: 'B', category: 'api' });
    await module.recordSignal({
      vendorId: 'ven_a',
      kind: 'breach',
      severity: 'critical',
      summary: 'x',
    });
    expect(await module.signalsFor('ven_a')).toHaveLength(1);
    expect(await module.signalsFor('ven_b')).toHaveLength(0);
  });

  it('rejects an invalid signal', async () => {
    const { module } = setup();
    const res = await module.recordSignal({
      vendorId: 'ven_1',
      kind: 'incident',
      severity: 'nope',
      summary: 'x',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('VALIDATION');
  });
});

describe('score', () => {
  it('returns NOT_FOUND for an unknown vendor', async () => {
    const { module } = setup();
    const res = await module.score('ven_missing');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('NOT_FOUND');
  });

  it('scores criticality baseline with no signals', async () => {
    const { module } = setup();
    await module.register({ id: 'ven_1', name: 'Acme', category: 'api', criticality: 'medium' });
    const res = await module.score('ven_1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.score).toBe(10); // medium base
    expect(res.value.band).toBe('low');
    expect(res.value.signalCount).toBe(0);
  });

  it('reflects severity weight', async () => {
    const { module } = setup();
    await module.register({ id: 'ven_1', name: 'Acme', category: 'api', criticality: 'low' });
    await module.recordSignal({
      vendorId: 'ven_1',
      kind: 'breach',
      severity: 'critical',
      summary: 'x',
    });
    const res = await module.score('ven_1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // low base (5) + critical weight (20) * decay(0) = 25
    expect(res.value.score).toBe(25);
    expect(res.value.band).toBe('medium');
  });

  it('decays signal contribution over time (half-life ~30 days)', async () => {
    const { module, clock } = setup();
    await module.register({ id: 'ven_1', name: 'Acme', category: 'api', criticality: 'low' });
    await module.recordSignal({
      vendorId: 'ven_1',
      kind: 'breach',
      severity: 'critical',
      summary: 'x',
    });

    // After 30 days the critical weight (20) halves to 10. 5 + 10 = 15.
    clock.advance(30 * DAY);
    const at30 = await module.score('ven_1');
    expect(at30.ok).toBe(true);
    if (at30.ok) expect(at30.value.score).toBe(15);

    // After 60 days total it quarters to 5. 5 + 5 = 10.
    clock.advance(30 * DAY);
    const at60 = await module.score('ven_1');
    expect(at60.ok).toBe(true);
    if (at60.ok) expect(at60.value.score).toBe(10);
  });

  it('returns up to 3 highest-severity signals as topSignals', async () => {
    const { module } = setup();
    await module.register({ id: 'ven_1', name: 'Acme', category: 'api' });
    for (const severity of ['info', 'low', 'medium', 'high', 'critical'] as const) {
      await module.recordSignal({
        vendorId: 'ven_1',
        kind: 'incident',
        severity,
        summary: severity,
      });
    }
    const res = await module.score('ven_1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.signalCount).toBe(5);
    expect(res.value.topSignals.map((s) => s.severity)).toEqual(['critical', 'high', 'medium']);
  });
});

describe('assess', () => {
  it('scores every vendor sorted by score descending', async () => {
    const { module } = setup();
    await module.register({ id: 'ven_low', name: 'Low', category: 'api', criticality: 'low' });
    await module.register({
      id: 'ven_high',
      name: 'High',
      category: 'api',
      criticality: 'critical',
    });
    await module.recordSignal({
      vendorId: 'ven_high',
      kind: 'breach',
      severity: 'critical',
      summary: 'x',
    });

    const results = await module.assess();
    expect(results.map((r) => r.vendorId)).toEqual(['ven_high', 'ven_low']);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it('returns an empty list when there are no vendors', async () => {
    const { module } = setup();
    expect(await module.assess()).toEqual([]);
  });
});

describe('ingest', () => {
  it('polls a source and records every valid signal', async () => {
    const { module } = setup();
    await module.register({ id: 'ven_1', name: 'Acme', category: 'api' });

    const source: MonitorSource = {
      name: 'stub-feed',
      async poll(): Promise<VendorSignal[]> {
        return [
          {
            id: 's1',
            vendorId: 'ven_1',
            kind: 'incident',
            severity: 'high',
            summary: 'a',
            source: 'stub',
          },
          {
            id: 's2',
            vendorId: 'ven_1',
            kind: 'degradation',
            severity: 'low',
            summary: 'b',
            source: 'stub',
          },
        ];
      },
    };

    const count = await module.ingest(source);
    expect(count).toBe(2);
    expect(await module.signalsFor('ven_1')).toHaveLength(2);
  });

  it('skips invalid signals and counts only those recorded', async () => {
    const { module } = setup();
    await module.register({ id: 'ven_1', name: 'Acme', category: 'api' });

    const source: MonitorSource = {
      name: 'bad-feed',
      async poll(): Promise<VendorSignal[]> {
        return [
          {
            id: 's1',
            vendorId: 'ven_1',
            kind: 'incident',
            severity: 'high',
            summary: 'ok',
            source: '',
          },
          // invalid severity, cast through unknown for the adversarial case
          {
            id: 's2',
            vendorId: 'ven_1',
            kind: 'incident',
            severity: 'boom',
            summary: 'bad',
            source: '',
          } as unknown as VendorSignal,
        ];
      },
    };

    const count = await module.ingest(source);
    expect(count).toBe(1);
  });
});

describe('bandFor thresholds', () => {
  it('maps scores to bands', () => {
    expect(bandFor(0)).toBe('low');
    expect(bandFor(19)).toBe('low');
    expect(bandFor(20)).toBe('medium');
    expect(bandFor(49)).toBe('medium');
    expect(bandFor(50)).toBe('high');
    expect(bandFor(99)).toBe('high');
    expect(bandFor(100)).toBe('critical');
  });
});

describe('tenant label scoping', () => {
  it('writes optional ledger labels onto vendor and signal facts', async () => {
    const { module, ctx } = setup();
    const reg = await module.register(
      { id: 'ven_1', name: 'Acme', category: 'api' },
      { labels: { tenant: 'acme', project: 'alpha' } },
    );
    expect(reg.ok).toBe(true);
    const sig = await module.recordSignal(
      { vendorId: 'ven_1', kind: 'incident', severity: 'high', summary: 'x' },
      { labels: { tenant: 'acme', project: 'alpha' } },
    );
    expect(sig.ok).toBe(true);

    const registered = await ctx.ledger.query({ types: ['vendor.registered'] });
    expect(registered[0]?.event.labels).toEqual({ tenant: 'acme', project: 'alpha' });
    const signals = await ctx.ledger.query({ types: ['vendor.signal'] });
    expect(signals[0]?.event.labels).toEqual({ tenant: 'acme', project: 'alpha' });
  });

  it('filters listVendors and signalsFor by ledger labels', async () => {
    const { module } = setup();
    const acme = { labels: { tenant: 'acme', project: 'alpha' } };
    const other = { labels: { tenant: 'other', project: 'alpha' } };
    await module.register({ id: 'ven_acme', name: 'Acme', category: 'api' }, acme);
    await module.register({ id: 'ven_other', name: 'Other', category: 'api' }, other);
    await module.recordSignal(
      { vendorId: 'ven_acme', kind: 'incident', severity: 'high', summary: 'a' },
      acme,
    );
    await module.recordSignal(
      { vendorId: 'ven_other', kind: 'incident', severity: 'high', summary: 'b' },
      other,
    );

    const scopedVendors = await module.listVendors(acme);
    expect(scopedVendors.map((v) => v.id)).toEqual(['ven_acme']);
    expect(await module.signalsFor('ven_acme', acme)).toHaveLength(1);
    // A scoped reader cannot see another tenant's signals even by id.
    expect(await module.signalsFor('ven_other', acme)).toHaveLength(0);
  });

  it('scopes score and assess to the projection labels', async () => {
    const { module } = setup();
    const acme = { labels: { tenant: 'acme', project: 'alpha' } };
    const other = { labels: { tenant: 'other', project: 'alpha' } };
    await module.register({ id: 'ven_acme', name: 'Acme', category: 'api' }, acme);
    await module.register({ id: 'ven_other', name: 'Other', category: 'api' }, other);

    const assessed = await module.assess(acme);
    expect(assessed.map((s) => s.vendorId)).toEqual(['ven_acme']);

    // Another tenant's vendor is NOT_FOUND under this scope, not silently scored.
    const crossScope = await module.score('ven_other', acme);
    expect(crossScope.ok).toBe(false);
    if (!crossScope.ok) expect(crossScope.error.code).toBe('NOT_FOUND');
  });
});

describe('alert thresholds', () => {
  function setupWithAlert(alertBand: 'low' | 'medium' | 'high' | 'critical'): {
    module: VendorRiskModule;
    ctx: ModuleContext;
  } {
    const clock = new FixedClock(START);
    const ledger = createInMemoryLedger({ clock, ids: new SequentialIdGenerator() });
    const ctx: ModuleContext = {
      ledger,
      clock,
      ids: new SequentialIdGenerator(),
      logger: noopLogger,
    };
    return { module: createVendorRiskModule(ctx, { alertBand }), ctx };
  }

  async function notes(ctx: ModuleContext): Promise<Array<{ data?: Record<string, unknown> }>> {
    const records = await ctx.ledger.query({ types: ['note'] });
    return records.flatMap((r) =>
      r.event.type === 'note' ? [r.event.payload as { data?: Record<string, unknown> }] : [],
    );
  }

  it('appends a note when a signal raises the score up across the alert band', async () => {
    const { module, ctx } = setupWithAlert('medium');
    // low-criticality base = 5 (low); one critical signal = +20 → 25 (medium).
    await module.register({ id: 'ven_1', name: 'Acme', category: 'api', criticality: 'low' });
    await module.recordSignal({
      vendorId: 'ven_1',
      kind: 'breach',
      severity: 'critical',
      summary: 'x',
    });

    const alerts = await notes(ctx);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.data).toMatchObject({
      kind: 'vendor-risk.alert',
      vendorId: 'ven_1',
      fromBand: 'low',
      toBand: 'medium',
      alertBand: 'medium',
    });
  });

  it('does not alert when no alertBand is configured (default)', async () => {
    const { module, ctx } = setup(); // no alertBand
    await module.register({ id: 'ven_1', name: 'Acme', category: 'api', criticality: 'low' });
    await module.recordSignal({
      vendorId: 'ven_1',
      kind: 'breach',
      severity: 'critical',
      summary: 'x',
    });
    expect(await notes(ctx)).toHaveLength(0);
  });

  it('is edge-triggered: a vendor already in-band does not re-alert', async () => {
    const { module, ctx } = setupWithAlert('medium');
    await module.register({ id: 'ven_1', name: 'Acme', category: 'api', criticality: 'low' });
    // First critical → 25 (low→medium): alerts. Second → 45 (still medium): no alert.
    await module.recordSignal({
      vendorId: 'ven_1',
      kind: 'breach',
      severity: 'critical',
      summary: 'a',
    });
    await module.recordSignal({
      vendorId: 'ven_1',
      kind: 'breach',
      severity: 'critical',
      summary: 'b',
    });
    expect(await notes(ctx)).toHaveLength(1);
  });

  it('does not alert when the score stays below the configured band', async () => {
    const { module, ctx } = setupWithAlert('high');
    // One critical → 25 (medium), below the 'high' threshold (>=50).
    await module.register({ id: 'ven_1', name: 'Acme', category: 'api', criticality: 'low' });
    await module.recordSignal({
      vendorId: 'ven_1',
      kind: 'breach',
      severity: 'critical',
      summary: 'x',
    });
    expect(await notes(ctx)).toHaveLength(0);
  });

  it('alerts on the signal that finally crosses into a higher band', async () => {
    const { module, ctx } = setupWithAlert('high');
    // 3 criticals → 5 + 60 = 65 (high). Crossing happens on the 3rd signal.
    await module.register({ id: 'ven_1', name: 'Acme', category: 'api', criticality: 'low' });
    for (const summary of ['a', 'b', 'c']) {
      await module.recordSignal({
        vendorId: 'ven_1',
        kind: 'breach',
        severity: 'critical',
        summary,
      });
    }
    const alerts = await notes(ctx);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.data).toMatchObject({ toBand: 'high', alertBand: 'high' });
  });
});

describe('slaReport', () => {
  function setupSla(sla?: { windowMs?: number; atRiskAfter?: number; breachAfter?: number }): {
    module: VendorRiskModule;
    clock: FixedClock;
  } {
    const clock = new FixedClock(START);
    const ledger = createInMemoryLedger({ clock, ids: new SequentialIdGenerator() });
    const ctx: ModuleContext = {
      ledger,
      clock,
      ids: new SequentialIdGenerator(),
      logger: noopLogger,
    };
    return { module: createVendorRiskModule(ctx, sla ? { sla } : undefined), clock };
  }

  async function availability(
    module: VendorRiskModule,
    vendorId: string,
    severity: 'low' | 'high' = 'low',
  ): Promise<void> {
    const res = await module.recordSignal({
      vendorId,
      kind: 'availability',
      severity,
      summary: 'availability dip',
    });
    expect(res.ok).toBe(true);
  }

  it('returns NOT_FOUND for an unknown vendor', async () => {
    const { module } = setupSla();
    const res = await module.slaReport('ven_missing');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('NOT_FOUND');
  });

  it('is ok with no availability signals', async () => {
    const { module } = setupSla();
    await module.register({ id: 'ven_1', name: 'Acme', category: 'infra' });
    const res = await module.slaReport('ven_1');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.status).toBe('ok');
      expect(res.value.availabilitySignals).toBe(0);
    }
  });

  it('crosses ok → at_risk → breaching by default thresholds (1, 3)', async () => {
    const { module } = setupSla();
    await module.register({ id: 'ven_1', name: 'Acme', category: 'infra' });

    let res = await module.slaReport('ven_1');
    if (res.ok) expect(res.value.status).toBe('ok');

    await availability(module, 'ven_1');
    res = await module.slaReport('ven_1');
    if (res.ok) expect(res.value.status).toBe('at_risk');

    await availability(module, 'ven_1');
    await availability(module, 'ven_1');
    res = await module.slaReport('ven_1');
    if (res.ok) {
      expect(res.value.status).toBe('breaching');
      expect(res.value.availabilitySignals).toBe(3);
    }
  });

  it('only counts availability-kind signals, not other risk signals', async () => {
    const { module } = setupSla();
    await module.register({ id: 'ven_1', name: 'Acme', category: 'infra' });
    await module.recordSignal({
      vendorId: 'ven_1',
      kind: 'breach',
      severity: 'critical',
      summary: 'x',
    });
    const res = await module.slaReport('ven_1');
    if (res.ok) {
      expect(res.value.availabilitySignals).toBe(0);
      expect(res.value.status).toBe('ok');
    }
  });

  it('excludes availability signals older than the window', async () => {
    const { module, clock } = setupSla(); // 30-day default window
    await module.register({ id: 'ven_1', name: 'Acme', category: 'infra' });
    await availability(module, 'ven_1');
    await availability(module, 'ven_1'); // 2 signals at START

    clock.advance(31 * DAY); // both now older than the 30-day window
    const res = await module.slaReport('ven_1');
    if (res.ok) {
      expect(res.value.availabilitySignals).toBe(0);
      expect(res.value.status).toBe('ok');
    }
  });

  it('counts high/critical availability signals as severe', async () => {
    const { module } = setupSla();
    await module.register({ id: 'ven_1', name: 'Acme', category: 'infra' });
    await availability(module, 'ven_1', 'low');
    await availability(module, 'ven_1', 'high');
    const res = await module.slaReport('ven_1');
    if (res.ok) {
      expect(res.value.availabilitySignals).toBe(2);
      expect(res.value.severeSignals).toBe(1);
    }
  });

  it('honors custom thresholds', async () => {
    const { module } = setupSla({ atRiskAfter: 2, breachAfter: 4 });
    await module.register({ id: 'ven_1', name: 'Acme', category: 'infra' });
    await availability(module, 'ven_1');
    let res = await module.slaReport('ven_1');
    if (res.ok) expect(res.value.status).toBe('ok'); // 1 < atRiskAfter=2
    await availability(module, 'ven_1');
    res = await module.slaReport('ven_1');
    if (res.ok) expect(res.value.status).toBe('at_risk'); // 2
  });

  it('scopes the SLA projection to tenant labels', async () => {
    const { module } = setupSla();
    const acme = { labels: { tenant: 'acme', project: 'alpha' } };
    await module.register({ id: 'ven_1', name: 'Acme', category: 'infra' }, acme);
    // An availability signal recorded under a different tenant must not count.
    await module.recordSignal(
      { vendorId: 'ven_1', kind: 'availability', severity: 'high', summary: 'x' },
      { labels: { tenant: 'other', project: 'alpha' } },
    );
    const scoped = await module.slaReport('ven_1', acme);
    if (scoped.ok) {
      expect(scoped.value.availabilitySignals).toBe(0);
      expect(scoped.value.status).toBe('ok');
    }
  });
});
