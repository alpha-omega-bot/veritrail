import { describe, expect, it } from 'vitest';

import { globToRegExp, targetMatches } from '../src/matching.js';

describe('globToRegExp ReDoS resistance', () => {
  it('returns quickly for many-wildcard patterns on non-matching input', () => {
    // The pre-fix implementation took ~57s on this input (catastrophic
    // backtracking). With wildcard collapsing it is effectively instant; if it
    // regressed, this test would hit the Vitest timeout and fail.
    const pattern = `${'*'.repeat(30)}X`;
    expect(globToRegExp(pattern).test('a'.repeat(40))).toBe(false);
  });

  it('matches a literal prefix glob normally', () => {
    expect(targetMatches('https://api.example.com/*', 'https://api.example.com/orders')).toBe(true);
    expect(targetMatches('https://api.example.com/*', 'https://evil.com/orders')).toBe(false);
  });

  it('does not let a newline bypass a wildcard', () => {
    // `*` must span newlines, or a deny rule could be bypassed with an embedded \n.
    expect(targetMatches('*', 'a\nb')).toBe(true);
    expect(targetMatches('prefix/*', 'prefix/a\nb')).toBe(true);
  });
});
