import type { JsonValue } from './canonical.js';

/**
 * A closed taxonomy of failure categories. Keeping these as a small, explicit
 * union (rather than ad-hoc error classes) lets callers branch on `code`
 * exhaustively and lets transports map them to stable HTTP statuses.
 */
export type VeritrailErrorCode =
  | 'VALIDATION' // input failed schema validation
  | 'INTEGRITY' // the ledger chain is broken or a hash/signature does not verify
  | 'CONFLICT' // an append violated append-only/sequencing invariants
  | 'NOT_FOUND' // a referenced entity does not exist
  | 'POLICY_DENIED' // an action was denied by the permissions engine
  | 'BUDGET_EXCEEDED' // an action would exceed a spend limit
  | 'STORAGE' // the underlying store failed
  | 'UNSUPPORTED' // the operation is not supported by this adapter
  | 'INTERNAL'; // an unexpected invariant violation

export interface VeritrailErrorOptions {
  readonly details?: JsonValue;
  readonly cause?: unknown;
}

export class VeritrailError extends Error {
  readonly code: VeritrailErrorCode;
  readonly details: JsonValue | undefined;

  constructor(code: VeritrailErrorCode, message: string, options: VeritrailErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'VeritrailError';
    this.code = code;
    this.details = options.details;
  }

  toJSON(): JsonValue {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export const validationError = (message: string, details?: JsonValue): VeritrailError =>
  new VeritrailError('VALIDATION', message, details === undefined ? {} : { details });

export const integrityError = (message: string, details?: JsonValue): VeritrailError =>
  new VeritrailError('INTEGRITY', message, details === undefined ? {} : { details });

export const conflictError = (message: string, details?: JsonValue): VeritrailError =>
  new VeritrailError('CONFLICT', message, details === undefined ? {} : { details });

export const notFoundError = (message: string, details?: JsonValue): VeritrailError =>
  new VeritrailError('NOT_FOUND', message, details === undefined ? {} : { details });

export const storageError = (message: string, cause?: unknown): VeritrailError =>
  new VeritrailError('STORAGE', message, cause === undefined ? {} : { cause });
