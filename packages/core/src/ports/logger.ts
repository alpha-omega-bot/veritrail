import type { JsonValue } from '../util/canonical.js';

/**
 * Structured logging port. Observability is first-class: the platform emits
 * structured events (not free text) so that logs are queryable and correlatable
 * with the ledger. Adapters (pino, OpenTelemetry, etc.) implement this interface.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, JsonValue>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Return a child logger that adds `bindings` to every record. */
  child(bindings: LogFields): Logger;
}

/** Discards all logs. The default, so libraries are silent unless wired up. */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

/** Minimal JSON-lines logger to stderr, useful for local development. */
export class ConsoleLogger implements Logger {
  readonly #bindings: LogFields;

  constructor(bindings: LogFields = {}) {
    this.#bindings = bindings;
  }

  #emit(level: LogLevel, message: string, fields?: LogFields): void {
    const record: LogFields = {
      level,
      msg: message,
      ...this.#bindings,
      ...(fields ?? {}),
    };
    process.stderr.write(`${JSON.stringify(record)}\n`);
  }

  debug(message: string, fields?: LogFields): void {
    this.#emit('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.#emit('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.#emit('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.#emit('error', message, fields);
  }

  child(bindings: LogFields): Logger {
    return new ConsoleLogger({ ...this.#bindings, ...bindings });
  }
}
