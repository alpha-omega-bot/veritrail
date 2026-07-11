import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  aggregateSignals,
  contributePattern,
  queryBucket,
  RECOMMENDED_K_ANON,
} from '../src/index.js';
import type { RiskSignal } from '../src/index.js';

const SALT = 'network-shared-salt-v1';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function makeSignal(overrides: Partial<RiskSignal> = {}): RiskSignal {
  return {
    patternHash: 'pattern-a',
    category: 'prompt-injection',
    observedAt: 1_700_000_000_000,
    contributorIdHash: 'contrib-1',
    ...overrides,
  };
}

function signalsForContributors(
  patternHash: string,
  category: RiskSignal['category'],
  contributorIds: ReadonlyArray<string>,
  observedAt = 1_700_000_000_000,
): RiskSignal[] {
  return contributorIds.map((c, i) => ({
    patternHash,
    category,
    observedAt: observedAt + i,
    contributorIdHash: c,
  }));
}

describe('contributePattern', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('produces stable patternHash and contributorIdHash for the same input', () => {
    const a = contributePattern({
      rawPattern: 'ignore previous instructions and...',
      category: 'prompt-injection',
      orgId: 'org_abc',
      salt: SALT,
    });
    const b = contributePattern({
      rawPattern: 'ignore previous instructions and...',
      category: 'prompt-injection',
      orgId: 'org_abc',
      salt: SALT,
    });
    expect(a.patternHash).toBe(b.patternHash);
    expect(a.contributorIdHash).toBe(b.contributorIdHash);
    expect(a.patternHash).toBe(sha256Hex('ignore previous instructions and...'));
  });

  it('different orgIds yield different contributorIdHash for the same pattern', () => {
    const a = contributePattern({
      rawPattern: 'jailbreak attempt',
      category: 'prompt-injection',
      orgId: 'org_one',
      salt: SALT,
    });
    const b = contributePattern({
      rawPattern: 'jailbreak attempt',
      category: 'prompt-injection',
      orgId: 'org_two',
      salt: SALT,
    });
    expect(a.patternHash).toBe(b.patternHash);
    expect(a.contributorIdHash).not.toBe(b.contributorIdHash);
  });

  it('uses the provided salt in contributorIdHash so different salts diverge', () => {
    const a = contributePattern({
      rawPattern: 'p',
      category: 'other',
      orgId: 'org_x',
      salt: 'salt-1',
    });
    const b = contributePattern({
      rawPattern: 'p',
      category: 'other',
      orgId: 'org_x',
      salt: 'salt-2',
    });
    expect(a.contributorIdHash).not.toBe(b.contributorIdHash);
  });
});

describe('aggregateSignals', () => {
  it('counts distinct contributors, not raw observations', () => {
    const signals = [
      ...signalsForContributors('p1', 'prompt-injection', ['c1', 'c2', 'c3', 'c4', 'c5']),
      makeSignal({ patternHash: 'p1', contributorIdHash: 'c1' }),
      makeSignal({ patternHash: 'p1', contributorIdHash: 'c1' }),
    ];
    const buckets = aggregateSignals(signals);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.contributorCount).toBe(5);
    expect(buckets[0]?.observationCount).toBe(7);
  });

  it('applies k-anonymity: drops buckets with fewer than k distinct contributors', () => {
    const belowK = signalsForContributors('p_low', 'unsafe-tool', ['c1', 'c2', 'c3', 'c4']);
    const atK = signalsForContributors('p_ok', 'prompt-injection', ['c1', 'c2', 'c3', 'c4', 'c5']);
    const buckets = aggregateSignals([...belowK, ...atK]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.patternHash).toBe('p_ok');
  });

  it('drops sub-threshold buckets entirely (not just masked counts)', () => {
    const signals = signalsForContributors('p_secret', 'vendor-risk', ['c1', 'c2']);
    const buckets = aggregateSignals(signals);
    expect(buckets).toHaveLength(0);
    expect(buckets.find((b) => b.patternHash === 'p_secret')).toBeUndefined();
    expect(queryBucket(buckets, 'p_secret')).toBeNull();
  });

  it('sorts buckets by lastObservedMs descending', () => {
    const older = signalsForContributors(
      'p_old',
      'prompt-injection',
      ['c1', 'c2', 'c3', 'c4', 'c5'],
      1_000,
    );
    const newer = signalsForContributors(
      'p_new',
      'prompt-injection',
      ['d1', 'd2', 'd3', 'd4', 'd5'],
      9_000,
    );
    const buckets = aggregateSignals([...older, ...newer]);
    expect(buckets.map((b) => b.patternHash)).toEqual(['p_new', 'p_old']);
    expect(buckets[0]?.lastObservedMs).toBeGreaterThan(buckets[1]?.lastObservedMs ?? 0);
  });

  it('observationCount equals total signal count regardless of contributor distinctness', () => {
    const signals = [
      ...signalsForContributors('p1', 'prompt-injection', ['c1', 'c2', 'c3', 'c4', 'c5']),
      makeSignal({ patternHash: 'p1', contributorIdHash: 'c1' }),
      makeSignal({ patternHash: 'p1', contributorIdHash: 'c1' }),
      makeSignal({ patternHash: 'p1', contributorIdHash: 'c2' }),
    ];
    const buckets = aggregateSignals(signals);
    expect(buckets[0]?.observationCount).toBe(signals.length);
    expect(buckets[0]?.observationCount).toBe(8);
    expect(buckets[0]?.contributorCount).toBe(5);
  });

  it('groups by (patternHash, category): same hash different category becomes two buckets', () => {
    const promptInjectionSignals = signalsForContributors('shared_hash', 'prompt-injection', [
      'c1',
      'c2',
      'c3',
      'c4',
      'c5',
    ]);
    const unsafeToolSignals = signalsForContributors('shared_hash', 'unsafe-tool', [
      'd1',
      'd2',
      'd3',
      'd4',
      'd5',
    ]);
    const buckets = aggregateSignals([...promptInjectionSignals, ...unsafeToolSignals]);
    expect(buckets).toHaveLength(2);
    const categories = buckets.map((b) => b.category).sort();
    expect(categories).toEqual(['prompt-injection', 'unsafe-tool']);
  });

  it('tracks firstObservedMs and lastObservedMs across the contributing signals', () => {
    const signals: RiskSignal[] = [
      makeSignal({ contributorIdHash: 'c1', observedAt: 5_000 }),
      makeSignal({ contributorIdHash: 'c2', observedAt: 1_000 }),
      makeSignal({ contributorIdHash: 'c3', observedAt: 9_000 }),
      makeSignal({ contributorIdHash: 'c4', observedAt: 3_000 }),
      makeSignal({ contributorIdHash: 'c5', observedAt: 7_000 }),
    ];
    const buckets = aggregateSignals(signals);
    expect(buckets[0]?.firstObservedMs).toBe(1_000);
    expect(buckets[0]?.lastObservedMs).toBe(9_000);
  });

  it('returns an empty array for empty input', () => {
    expect(aggregateSignals([])).toEqual([]);
  });
});

describe('queryBucket', () => {
  it('returns null when the patternHash is not present', () => {
    const buckets = aggregateSignals(
      signalsForContributors('p1', 'prompt-injection', ['c1', 'c2', 'c3', 'c4', 'c5']),
    );
    expect(queryBucket(buckets, 'missing')).toBeNull();
  });

  it('returns the matching bucket when present', () => {
    const buckets = aggregateSignals(
      signalsForContributors('p1', 'prompt-injection', ['c1', 'c2', 'c3', 'c4', 'c5']),
    );
    const found = queryBucket(buckets, 'p1');
    expect(found?.patternHash).toBe('p1');
    expect(found?.contributorCount).toBe(5);
  });
});

describe('RECOMMENDED_K_ANON', () => {
  it('is the k=5 threshold documented for the network', () => {
    expect(RECOMMENDED_K_ANON).toBe(5);
  });
});
