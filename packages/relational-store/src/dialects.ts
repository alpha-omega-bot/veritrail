import type { SqlDialect } from './sql.js';

interface ErrorLike {
  readonly code?: unknown;
  readonly cause?: unknown;
}

function errorCode(cause: unknown): string {
  const code = (cause as ErrorLike).code;
  return typeof code === 'string' ? code : '';
}

function nestedCode(cause: unknown): string {
  const nested = (cause as ErrorLike).cause;
  return nested === undefined ? '' : errorCode(nested);
}

export const sqliteDialect: SqlDialect = {
  name: 'sqlite',
  placeholder: () => '?',
  isConflict: (cause) => {
    const code = errorCode(cause) || nestedCode(cause);
    return code === 'SQLITE_CONSTRAINT' || code.startsWith('SQLITE_CONSTRAINT_');
  },
};

export const postgresDialect: SqlDialect = {
  name: 'postgres',
  placeholder: (index) => `$${index}`,
  isConflict: (cause) => {
    const code = errorCode(cause) || nestedCode(cause);
    return code === '23505';
  },
};
