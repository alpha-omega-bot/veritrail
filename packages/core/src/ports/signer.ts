import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Optional cryptographic signing of ledger records. Hash-chaining already makes
 * the ledger tamper-*evident* (you cannot alter history without breaking the
 * chain). Signing additionally makes it tamper-*resistant against forgery*: an
 * attacker who can append cannot produce a valid signature without the key.
 *
 * The default deployment is unsigned; an HMAC signer is provided here, and an
 * asymmetric (Ed25519) signer with external anchoring is on the roadmap.
 */
export interface Signer {
  readonly algorithm: string;
  /** Stable identifier for the signing key, recorded alongside the signature. */
  readonly keyId: string;
  /** Produce a detached signature (hex) over `data`. */
  sign(data: string): string;
  /** Verify a detached signature produced by `sign`. */
  verify(data: string, signature: string): boolean;
}

/** Symmetric HMAC-SHA256 signer. Suitable when verifiers are trusted holders of the key. */
export class HmacSigner implements Signer {
  readonly algorithm = 'HMAC-SHA256';
  readonly keyId: string;
  readonly #secret: string;

  constructor(secret: string, keyId = 'hmac-default') {
    if (secret.length < 16) {
      throw new Error('HmacSigner: secret must be at least 16 characters');
    }
    this.#secret = secret;
    this.keyId = keyId;
  }

  sign(data: string): string {
    return createHmac('sha256', this.#secret).update(data, 'utf8').digest('hex');
  }

  verify(data: string, signature: string): boolean {
    const expected = this.sign(data);
    // Reject malformed signatures BEFORE decoding: a same-length but non-hex
    // string decodes to a different byte length and would otherwise make
    // timingSafeEqual throw, turning a forged signature into a crash (DoS).
    if (!/^[0-9a-f]+$/.test(signature) || expected.length !== signature.length) return false;
    try {
      const a = Buffer.from(expected, 'hex');
      const b = Buffer.from(signature, 'hex');
      if (a.length !== b.length) return false;
      // Constant-time comparison to avoid leaking via timing.
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
}
