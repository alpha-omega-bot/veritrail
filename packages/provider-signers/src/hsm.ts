import type { RemoteSignerClient } from '@veritrail/core';

import { ProviderSignerError, signatureBuffer } from './errors.js';

export type HsmSignMechanism =
  string | number | { readonly name?: string; readonly mechanism?: string | number };

export interface HsmSession {
  sign(
    keyHandle: unknown,
    data: Uint8Array,
    mechanism?: HsmSignMechanism,
  ): Promise<Uint8Array> | Uint8Array;
}

export interface HsmRemoteSignerClientOptions {
  /** Open HSM/PKCS#11 session wrapper. Session lifecycle stays with the caller. */
  readonly session: HsmSession;
  /** Provider-specific private-key handle for the remote Ed25519 key. */
  readonly keyHandle: unknown;
  /** Provider-specific signing mechanism, for example `CKM_EDDSA`. */
  readonly mechanism?: HsmSignMechanism;
}

/** Generic HSM/PKCS#11-shaped implementation of core `RemoteSignerClient`. */
export class HsmRemoteSignerClient implements RemoteSignerClient {
  readonly #session: HsmSession;
  readonly #keyHandle: unknown;
  readonly #mechanism: HsmSignMechanism | undefined;

  constructor(options: HsmRemoteSignerClientOptions) {
    this.#session = options.session;
    this.#keyHandle = options.keyHandle;
    this.#mechanism = options.mechanism;
  }

  async sign(data: Buffer): Promise<Buffer> {
    const result = await this.#session.sign(this.#keyHandle, data, this.#mechanism);
    try {
      return signatureBuffer('hsm', result);
    } catch (cause) {
      if (cause instanceof ProviderSignerError) throw cause;
      throw new ProviderSignerError('hsm', 'sign response did not include a binary signature');
    }
  }
}
