import { type VeritrailError, type Result, type VeritrailErrorCode } from '@veritrail/core';
import type { FastifyReply } from 'fastify';

/** Stable mapping from error taxonomy to HTTP status. */
const STATUS_BY_CODE: Record<VeritrailErrorCode, number> = {
  VALIDATION: 400,
  POLICY_DENIED: 403,
  BUDGET_EXCEEDED: 402,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTEGRITY: 422,
  STORAGE: 500,
  UNSUPPORTED: 501,
  INTERNAL: 500,
};

export function statusForError(error: VeritrailError): number {
  return STATUS_BY_CODE[error.code] ?? 500;
}

/** Send a VeritrailError with its mapped status. */
export function replyError(reply: FastifyReply, error: VeritrailError): FastifyReply {
  return reply.code(statusForError(error)).send({ error: error.toJSON() });
}

/** Send a Result: the value on success, the mapped error otherwise. */
export function replyResult<T>(
  reply: FastifyReply,
  result: Result<T, VeritrailError>,
): FastifyReply {
  return result.ok ? reply.send(result.value) : replyError(reply, result.error);
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // Treat empty/whitespace params as absent rather than coercing to 0.
    if (trimmed === '') return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
