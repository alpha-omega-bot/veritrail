/**
 * A minimal async mutex. The ledger uses it to serialize appends so that reading
 * the head, computing the next hash, and persisting happen atomically with
 * respect to other appends in the same process — guaranteeing a single, linear,
 * gap-free chain.
 */
export class Mutex {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
}
