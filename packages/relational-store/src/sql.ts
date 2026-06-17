export type SqlValue = string | number | null;

export interface SqlStatement {
  readonly text: string;
  readonly values?: readonly SqlValue[];
}

export type SqlRow = Record<string, unknown>;

export interface SqlResult {
  readonly rows: readonly SqlRow[];
}

export interface SqlConnection {
  execute(statement: SqlStatement): Promise<SqlResult>;
}

export interface SqlDatabase extends SqlConnection {
  transaction<T>(fn: (tx: SqlConnection) => Promise<T>): Promise<T>;
}

export interface SqlDialect {
  readonly name: string;
  placeholder(index: number): string;
  isConflict(cause: unknown): boolean;
}
