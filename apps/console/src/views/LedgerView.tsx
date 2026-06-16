import { getLedgerEvents, useAsync } from '../api.ts';
import { formatDateTime, shortHash } from '../format.ts';
import { Column, DataTable } from '../components/DataTable.tsx';
import { ErrorBanner, MockNotice } from '../components/ErrorBanner.tsx';
import { Loading } from '../components/Loading.tsx';
import { SeverityBadge } from '../components/Badge.tsx';
import { useMemo, useState } from 'react';
import type { LedgerEvent } from '../types.ts';

const ALL = '__all__';

export function LedgerView() {
  const { data, loading, error, fromMock } = useAsync(() => getLedgerEvents(50), []);
  const [typeFilter, setTypeFilter] = useState<string>(ALL);

  const types = useMemo(() => {
    if (data === null) return [];
    return Array.from(new Set(data.events.map((e) => e.type))).sort();
  }, [data]);

  const visible = useMemo(() => {
    if (data === null) return [];
    return typeFilter === ALL ? data.events : data.events.filter((e) => e.type === typeFilter);
  }, [data, typeFilter]);

  if (loading) return <Loading label="Loading ledger…" />;
  if (error !== null) return <ErrorBanner message={error} />;
  if (data === null) return <ErrorBanner message="No ledger data available." />;

  const columns: ReadonlyArray<Column<LedgerEvent>> = [
    { key: 'seq', header: '#', align: 'right', render: (e) => e.seq },
    { key: 'timestamp', header: 'Time', render: (e) => formatDateTime(e.timestamp) },
    {
      key: 'type',
      header: 'Type',
      render: (e) => <code className="mono">{e.type}</code>,
    },
    { key: 'agentId', header: 'Agent', render: (e) => e.agentId },
    {
      key: 'severity',
      header: 'Severity',
      render: (e) => <SeverityBadge severity={e.severity} />,
    },
    {
      key: 'correlationId',
      header: 'Correlation',
      render: (e) => <code className="mono">{e.correlationId}</code>,
    },
    {
      key: 'hash',
      header: 'Hash',
      render: (e) => (
        <code className="mono" title={e.hash}>
          {shortHash(e.hash)}
        </code>
      ),
    },
    { key: 'detail', header: 'Detail', render: (e) => e.detail },
  ];

  return (
    <section aria-labelledby="ledger-heading">
      <header className="view__header">
        <h1 id="ledger-heading">Ledger</h1>
        <p className="view__lede">
          Append-only audit events · showing {visible.length} of{' '}
          {data.total.toLocaleString('en-US')}
        </p>
      </header>

      {fromMock && <MockNotice />}

      <div className="toolbar">
        <label className="toolbar__field">
          <span>Type</span>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            aria-label="Filter events by type"
          >
            <option value={ALL}>All types</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>

      <DataTable
        columns={columns}
        rows={visible}
        rowKey={(e) => String(e.seq)}
        emptyMessage="No events match this filter."
      />
    </section>
  );
}
