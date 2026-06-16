import { describe, expect, it } from 'vitest';

import { canonicalize, asJson } from '@veritrail/core';

describe('canonicalize', () => {
  it('sorts object keys so logically-equal values serialize identically', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it('serializes nested structures deterministically', () => {
    const value = { z: [3, 2, 1], a: { d: true, c: null } };
    expect(canonicalize(value)).toBe('{"a":{"c":null,"d":true},"z":[3,2,1]}');
  });

  it('preserves array order (arrays are ordered, objects are not)', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('skips undefined object values like JSON.stringify', () => {
    // `undefined` is not part of JsonValue, but may appear at runtime.
    const value = { a: 1, b: undefined } as unknown as Record<string, number>;
    expect(canonicalize(value as never)).toBe('{"a":1}');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalize(Number.NaN as never)).toThrow(/non-finite/);
    expect(() => canonicalize(Number.POSITIVE_INFINITY as never)).toThrow(/non-finite/);
  });
});

describe('asJson', () => {
  it('coerces a structurally-JSON value and strips undefined', () => {
    expect(asJson({ a: 1, b: undefined, c: [1, { d: 2 }] })).toEqual({ a: 1, c: [1, { d: 2 }] });
  });

  it('throws on non-JSON values', () => {
    expect(() => asJson(() => 1)).toThrow();
    expect(() => asJson(Number.NaN)).toThrow();
  });
});
