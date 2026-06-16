import { parseArgs } from 'node:util';

import {
  DefaultIdGenerator,
  createFileLedger,
  noopLogger,
  systemClock,
  type EventQuery,
  type EventType,
  type Ledger,
  type ModuleContext,
} from '@veritrail/core';
import { createAuditModule } from '@veritrail/audit';
import { createForensicsModule } from '@veritrail/forensics';
import { createVendorRiskModule } from '@veritrail/vendor-risk';

export interface CliIO {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIO: CliIO = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

const USAGE = `veritrail — the trust & control plane for AI agents

Usage: veritrail <command> [options]

Commands:
  verify                 Verify the ledger's tamper-evident integrity
  summary                Show an audit summary (counts, actors, head, integrity)
  events                 List ledger events (--type --actor --correlation --limit)
  export                 Print the ledger as NDJSON
  append <json>          Append a single event (JSON object) to the ledger
  incident <id>          Reconstruct an incident for a correlation id
  vendor-risk            Show the vendor risk assessment

Global options:
  --file <path>          Ledger file (default: $VERITRAIL_LEDGER_FILE or ./veritrail.ledger.jsonl)
  --json                 Emit machine-readable JSON
  -h, --help             Show this help
`;

function ledgerPath(file: string | undefined): string {
  return file ?? process.env['VERITRAIL_LEDGER_FILE'] ?? 'veritrail.ledger.jsonl';
}

function contextFor(ledger: Ledger): ModuleContext {
  const clock = systemClock;
  return { ledger, clock, ids: new DefaultIdGenerator(clock), logger: noopLogger };
}

/** Run the CLI. Returns a process exit code. */
export async function run(argv: string[], io: CliIO = defaultIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        file: { type: 'string' },
        type: { type: 'string' },
        actor: { type: 'string' },
        correlation: { type: 'string' },
        limit: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const { values, positionals } = parsed;
  const command = positionals[0];

  if (values.help || command === undefined || command === 'help') {
    io.out(USAGE);
    return 0;
  }

  const json = values.json === true;
  const emit = (data: unknown, human: () => string): void => {
    io.out(json ? JSON.stringify(data, null, 2) : human());
  };

  try {
    const path = ledgerPath(values.file);

    switch (command) {
      case 'verify': {
        const ledger = await createFileLedger(path);
        const report = await ledger.verify();
        emit(report, () =>
          report.ok
            ? `OK  ledger intact — ${report.checked} record(s), head ${short(report.head)}`
            : `FAIL  ${report.issues.length} integrity issue(s):\n` +
              report.issues.map((i) => `  - seq ${i.seq} ${i.kind}: ${i.detail}`).join('\n'),
        );
        return report.ok ? 0 : 1;
      }

      case 'summary': {
        const audit = createAuditModule(contextFor(await createFileLedger(path)));
        const summary = await audit.summary();
        emit(summary, () =>
          [
            `records:    ${summary.totalRecords}`,
            `actors:     ${summary.actorCount}`,
            `integrity:  ${summary.integrityOk ? 'ok' : 'FAILED'}`,
            `head:       ${short(summary.head)}`,
            `by type:    ${Object.entries(summary.countsByType)
              .map(([k, v]) => `${k}=${v}`)
              .join(', ')}`,
          ].join('\n'),
        );
        return 0;
      }

      case 'events': {
        const audit = createAuditModule(contextFor(await createFileLedger(path)));
        const records = await audit.search(buildQuery(values));
        emit(records, () =>
          records.length === 0
            ? '(no events)'
            : records
                .map((r) => `#${r.seq}  ${pad(r.event.type, 20)}  ${r.event.actorId}  ${r.id}`)
                .join('\n'),
        );
        return 0;
      }

      case 'export': {
        const audit = createAuditModule(contextFor(await createFileLedger(path)));
        io.out(await audit.exportNdjson());
        return 0;
      }

      case 'append': {
        const raw = positionals[1];
        if (raw === undefined) {
          io.err('append requires a JSON event argument');
          return 2;
        }
        let event: unknown;
        try {
          event = JSON.parse(raw);
        } catch {
          io.err('append: argument is not valid JSON');
          return 2;
        }
        const ledger = await createFileLedger(path);
        const result = await ledger.append(event);
        if (!result.ok) {
          io.err(`append failed (${result.error.code}): ${result.error.message}`);
          return 1;
        }
        emit(result.value, () => `appended #${result.value.seq} ${result.value.event.type}`);
        return 0;
      }

      case 'incident': {
        const correlationId = positionals[1] ?? values.correlation;
        if (correlationId === undefined) {
          io.err('incident requires a correlation id');
          return 2;
        }
        const forensics = createForensicsModule(contextFor(await createFileLedger(path)));
        const report = await forensics.incident(correlationId);
        emit(report, () =>
          [
            `incident ${report.correlationId}: ${report.entries.length} event(s)`,
            `actors: ${report.actors.join(', ') || '(none)'}`,
            `failures: ${report.failures}  denials: ${report.denials}  rollbacks: ${report.rollbacks}`,
            ...report.entries.map((e) => `  #${e.seq} ${e.summary}`),
          ].join('\n'),
        );
        return 0;
      }

      case 'vendor-risk': {
        const vendorRisk = createVendorRiskModule(contextFor(await createFileLedger(path)));
        const scores = await vendorRisk.assess();
        emit(scores, () =>
          scores.length === 0
            ? '(no vendors)'
            : scores
                .map((s) => `${pad(s.band.toUpperCase(), 9)} ${pad(String(s.score), 6)} ${s.name}`)
                .join('\n'),
        );
        return 0;
      }

      default:
        io.err(`unknown command: ${command}\n`);
        io.out(USAGE);
        return 2;
    }
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function buildQuery(values: {
  type?: string;
  actor?: string;
  correlation?: string;
  limit?: string;
}): EventQuery {
  const query: EventQuery = {};
  if (values.type !== undefined) query.types = [values.type as EventType];
  if (values.actor !== undefined) query.actorId = values.actor;
  if (values.correlation !== undefined) query.correlationId = values.correlation;
  if (values.limit !== undefined) {
    const n = Number(values.limit);
    if (Number.isFinite(n)) query.limit = n;
  }
  return query;
}

const short = (hash: string | null): string => (hash ? `${hash.slice(0, 12)}…` : '(empty)');
const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
