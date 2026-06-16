import { BudgetStateBadge } from '../components/Badge.tsx';
import { clamp, formatUsd } from '../format.ts';
import { Column, DataTable } from '../components/DataTable.tsx';
import { ErrorBanner, MockNotice } from '../components/ErrorBanner.tsx';
import { getSpendStatus, useAsync } from '../api.ts';
import { Loading } from '../components/Loading.tsx';
import { StatCard } from '../components/StatCard.tsx';
import type { SpendStatus } from '../types.ts';

function SpendBar({ budget }: { budget: SpendStatus }) {
  const pct = budget.limitUsd > 0 ? clamp((budget.spentUsd / budget.limitUsd) * 100, 0, 100) : 0;
  const tone = budget.state === 'exceeded' ? 'error' : budget.state === 'warning' ? 'warn' : 'ok';
  return (
    <div className="bar" role="img" aria-label={`${Math.round(pct)}% of budget used`}>
      <div className={`bar__fill bar__fill--${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function SpendView() {
  const { data, loading, error, fromMock } = useAsync(getSpendStatus, []);

  if (loading) return <Loading label="Loading spend…" />;
  if (error !== null) return <ErrorBanner message={error} />;
  if (data === null) return <ErrorBanner message="No spend data available." />;

  const remaining = data.totalLimitUsd - data.totalSpentUsd;

  const columns: ReadonlyArray<Column<SpendStatus>> = [
    { key: 'label', header: 'Scope', render: (b) => b.label },
    {
      key: 'usage',
      header: 'Usage',
      render: (b) => <SpendBar budget={b} />,
    },
    { key: 'spent', header: 'Spent', align: 'right', render: (b) => formatUsd(b.spentUsd) },
    { key: 'limit', header: 'Limit', align: 'right', render: (b) => formatUsd(b.limitUsd) },
    {
      key: 'remaining',
      header: 'Remaining',
      align: 'right',
      render: (b) => (
        <span className={b.remainingUsd < 0 ? 'text-danger' : undefined}>
          {formatUsd(b.remainingUsd)}
        </span>
      ),
    },
    {
      key: 'state',
      header: 'State',
      render: (b) => <BudgetStateBadge state={b.state} />,
    },
  ];

  return (
    <section aria-labelledby="spend-heading">
      <header className="view__header">
        <h1 id="spend-heading">Spend</h1>
        <p className="view__lede">Budgets and cost control across scopes.</p>
      </header>

      {fromMock && <MockNotice />}

      <div className="stat-grid">
        <StatCard label="Total spent" value={formatUsd(data.totalSpentUsd)} />
        <StatCard label="Total limit" value={formatUsd(data.totalLimitUsd)} />
        <StatCard
          label="Remaining"
          value={
            <span className={remaining < 0 ? 'text-danger' : undefined}>
              {formatUsd(remaining)}
            </span>
          }
        />
        <StatCard
          label="Over budget"
          value={data.budgets.filter((b) => b.state === 'exceeded').length}
          hint={`${data.budgets.length} budgets total`}
        />
      </div>

      <DataTable columns={columns} rows={data.budgets} rowKey={(b) => b.scope} />
    </section>
  );
}
