import { describe, expect, it } from 'vitest';

import { DefaultIdGenerator, SequentialIdGenerator, FixedClock } from '@veritrail/core';

describe('SequentialIdGenerator', () => {
  it('produces deterministic, ordered ids', () => {
    const ids = new SequentialIdGenerator();
    expect(ids.next('evt')).toBe('evt_000000');
    expect(ids.next('evt')).toBe('evt_000001');
    expect(ids.next()).toBe('id_000002');
  });
});

describe('DefaultIdGenerator', () => {
  it('is unique and time-sortable, even within one millisecond', () => {
    const clock = new FixedClock(1_700_000_000_000);
    const gen = new DefaultIdGenerator(clock);
    const batch = Array.from({ length: 200 }, () => gen.next('evt'));

    // Uniqueness.
    expect(new Set(batch).size).toBe(batch.length);

    // Lexicographic order matches creation order within the same millisecond.
    const sorted = [...batch].sort();
    expect(sorted).toEqual(batch);
  });

  it('orders ids across advancing time', () => {
    const clock = new FixedClock(1000);
    const gen = new DefaultIdGenerator(clock);
    const a = gen.next();
    clock.advance(5);
    const b = gen.next();
    expect(a < b).toBe(true);
  });

  it('keeps ids unique and ordered when the clock moves backward', () => {
    const clock = new FixedClock(1000);
    const gen = new DefaultIdGenerator(clock);
    const first = gen.next('evt');
    clock.advance(-500);
    const second = gen.next('evt');
    clock.advance(-500);
    const third = gen.next('evt');

    expect(new Set([first, second, third]).size).toBe(3);
    expect([first, second, third].sort()).toEqual([first, second, third]);
  });

  it('does not wrap the sortable counter after 65536 ids in one millisecond', () => {
    const clock = new FixedClock(1000);
    const gen = new DefaultIdGenerator(clock);
    const ids = Array.from({ length: 65_538 }, () => gen.next('evt'));

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[65_535]! < ids[65_536]!).toBe(true);
    expect(ids[65_536]! < ids[65_537]!).toBe(true);
  });
});
