import { z } from 'zod';

/**
 * A single intermediate record in the chain from the target event to the
 * anchored head. Each step contains exactly the fields needed to recompute
 * that record's hash and check that it points to the previous step.
 *
 * We carry the full hashed core (not just the hash) because verification
 * recomputes each hash to detect any field tampering — not just chain breaks.
 */
const ChainStepSchema = z
  .object({
    seq: z.number().int().positive(),
    id: z.string().min(1),
    timestamp: z.number().int().nonnegative(),
    prevHash: z.string().regex(/^[0-9a-f]{64}$/),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    event: z.unknown(),
  })
  .strict();

export type ReceiptChainStep = z.infer<typeof ChainStepSchema>;

const HashHex = z.string().regex(/^[0-9a-f]{64}$/);

export const ReceiptSchema = z
  .object({
    /** Receipt format version — bump on breaking changes. */
    version: z.literal(1),

    /** Identifier of the project / tenant this event belongs to (informational). */
    projectId: z.string().min(1).optional(),

    /** When the receipt was generated. ISO 8601. Informational only. */
    issuedAt: z.string().min(1),

    /** The target event record being proved. */
    event: ChainStepSchema,

    /**
     * Records between the event and the anchor, in increasing seq order.
     * The first step's prevHash must equal `event.hash`; the last step's hash
     * must equal `anchor.headHash`. May be empty if the event IS the anchor.
     */
    chain: z.array(ChainStepSchema),

    /**
     * The published anchor this receipt terminates at. The verifier matches
     * this against a trusted reference (Sigstore/Rekor, blockchain tx, etc.).
     */
    anchor: z
      .object({
        anchorId: z.string().min(1),
        anchoredAt: z.number().int().nonnegative(),
        seq: z.number().int().positive(),
        recordId: z.string().min(1),
        headHash: HashHex,
        headTimestamp: z.number().int().nonnegative(),
        signerKeyId: z.string().min(1).optional(),
        signature: z.string().min(1).optional(),
      })
      .strict(),

    /**
     * Optional anchor reference: how/where the anchor was published. Hint to
     * verifiers (e.g. "rekor:abc123", "ethereum:0xdead...", "s3://bucket/key").
     */
    anchorReference: z.string().optional(),
  })
  .strict();

export type Receipt = z.infer<typeof ReceiptSchema>;
