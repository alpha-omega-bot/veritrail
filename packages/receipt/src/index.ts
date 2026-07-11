/**
 * @veritrail/receipt
 *
 * Portable, offline-verifiable proofs of ledger events.
 *
 * A receipt is a small JSON document that contains:
 *
 *   - The target event record (seq, hash, payload).
 *   - A chain of intermediate record hashes from the target up to an
 *     externally-published anchor (a checkpoint that was published to a
 *     transparency log, blockchain, notary, or object store at a known time).
 *   - The anchor itself (seq, hash, optional signature + signer key id).
 *
 * Given a receipt and the anchor's trusted reference (independently fetched
 * from where it was published), anyone can verify offline that:
 *
 *   1. The event's hash recomputes from its declared content.
 *   2. The hash chain leads unbroken from the event to the anchored head.
 *   3. The anchor in the receipt matches the trusted reference.
 *
 * This is the cryptographic primitive that makes "regulator-admissible
 * evidence of agent governance" practical. The verifier never has to talk to
 * Veritrail's servers.
 */

export { ReceiptSchema, type Receipt, type ReceiptChainStep } from './schema.js';
export { generateReceipt } from './generate.js';
export {
  verifyReceipt,
  type VerifyOptions,
  type VerifyResult,
  type VerifyFailure,
} from './verify.js';
