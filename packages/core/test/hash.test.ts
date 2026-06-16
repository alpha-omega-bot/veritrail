import { describe, expect, it } from 'vitest';

import { sha256Hex, hashJson, isHash } from '@veritrail/core';

describe('sha256Hex', () => {
  it('matches the known SHA-256 of the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('matches the known SHA-256 of "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('hashJson', () => {
  it('is invariant to object key order', () => {
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }));
  });

  it('differs when content differs', () => {
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: 2 }));
  });
});

describe('isHash', () => {
  it('recognizes 64-char lowercase hex', () => {
    expect(isHash(sha256Hex('x'))).toBe(true);
    expect(isHash('not-a-hash')).toBe(false);
    expect(isHash('ABC')).toBe(false);
  });
});
