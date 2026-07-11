#!/usr/bin/env node
/**
 * `veritrail-verify <receipt.json> [--trusted-head <hex>]`
 *
 * Standalone CLI for offline receipt verification. Auditors and regulators
 * can run this without ever contacting Veritrail's servers.
 */

import { readFileSync } from 'node:fs';

import { verifyReceipt, type VerifyOptions } from './verify.js';

function parseArgs(argv: string[]): { file: string | undefined; trustedHead: string | undefined } {
  let file: string | undefined;
  let trustedHead: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--trusted-head' && i + 1 < argv.length) {
      trustedHead = argv[i + 1];
      i += 1;
    } else if (!arg.startsWith('-') && file === undefined) {
      file = arg;
    }
  }
  return { file, trustedHead };
}

function main(): number {
  const argv = process.argv.slice(2);
  const { file, trustedHead } = parseArgs(argv);
  if (!file) {
    process.stderr.write('usage: veritrail-verify <receipt.json> [--trusted-head <64-char-hex>]\n');
    return 64; // EX_USAGE
  }

  let receiptRaw: unknown;
  try {
    receiptRaw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    process.stderr.write(`failed to read ${file}: ${message}\n`);
    return 66; // EX_NOINPUT
  }

  const options: VerifyOptions =
    trustedHead !== undefined ? { trustedAnchorHeadHash: trustedHead } : {};
  const result = verifyReceipt(receiptRaw, options);

  if (result.ok) {
    process.stdout.write(`✓ verified — anchored head: ${result.anchoredHeadHash ?? '<none>'}\n`);
    return 0;
  }

  process.stderr.write(`✗ verification failed:\n`);
  for (const failure of result.failures) {
    const seqPart = failure.seq !== undefined ? ` (seq ${failure.seq})` : '';
    process.stderr.write(`  - [${failure.kind}]${seqPart} ${failure.detail}\n`);
  }
  return 1;
}

process.exit(main());
