import { describe, expect, it } from 'vitest';

import { Ed25519Signer, RemoteEd25519Signer } from '@veritrail/core';
import {
  AwsKmsRemoteSignerClient,
  AzureKeyVaultRemoteSignerClient,
  GcpKmsRemoteSignerClient,
  HsmRemoteSignerClient,
  ProviderSignerError,
  type AwsKmsSignCommandInput,
} from '@veritrail/provider-signers';

describe('AwsKmsRemoteSignerClient', () => {
  it('sends an Ed25519 RAW sign command and returns the signature bytes', async () => {
    const remoteKey = Ed25519Signer.generate({ keyId: 'aws-kms-key' });
    let capturedInput: AwsKmsSignCommandInput | null = null;
    class FakeSignCommand {
      constructor(readonly input: AwsKmsSignCommandInput) {
        capturedInput = input;
      }
    }
    const client = new AwsKmsRemoteSignerClient({
      keyId: 'arn:aws:kms:us-east-1:111122223333:key/example',
      SignCommand: FakeSignCommand,
      client: {
        async send(command) {
          const data = Buffer.from((command as FakeSignCommand).input.Message);
          return { Signature: Buffer.from(remoteKey.sign(data.toString('utf8')), 'hex') };
        },
      },
    });
    const signer = new RemoteEd25519Signer({
      keyId: 'aws-kms-key',
      client,
      publicKey: remoteKey.publicKey()!,
    });

    const signature = await signer.sign('record-hash');

    expect(capturedInput).toEqual({
      KeyId: 'arn:aws:kms:us-east-1:111122223333:key/example',
      Message: Buffer.from('record-hash', 'utf8'),
      MessageType: 'RAW',
      SigningAlgorithm: 'ED25519_SHA_512',
    });
    expect(signer.verify('record-hash', signature, 'aws-kms-key')).toBe(true);
  });

  it('rejects missing AWS signatures', async () => {
    const client = new AwsKmsRemoteSignerClient({
      keyId: 'key',
      SignCommand: class FakeSignCommand {
        constructor(_input: AwsKmsSignCommandInput) {}
      },
      client: {
        async send() {
          return {};
        },
      },
    });

    await expect(client.sign(Buffer.from('x'))).rejects.toMatchObject({
      name: 'ProviderSignerError',
      provider: 'aws-kms',
    });
  });
});

describe('GcpKmsRemoteSignerClient', () => {
  it('calls asymmetricSign with the configured key version', async () => {
    const signature = Buffer.from('signature');
    const client = new GcpKmsRemoteSignerClient({
      keyVersionName: 'projects/p/locations/global/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1',
      client: {
        async asymmetricSign(request) {
          expect(request).toEqual({
            name: 'projects/p/locations/global/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1',
            data: Buffer.from('record-hash'),
          });
          return [{ signature }];
        },
      },
    });

    await expect(client.sign(Buffer.from('record-hash'))).resolves.toEqual(signature);
  });

  it('decodes base64 GCP signatures and rejects missing signatures', async () => {
    const base64Client = new GcpKmsRemoteSignerClient({
      keyVersionName: 'key-version',
      client: {
        async asymmetricSign() {
          return { signature: Buffer.from('signature').toString('base64') };
        },
      },
    });
    await expect(base64Client.sign(Buffer.from('x'))).resolves.toEqual(Buffer.from('signature'));

    const missingClient = new GcpKmsRemoteSignerClient({
      keyVersionName: 'key-version',
      client: {
        async asymmetricSign() {
          return {};
        },
      },
    });
    await expect(missingClient.sign(Buffer.from('x'))).rejects.toBeInstanceOf(ProviderSignerError);
  });
});

describe('AzureKeyVaultRemoteSignerClient', () => {
  it('calls signData with EdDSA by default', async () => {
    const signature = Buffer.from('signature');
    let algorithm = '';
    const client = new AzureKeyVaultRemoteSignerClient({
      client: {
        async signData(alg, data) {
          algorithm = alg;
          expect(data).toEqual(Buffer.from('record-hash'));
          return { result: signature };
        },
      },
    });

    await expect(client.sign(Buffer.from('record-hash'))).resolves.toEqual(signature);
    expect(algorithm).toBe('EdDSA');
  });

  it('supports overriding the Azure algorithm and rejects missing results', async () => {
    const client = new AzureKeyVaultRemoteSignerClient({
      algorithm: 'CustomEdDsa',
      client: {
        async signData(algorithm) {
          expect(algorithm).toBe('CustomEdDsa');
          return {};
        },
      },
    });

    await expect(client.sign(Buffer.from('x'))).rejects.toMatchObject({
      provider: 'azure-key-vault',
    });
  });
});

describe('HsmRemoteSignerClient', () => {
  it('delegates signing to the provided session and mechanism', async () => {
    const signature = Buffer.from('signature');
    const keyHandle = { handle: 1 };
    const mechanism = { name: 'CKM_EDDSA' };
    const client = new HsmRemoteSignerClient({
      keyHandle,
      mechanism,
      session: {
        sign(handle, data, mech) {
          expect(handle).toBe(keyHandle);
          expect(data).toEqual(Buffer.from('record-hash'));
          expect(mech).toBe(mechanism);
          return signature;
        },
      },
    });

    await expect(client.sign(Buffer.from('record-hash'))).resolves.toEqual(signature);
  });

  it('rejects non-binary HSM signatures', async () => {
    const client = new HsmRemoteSignerClient({
      keyHandle: 'key',
      session: {
        sign() {
          return 'not-binary' as unknown as Uint8Array;
        },
      },
    });

    await expect(client.sign(Buffer.from('x'))).rejects.toMatchObject({
      provider: 'hsm',
    });
  });
});
