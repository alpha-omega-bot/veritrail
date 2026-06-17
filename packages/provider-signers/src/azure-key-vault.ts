import type { RemoteSignerClient } from '@veritrail/core';

import { ProviderSignerError, signatureBuffer } from './errors.js';

export interface AzureSignResult {
  readonly result?: Uint8Array;
}

export interface AzureKeyVaultCryptographyClient {
  signData(algorithm: string, data: Uint8Array): Promise<AzureSignResult>;
}

export interface AzureKeyVaultRemoteSignerClientOptions {
  /** `@azure/keyvault-keys` CryptographyClient-compatible object. */
  readonly client: AzureKeyVaultCryptographyClient;
  /** Azure Key Vault signature algorithm. Defaults to `EdDSA`. */
  readonly algorithm?: string;
}

/** Azure Key Vault implementation of core `RemoteSignerClient` for Ed25519 keys. */
export class AzureKeyVaultRemoteSignerClient implements RemoteSignerClient {
  readonly #client: AzureKeyVaultCryptographyClient;
  readonly #algorithm: string;

  constructor(options: AzureKeyVaultRemoteSignerClientOptions) {
    this.#client = options.client;
    this.#algorithm = options.algorithm ?? 'EdDSA';
  }

  async sign(data: Buffer): Promise<Buffer> {
    const response = await this.#client.signData(this.#algorithm, data);
    if (response.result === undefined) {
      throw new ProviderSignerError('azure-key-vault', 'sign response did not include result');
    }
    return signatureBuffer('azure-key-vault', response.result);
  }
}
