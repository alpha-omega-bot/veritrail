import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
} from 'node:crypto';

/**
 * Optional cryptographic signing of ledger records. Hash-chaining already makes
 * the ledger tamper-*evident* (you cannot alter history without breaking the
 * chain). Signing additionally makes it tamper-*resistant against forgery*: an
 * attacker who can append cannot produce a valid signature without the key.
 *
 * The default deployment is unsigned; HMAC and Ed25519 signers are provided.
 */
export interface Signer {
  readonly algorithm: string;
  /** Stable identifier for the signing key, recorded alongside the signature. */
  readonly keyId: string;
  /** Produce a detached signature (hex) over `data`. */
  sign(data: string): string | Promise<string>;
  /** Verify a detached signature produced by `sign`. */
  verify(data: string, signature: string, keyId?: string): boolean;
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

  verify(data: string, signature: string, keyId?: string): boolean {
    if (keyId !== undefined && keyId !== this.keyId) return false;
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

export type Ed25519KeyInput = KeyObject | string | Buffer;

export interface Ed25519SignerOptions {
  /** Stable identifier recorded alongside signatures produced by this key. */
  readonly keyId?: string;
  /** Public keys accepted during verification, keyed by `signerKeyId`. */
  readonly trustedPublicKeys?:
    | ReadonlyMap<string, Ed25519KeyInput>
    | Record<string, Ed25519KeyInput>;
}

function toPrivateKey(input: Ed25519KeyInput): KeyObject {
  return input instanceof KeyObject ? input : createPrivateKey(input);
}

function toPublicKey(input: Ed25519KeyInput): KeyObject {
  return input instanceof KeyObject ? input : createPublicKey(input);
}

function trustedKeyEntries(
  keys: Ed25519SignerOptions['trustedPublicKeys'],
): Iterable<readonly [string, Ed25519KeyInput]> {
  if (keys === undefined) return [];
  if (keys instanceof Map) return keys.entries();
  return Object.entries(keys);
}

/**
 * Asymmetric Ed25519 signer. Operators can distribute public keys to verifiers
 * without exposing the private signing key, and can keep old public keys in
 * `trustedPublicKeys` so rotated historical records still verify.
 */
export class Ed25519Signer implements Signer {
  readonly algorithm = 'Ed25519';
  readonly keyId: string;
  readonly #privateKey: KeyObject;
  readonly #publicKeys = new Map<string, KeyObject>();

  constructor(privateKey: Ed25519KeyInput, options: Ed25519SignerOptions = {}) {
    this.keyId = options.keyId ?? 'ed25519-default';
    this.#privateKey = toPrivateKey(privateKey);
    this.#publicKeys.set(this.keyId, createPublicKey(this.#privateKey));
    for (const [keyId, publicKey] of trustedKeyEntries(options.trustedPublicKeys)) {
      this.#publicKeys.set(keyId, toPublicKey(publicKey));
    }
  }

  static generate(options: Ed25519SignerOptions = {}): Ed25519Signer {
    const { privateKey } = generateKeyPairSync('ed25519');
    return new Ed25519Signer(privateKey, options);
  }

  publicKey(keyId = this.keyId): KeyObject | null {
    return this.#publicKeys.get(keyId) ?? null;
  }

  sign(data: string): string {
    return cryptoSign(null, Buffer.from(data, 'utf8'), this.#privateKey).toString('hex');
  }

  verify(data: string, signature: string, keyId = this.keyId): boolean {
    if (!/^[0-9a-f]+$/.test(signature)) return false;
    const publicKey = this.#publicKeys.get(keyId);
    if (publicKey === undefined) return false;
    try {
      return cryptoVerify(
        null,
        Buffer.from(data, 'utf8'),
        publicKey,
        Buffer.from(signature, 'hex'),
      );
    } catch {
      return false;
    }
  }
}

export interface RemoteSignerClient {
  /** Produce a detached signature over `data` using a managed remote key. */
  sign(data: Buffer): Promise<Buffer>;
}

export interface RemoteEd25519SignerOptions {
  /** Stable identifier recorded alongside signatures produced by the remote key. */
  readonly keyId: string;
  /** Client wrapping KMS/HSM signing for the configured key. */
  readonly client: RemoteSignerClient;
  /** Public key for verifying signatures produced by the current remote key. */
  readonly publicKey: Ed25519KeyInput;
  /** Previous public keys accepted during verification, keyed by `signerKeyId`. */
  readonly trustedPublicKeys?:
    | ReadonlyMap<string, Ed25519KeyInput>
    | Record<string, Ed25519KeyInput>;
}

/**
 * Ed25519 signer adapter for remote key custody. Signing is delegated to a
 * KMS/HSM client, while verification remains local against configured public
 * keys so ledger verification does not depend on remote service availability.
 */
export class RemoteEd25519Signer implements Signer {
  readonly algorithm = 'Ed25519-Remote';
  readonly keyId: string;
  readonly #client: RemoteSignerClient;
  readonly #publicKeys = new Map<string, KeyObject>();

  constructor(options: RemoteEd25519SignerOptions) {
    this.keyId = options.keyId;
    this.#client = options.client;
    this.#publicKeys.set(this.keyId, toPublicKey(options.publicKey));
    for (const [keyId, publicKey] of trustedKeyEntries(options.trustedPublicKeys)) {
      this.#publicKeys.set(keyId, toPublicKey(publicKey));
    }
  }

  async sign(data: string): Promise<string> {
    const signature = await this.#client.sign(Buffer.from(data, 'utf8'));
    return signature.toString('hex');
  }

  verify(data: string, signature: string, keyId = this.keyId): boolean {
    if (!/^[0-9a-f]+$/.test(signature)) return false;
    const publicKey = this.#publicKeys.get(keyId);
    if (publicKey === undefined) return false;
    try {
      return cryptoVerify(
        null,
        Buffer.from(data, 'utf8'),
        publicKey,
        Buffer.from(signature, 'hex'),
      );
    } catch {
      return false;
    }
  }
}
