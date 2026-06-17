/**
 * `@veritrail/core` — the trust core.
 *
 * Public surface: the domain model (Zod schemas + inferred types), the
 * tamper-evident ledger, storage ports and adapters, runtime ports
 * (clock/id/logger/signer), the module contracts, and a small utility layer
 * (Result, errors, hashing, canonicalization).
 */

// Domain model & schemas.
export * from './domain/index.js';

// The ledger: records, integrity verification, and the Ledger service.
export * from './ledger/index.js';

// External checkpoints for detecting wholesale ledger rewrites.
export * from './anchoring/index.js';

// Storage ports and adapters.
export * from './storage/index.js';

// Runtime ports.
export * from './ports/index.js';

// Module contracts shared by the eight governance engines.
export * from './modules/index.js';

// Result / error handling.
export {
  ok,
  err,
  isOk,
  isErr,
  unwrap,
  unwrapOr,
  mapResult,
  mapError,
  type Result,
  type Ok,
  type Err,
} from './util/result.js';
export {
  VeritrailError,
  validationError,
  integrityError,
  conflictError,
  notFoundError,
  storageError,
  type VeritrailErrorCode,
  type VeritrailErrorOptions,
} from './util/errors.js';

// Canonicalization & hashing primitives.
export {
  canonicalize,
  asJson,
  type JsonValue,
  type JsonObject,
  type JsonPrimitive,
} from './util/canonical.js';
export { sha256Hex, hashJson, isHash } from './util/hash.js';
export { invariant, assertNever } from './util/assert.js';

// Convenience factories.
export { createInMemoryLedger, createFileLedger } from './factory.js';
