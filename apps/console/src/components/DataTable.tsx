import type { ReactNode } from 'react';

/** Column definition for the generic DataTable. */
export interface Column<T> {
  /** Stable key, also used for the header cell. */
  key: string;
  header: string;
  /** Renders the cell content for a given row. */
  render: (row: T) => ReactNode;
  /** Optional text alignment for the column. */
  align?: 'left' | 'right' | 'center';
}

interface DataTableProps<T> {
  columns: ReadonlyArray<Column<T>>;
  rows: ReadonlyArray<T>;
  /** Returns a stable React key for a row. */
  rowKey: (row: T) => string;
  /** Shown when there are no rows. */
  emptyMessage?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  emptyMessage = 'No data.',
}: DataTableProps<T>) {
  return (
    <div className="table-wrap" role="region" aria-label="data table" tabIndex={0}>
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} style={{ textAlign: col.align ?? 'left' }} scope="col">
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="data-table__empty" colSpan={columns.length}>
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((col) => (
                  <td key={col.key} style={{ textAlign: col.align ?? 'left' }}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
