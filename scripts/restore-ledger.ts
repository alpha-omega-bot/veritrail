#!/usr/bin/env node

/**
 * Veritrail Ledger Restore Utility
 *
 * Restores encrypted, compressed ledger backups with integrity verification.
 */

import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createDecipheriv, createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';

interface RestoreOptions {
  backupPath: string;
  outputPath: string;
  passphrase?: string;
  verify?: boolean;
  force?: boolean;
}

async function restoreLedger(options: RestoreOptions): Promise<void> {
  const { backupPath, outputPath, passphrase, verify = true, force = false } = options;

  if (!existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`);
  }

  if (!existsSync(backupPath + '.meta')) {
    throw new Error(`Backup metadata not found: ${backupPath}.meta`);
  }

  if (existsSync(outputPath) && !force) {
    throw new Error(`Output file already exists: ${outputPath}. Use --force to overwrite.`);
  }

  console.log('📦 Starting ledger restore...');
  console.log(`   Backup: ${backupPath}`);
  console.log(`   Output: ${outputPath}`);

  // Read metadata
  const metadataRaw = readFileSync(backupPath + '.meta', 'utf-8');
  const metadata = JSON.parse(metadataRaw);

  console.log(`   Backup timestamp: ${metadata.timestamp}`);
  console.log(`   Encrypted: ${metadata.encrypted}`);

  const input = createReadStream(backupPath);
  const gunzip = createGunzip();

  let sourceStream: NodeJS.ReadableStream = input;

  if (metadata.encrypted) {
    if (!passphrase) {
      throw new Error('Passphrase required for encrypted backup');
    }

    // Derive key from passphrase
    const salt = Buffer.from(metadata.salt, 'hex');
    const iv = Buffer.from(metadata.iv, 'hex');
    const key = createHash('sha256')
      .update(passphrase + salt.toString('hex'))
      .digest();

    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    await pipeline(input, decipher, gunzip, createWriteStream(outputPath));
  } else {
    await pipeline(input, gunzip, createWriteStream(outputPath));
  }

  console.log('✓ Restore completed successfully');

  if (verify) {
    console.log('🔍 Verifying restored ledger...');
    await verifyLedger(outputPath);
    console.log('✓ Ledger verified successfully');
  }

  console.log('✅ Restore complete');
}

async function verifyLedger(ledgerPath: string): Promise<void> {
  // Basic verification: check if file exists and is readable
  if (!existsSync(ledgerPath)) {
    throw new Error('Restored ledger file not found');
  }

  // Calculate checksum
  const checksum = await calculateChecksum(ledgerPath);
  console.log(`   SHA-256: ${checksum}`);

  // Verify JSONL format (each line should be valid JSON)
  const content = readFileSync(ledgerPath, 'utf-8');
  const lines = content.trim().split('\n');

  for (let i = 0; i < lines.length; i++) {
    try {
      JSON.parse(lines[i]);
    } catch {
      throw new Error(`Invalid JSON at line ${i + 1}`);
    }
  }

  console.log(`   Format verified: ${lines.length} events`);
}

async function calculateChecksum(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);

    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: restore-ledger <backup-path> <output-path> [--no-verify] [--force]');
    process.exit(1);
  }

  const [backupPath, outputPath, ...flags] = args;

  const options: RestoreOptions = {
    backupPath: resolve(backupPath),
    outputPath: resolve(outputPath),
    verify: !flags.includes('--no-verify'),
    force: flags.includes('--force'),
    passphrase: process.env.VERITRAIL_BACKUP_PASSPHRASE,
  };

  restoreLedger(options)
    .then(() => {
      console.log('');
      console.log('💾 Ledger restored to:', options.outputPath);
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Restore failed:', error.message);
      process.exit(1);
    });
}

export { restoreLedger, type RestoreOptions };
