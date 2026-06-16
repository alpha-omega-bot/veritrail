/**
 * Veritrail quickstart — a governed agent loop end to end.
 *
 * Run from the repo root:  pnpm --filter @veritrail/examples quickstart
 *
 * It shows: deny-by-default permissions, a hard-stop budget, every action
 * recorded on the tamper-evident ledger, an audit summary + integrity check,
 * and a live demonstration that tampering is detected.
 */
import { createAuditModule } from '@veritrail/audit';
import { createInMemoryLedger, money, verifyChain, type LedgerRecord } from '@veritrail/core';
import { Governor } from '@veritrail/sdk';

const line = (s: string): void => process.stdout.write(`${s}\n`);

async function main(): Promise<void> {
  const ledger = createInMemoryLedger();
  const governor = new Governor(ledger); // deny-by-default permissions

  // Allow read-only tools; cap total spend at $5.00.
  governor.permissions.addPolicy({
    name: 'allow read-only tools',
    effect: 'allow',
    match: { actionTypes: ['tool.*'] },
  });
  governor.spendGuard.setBudget({
    name: 'session cap',
    scope: { kind: 'global' },
    limit: money(500), // $5.00 in minor units
  });

  const audit = createAuditModule(governor.ctx);
  const run = 'run-quickstart';

  line('— allowed action —');
  const search = await governor.run(
    { actorId: 'agent-7', type: 'tool.search', target: 'web', cost: money(120) },
    async () => ({ hits: 3 }),
    { correlationId: run },
  );
  line(`  tool.search → ${search.ok ? 'executed' : `blocked (${search.error.code})`}`);

  line('— denied action (no policy allows db.drop) —');
  const drop = await governor.run(
    { actorId: 'agent-7', type: 'db.drop', target: 'users' },
    async () => 'gone',
    {
      correlationId: run,
    },
  );
  line(`  db.drop → ${drop.ok ? 'executed' : `blocked (${drop.error.code})`}`);

  line('— spend until the hard-stop trips —');
  for (let i = 1; i <= 5; i += 1) {
    const call = await governor.run(
      { actorId: 'agent-7', type: 'tool.call', cost: money(120) },
      async () => 'ok',
      { correlationId: run },
    );
    line(`  call #${i} ($1.20) → ${call.ok ? 'charged' : `blocked (${call.error.code})`}`);
  }

  line('— audit summary —');
  const summary = await audit.summary();
  line(`  records: ${summary.totalRecords}, actors: ${summary.actorCount}`);
  line(
    `  by type: ${Object.entries(summary.countsByType)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}`,
  );

  const report = await audit.verify();
  line(`  integrity: ${report.ok ? 'OK' : 'FAILED'} (head ${report.head?.slice(0, 12)}…)`);

  line('— tamper detection —');
  const tampered: LedgerRecord[] = structuredClone(await ledger.readAll());
  const target = tampered[0];
  if (target) {
    (target as { timestamp: number }).timestamp += 1; // mutate a covered field
    const after = verifyChain(tampered);
    line(
      `  mutated seq ${target.seq}: verify ok=${after.ok}, first issue=${after.issues[0]?.kind}`,
    );
  }

  line('\nDone. Everything above is one append-only, hash-chained ledger.');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
