# @veritrail/provider-signers

Provider `RemoteSignerClient` adapters for Veritrail managed-key signing.

This package keeps cloud/HSM SDKs out of `@veritrail/core`. Bring the SDK for
your provider, construct the matching adapter, then pass it to
`RemoteEd25519Signer` from `@veritrail/core`.

## AWS KMS

```ts
import { KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { RemoteEd25519Signer } from '@veritrail/core';
import { AwsKmsRemoteSignerClient } from '@veritrail/provider-signers';

const client = new AwsKmsRemoteSignerClient({
  keyId: process.env.AWS_KMS_KEY_ID!,
  client: new KMSClient({}),
  SignCommand,
});

const signer = new RemoteEd25519Signer({
  keyId: 'aws-kms-prod-2026-06',
  client,
  publicKey: publicKeyPem,
});
```

The adapter calls AWS KMS `SignCommand` with `MessageType: 'RAW'` and
`SigningAlgorithm: 'ED25519_SHA_512'`.

## GCP Cloud KMS

```ts
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { GcpKmsRemoteSignerClient } from '@veritrail/provider-signers';

const client = new GcpKmsRemoteSignerClient({
  keyVersionName: 'projects/p/locations/global/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1',
  client: new KeyManagementServiceClient(),
});
```

The adapter calls `asymmetricSign({ name, data })` and accepts binary or base64
signature responses.

## Azure Key Vault

```ts
import { CryptographyClient } from '@azure/keyvault-keys';
import { AzureKeyVaultRemoteSignerClient } from '@veritrail/provider-signers';

const client = new AzureKeyVaultRemoteSignerClient({
  client: new CryptographyClient(keyId, credential),
  algorithm: 'EdDSA',
});
```

## Generic HSM / PKCS#11

```ts
import { HsmRemoteSignerClient } from '@veritrail/provider-signers';

const client = new HsmRemoteSignerClient({
  session,
  keyHandle,
  mechanism: { name: 'CKM_EDDSA' },
});
```

The HSM adapter expects the caller to manage session lifecycle and pass an open
session wrapper with `sign(keyHandle, data, mechanism)`.

## Failure Behavior

All adapters throw `ProviderSignerError` when a provider response lacks a binary
signature. `Ledger.append()` catches failures from `RemoteEd25519Signer.sign()`
and returns a `STORAGE` result before persisting the record.
