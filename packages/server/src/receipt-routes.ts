/**
 * HTTP routes for cryptographic receipts.
 *
 * Receipts are portable, offline-verifiable proofs that a ledger event existed
 * and is unaltered at the time of an external anchor. These endpoints let
 * tenants:
 *
 *   - publish the current ledger head as an anchor (POST /receipt/anchor),
 *   - generate a receipt for any sequenced event up to that anchor
 *     (POST /receipt/generate), and
 *   - verify any receipt offline (POST /receipt/verify).
 *
 * Wiring is additive: the main loop owns server construction and only registers
 * these routes when an AnchorStore is configured.
 */

import {
  notFoundError,
  publishLedgerHeadAnchor,
  validationError,
  type AnchorRecord,
  type AnchorStore,
  type Clock,
  type IdGenerator,
  type LedgerReader,
} from '@veritrail/core';
import { generateReceipt, verifyReceipt } from '@veritrail/receipt';
import type { FastifyInstance } from 'fastify';

import { replyError } from './http.js';

/** Dependencies required by the receipt routes. */
export interface ReceiptRoutesOptions {
  readonly ledger: LedgerReader;
  readonly anchorStore: AnchorStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * Mount POST /api/v1/receipt/{anchor,generate,verify} onto the given Fastify
 * instance. Routes are stateless beyond the supplied ledger and anchor store.
 */
export function registerReceiptRoutes(app: FastifyInstance, opts: ReceiptRoutesOptions): void {
  const { ledger, anchorStore, clock, ids } = opts;

  app.post('/api/v1/receipt/anchor', async (_request, reply) => {
    const result = await publishLedgerHeadAnchor({ ledger, store: anchorStore, clock, ids });
    if (!result.ok) return replyError(reply, result.error);
    return reply.code(201).send(result.value);
  });

  app.post('/api/v1/receipt/generate', async (request, reply) => {
    const body = request.body as
      | { seq?: unknown; anchorId?: unknown; projectId?: unknown }
      | undefined;

    const seq = typeof body?.seq === 'number' ? body.seq : undefined;
    if (seq === undefined || !Number.isInteger(seq) || seq < 1) {
      return replyError(reply, validationError('seq must be a positive integer'));
    }
    const anchorId = typeof body?.anchorId === 'string' ? body.anchorId : undefined;
    const projectId = typeof body?.projectId === 'string' ? body.projectId : undefined;

    let anchor: AnchorRecord | null = null;
    if (anchorId !== undefined) {
      const all = await anchorStore.list();
      anchor = all.find((entry) => entry.anchorId === anchorId) ?? null;
      if (!anchor) {
        return replyError(reply, notFoundError(`no anchor with id ${anchorId}`));
      }
    } else {
      anchor = await anchorStore.latest();
      if (!anchor) {
        return replyError(reply, notFoundError('no anchor has been published'));
      }
    }

    try {
      const receipt = await generateReceipt({
        ledger,
        anchor,
        seq,
        ...(projectId !== undefined ? { projectId } : {}),
      });
      return reply.send(receipt);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'failed to generate receipt';
      if (cause instanceof RangeError || /no record at seq/i.test(message)) {
        return replyError(reply, validationError(message));
      }
      throw cause;
    }
  });

  app.post('/api/v1/receipt/verify', async (request, reply) => {
    const body = request.body as { receipt?: unknown; trustedAnchorHeadHash?: unknown } | undefined;
    if (body?.receipt === undefined) {
      return replyError(reply, validationError('receipt is required'));
    }
    const trusted =
      typeof body.trustedAnchorHeadHash === 'string' ? body.trustedAnchorHeadHash : undefined;

    const result = verifyReceipt(
      body.receipt,
      trusted !== undefined ? { trustedAnchorHeadHash: trusted } : {},
    );
    return reply.send({
      ok: result.ok,
      failures: result.failures,
      ...(result.anchoredHeadHash !== undefined
        ? { anchoredHeadHash: result.anchoredHeadHash }
        : {}),
    });
  });
}
