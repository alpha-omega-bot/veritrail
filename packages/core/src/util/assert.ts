import { VeritrailError } from './errors.js';

/**
 * Assert an invariant that must hold by construction. A failure here indicates a
 * programming error (not bad external input), so it throws rather than returning
 * a `Result`. Use `validationError`/`Result` for untrusted input instead.
 */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new VeritrailError('INTERNAL', `Invariant violated: ${message}`);
  }
}

/** Exhaustiveness helper: the compiler errors if a union case is unhandled. */
export function assertNever(value: never, message = 'Unexpected value'): never {
  throw new VeritrailError('INTERNAL', `${message}: ${String(value)}`);
}
