import { describe, expect, it } from 'vitest';

import { ok, err, isOk, isErr, unwrap, unwrapOr, mapResult, mapError } from '@veritrail/core';

describe('Result', () => {
  it('constructs and narrows ok/err', () => {
    const good = ok(42);
    const bad = err(new Error('nope'));
    expect(isOk(good)).toBe(true);
    expect(isErr(bad)).toBe(true);
    if (isOk(good)) expect(good.value).toBe(42);
    if (isErr(bad)) expect(bad.error.message).toBe('nope');
  });

  it('unwrap returns value or throws', () => {
    expect(unwrap(ok('v'))).toBe('v');
    expect(() => unwrap(err(new Error('boom')))).toThrow('boom');
  });

  it('unwrapOr falls back on error', () => {
    expect(unwrapOr(ok(1), 9)).toBe(1);
    expect(unwrapOr(err('e'), 9)).toBe(9);
  });

  it('mapResult transforms only success', () => {
    expect(mapResult(ok(2), (n) => n * 3)).toEqual(ok(6));
    const e = err('bad');
    expect(mapResult(e, (n: number) => n * 3)).toBe(e);
  });

  it('mapError transforms only error', () => {
    expect(mapError(err('x'), (s) => `${s}!`)).toEqual(err('x!'));
    const good = ok(1);
    expect(mapError(good, (s: string) => s)).toBe(good);
  });
});
