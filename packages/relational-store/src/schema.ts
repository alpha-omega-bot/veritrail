import type { SqlDialect, SqlStatement } from './sql.js';

export const EVENT_COLUMNS = [
  'seq',
  'id',
  'timestamp',
  'prev_hash',
  'hash',
  'signature',
  'signer_key_id',
  'event_type',
  'actor_id',
  'correlation_id',
  'record_json',
] as const;

export function migrationStatements(dialect: SqlDialect): readonly SqlStatement[] {
  const p1 = dialect.placeholder(1);
  return [
    {
      text: `
        CREATE TABLE IF NOT EXISTS veritrail_schema_version (
          version INTEGER PRIMARY KEY
        )
      `,
    },
    {
      text: `
        INSERT INTO veritrail_schema_version (version)
        VALUES (${p1})
        ON CONFLICT(version) DO NOTHING
      `,
      values: [1],
    },
    {
      text: `
        CREATE TABLE IF NOT EXISTS veritrail_events (
          seq INTEGER PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          timestamp INTEGER NOT NULL,
          prev_hash TEXT NOT NULL,
          hash TEXT NOT NULL UNIQUE,
          signature TEXT,
          signer_key_id TEXT,
          event_type TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          correlation_id TEXT,
          record_json TEXT NOT NULL
        )
      `,
    },
    {
      text: 'CREATE INDEX IF NOT EXISTS veritrail_events_type_idx ON veritrail_events (event_type)',
    },
    {
      text: 'CREATE INDEX IF NOT EXISTS veritrail_events_actor_idx ON veritrail_events (actor_id)',
    },
    {
      text: 'CREATE INDEX IF NOT EXISTS veritrail_events_correlation_idx ON veritrail_events (correlation_id)',
    },
  ];
}
