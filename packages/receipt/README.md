# @veritrail/receipt

**Portable, offline-verifiable cryptographic proofs that an AI agent event happened and has not been altered.**

A _receipt_ is a small JSON document that, combined with an independently-published anchor reference, allows any third party — your auditor, your customer, a regulator, a court — to verify on a laptop that:

1. The recorded event has the exact content claimed.
2. The hash chain from that event to a published checkpoint is unbroken.
3. The checkpoint matches the trusted external reference.

The verifier never has to talk to Veritrail. This is the cryptographic primitive that makes Veritrail **admissible as evidence**.

## Use

```ts
import {
  createInMemoryLedger,
  InMemoryAnchorStore,
  publishLedgerHeadAnchor,
} from '@veritrail/core';
import { generateReceipt, verifyReceipt } from '@veritrail/receipt';

// 1. After your ledger is populated, anchor the current head somewhere durable
//    (Sigstore, an L1 blockchain, a notary, an object-store) and remember its hash.
const anchor = (await publishLedgerHeadAnchor({ ledger, store, clock, ids })).value;

// 2. Generate a receipt for any past event you want to prove.
const receipt = await generateReceipt({
  ledger,
  anchor,
  seq: 42,
  projectId: 'my-org/my-project',
  anchorReference: 'rekor:1234567', // optional pointer to where the anchor lives
});

// 3. Hand the receipt JSON to anyone. They verify offline:
const result = verifyReceipt(receipt, {
  trustedAnchorHeadHash: anchor.headHash, // independently fetched
});

if (result.ok) {
  console.log('event proven', result.anchoredHeadHash);
} else {
  for (const failure of result.failures) console.error(failure);
}
```

## CLI

```bash
npm i -g @veritrail/receipt
veritrail-verify receipt.json --trusted-head <64-char-hex>
```

Exit code 0 = verified. Non-zero = failed (with diagnostics on stderr).

## Why this matters

- **Regulators / auditors** can confirm an event without trusting Veritrail or your servers.
- **Legal disputes**: the receipt is admissible cryptographic evidence.
- **Cross-org trust**: prove to a counterparty that you ran policy X without showing them your ledger.

Receipts compose with [`@veritrail/compliance`](../compliance/README.md) to produce auditor-ready reports.
