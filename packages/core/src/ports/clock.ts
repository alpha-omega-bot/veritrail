/**
 * Time is an injected dependency so that ledger timestamps are deterministic in
 * tests and auditable in production. Never call `Date.now()` directly in domain
 * code — take a `Clock`.
 */
export interface Clock {
  /** Current time as epoch milliseconds. */
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** A controllable clock for tests and replay. */
export class FixedClock implements Clock {
  #now: number;

  constructor(start = 0) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  set(time: number): void {
    this.#now = time;
  }

  /** Advance the clock and return the new time. */
  advance(ms: number): number {
    this.#now += ms;
    return this.#now;
  }
}
