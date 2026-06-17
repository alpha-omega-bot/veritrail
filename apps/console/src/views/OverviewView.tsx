import { getAuditSummary, getHealth, getSpendStatus, getVendorRisk, useAsync } from '../api.ts';
import { ErrorBanner, MockNotice } from '../components/ErrorBanner.tsx';
import { IntegrityBadge, RiskBandBadge } from '../components/Badge.tsx';
import { formatDateTime, formatUsd, shortHash } from '../format.ts';
import { Loading } from '../components/Loading.tsx';
import { StatCard } from '../components/StatCard.tsx';
import type { RiskBand } from '../types.ts';

const BAND_RANK: Record<RiskBand, number> = { low: 0, moderate: 1, elevated: 2, high: 3 };

export function OverviewView() {
  const summary = useAsync(getAuditSummary, []);
  const spend = useAsync(getSpendStatus, []);
  const vendors = useAsync(getVendorRisk, []);
  const health = useAsync(getHealth, []);

  const loading = summary.loading || spend.loading || vendors.loading || health.loading;
  const usingMock = summary.fromMock || spend.fromMock || vendors.fromMock || health.fromMock;

  if (loading) return <Loading label="Loading overview…" />;
  if (summary.error !== null) return <ErrorBanner message={summary.error} />;
  if (summary.data === null) return <ErrorBanner message="No audit summary available." />;

  const topVendor =
    vendors.data?.vendors.reduce<(typeof vendors.data.vendors)[number] | null>((worst, v) => {
      if (worst === null) return v;
      return BAND_RANK[v.band] > BAND_RANK[worst.band] || v.score > worst.score ? v : worst;
    }, null) ?? null;

  return (
    <section aria-labelledby="overview-heading">
      <header className="view__header">
        <h1 id="overview-heading">Overview</h1>
        <p className="view__lede">
          Ledger integrity, spend, and vendor risk at a glance
          {health.data && !health.fromMock ? ` · API ${health.data.version}` : ''}.
        </p>
      </header>

      {usingMock && <MockNotice />}

      <div className="hero-card">
        <div>
          <div className="hero-card__label">Audit ledger integrity</div>
          <div className="hero-card__badge">
            <IntegrityBadge ok={summary.data.integrityOk} />
          </div>
          <div className="hero-card__meta">
            Last hash <code>{shortHash(summary.data.lastHash)}</code>
          </div>
        </div>
        <div className="hero-card__meta hero-card__meta--right">
          Last event {formatDateTime(summary.data.lastEventAt)}
        </div>
      </div>

      <div className="stat-grid">
        <StatCard
          label="Total events"
          value={summary.data.totalEvents.toLocaleString('en-US')}
          hint={`${summary.data.distinctAgents} agents`}
        />
        <StatCard
          label="Spend this period"
          value={spend.data ? formatUsd(spend.data.totalSpentUsd) : '—'}
          hint={spend.data ? `of ${formatUsd(spend.data.totalLimitUsd)} limit` : undefined}
        />
        <StatCard
          label="Budgets tracked"
          value={spend.data ? spend.data.budgets.length : '—'}
          hint={
            spend.data
              ? `${spend.data.budgets.filter((b) => b.state !== 'ok').length} need attention`
              : undefined
          }
        />
        <StatCard
          label="Highest vendor risk"
          value={topVendor ? <RiskBandBadge band={topVendor.band} /> : '—'}
          hint={topVendor ? `${topVendor.name} · ${topVendor.score}/100` : undefined}
        />
      </div>
    </section>
  );
}
