import { randomBytes } from 'node:crypto';

import { systemClock, type Clock } from './clock.js';

/**
 * Generates unique identifiers. The default implementation produces
 * lexicographically sortable, time-ordered ids (similar in spirit to ULID):
 * sorting ids sorts by creation time, which keeps ledger ids and entity ids
 * naturally ordered. A deterministic generator is provided for tests.
 */
export interface IdGenerator {
  /** Return a new unique id, optionally namespaced with `prefix`. */
  next(prefix?: string): string;
}

/**
 * Time-ordered id: `<prefix>_<48-bit time hex><16-bit counter hex><64-bit random hex>`.
 * The counter disambiguates ids minted within the same millisecond so that
 * ordering and uniqueness both hold under bursty creation.
 */
export class DefaultIdGenerator implements IdGenerator {
  readonly #clock: Clock;
  #lastTime = -1;
  #counter = 0;

  constructor(clock: Clock = systemClock) {
    this.#clock = clock;
  }

  next(prefix = 'id'): string {
    const time = this.#clock.now();
    if (time === this.#lastTime) {
      this.#counter += 1;
    } else {
      this.#lastTime = time;
      this.#counter = 0;
    }
    const timePart = Math.max(0, time).toString(16).padStart(12, '0');
    const counterPart = (this.#counter & 0xffff).toString(16).padStart(4, '0');
    const randomPart = randomBytes(8).toString('hex');
    return `${prefix}_${timePart}${counterPart}${randomPart}`;
  }
}

/** Deterministic, monotonically increasing id generator for tests and fixtures. */
export class SequentialIdGenerator implements IdGenerator {
  #n = 0;
  readonly #pad: number;

  constructor(pad = 6) {
    this.#pad = pad;
  }

  next(prefix = 'id'): string {
    const id = `${prefix}_${String(this.#n).padStart(this.#pad, '0')}`;
    this.#n += 1;
    return id;
  }
}
