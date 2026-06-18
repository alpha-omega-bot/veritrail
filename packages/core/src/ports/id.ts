import { randomBytes } from 'node:crypto';

import { systemClock, type Clock } from './clock.js';

const MAX_COUNTER = 0xffffffff;

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
 * Time-ordered id: `<prefix>_<48-bit logical-time hex><32-bit counter hex><64-bit random hex>`.
 * Logical time never moves backward for a generator instance, even when the
 * injected clock does. The counter disambiguates ids minted within the same
 * logical millisecond so ordering and uniqueness both hold under bursty creation.
 */
export class DefaultIdGenerator implements IdGenerator {
  readonly #clock: Clock;
  #lastTime = -1;
  #counter = 0;

  constructor(clock: Clock = systemClock) {
    this.#clock = clock;
  }

  next(prefix = 'id'): string {
    const time = Math.max(0, this.#clock.now());
    if (time > this.#lastTime) {
      this.#lastTime = time;
      this.#counter = 0;
    } else if (this.#counter >= MAX_COUNTER) {
      this.#lastTime += 1;
      this.#counter = 0;
    } else {
      this.#counter += 1;
    }
    const timePart = this.#lastTime.toString(16).padStart(12, '0');
    const counterPart = this.#counter.toString(16).padStart(8, '0');
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
