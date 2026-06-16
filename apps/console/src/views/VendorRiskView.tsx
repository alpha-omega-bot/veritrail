import { Column, DataTable } from '../components/DataTable.tsx';
import { ErrorBanner, MockNotice } from '../components/ErrorBanner.tsx';
import { formatDateTime } from '../format.ts';
import { getVendorRisk, useAsync } from '../api.ts';
import { Loading } from '../components/Loading.tsx';
import { RiskBandBadge } from '../components/Badge.tsx';
import type { RiskBand, VendorRiskScore } from '../types.ts';

const BAND_RANK: Record<RiskBand, number> = { low: 0, moderate: 1, elevated: 2, high: 3 };

export function VendorRiskView() {
  const { data, loading, error, fromMock } = useAsync(getVendorRisk, []);

  if (loading) return <Loading label="Loading vendor risk…" />;
  if (error !== null) return <ErrorBanner message={error} />;
  if (data === null) return <ErrorBanner message="No vendor risk data available." />;

  const ranked = [...data.vendors].sort((a, b) => {
    const byBand = BAND_RANK[b.band] - BAND_RANK[a.band];
    return byBand !== 0 ? byBand : b.score - a.score;
  });

  const columns: ReadonlyArray<Column<VendorRiskScore>> = [
    {
      key: 'rank',
      header: '#',
      align: 'right',
      render: (v) => ranked.indexOf(v) + 1,
    },
    { key: 'name', header: 'Vendor', render: (v) => v.name },
    {
      key: 'score',
      header: 'Score',
      align: 'right',
      render: (v) => <strong>{v.score}</strong>,
    },
    { key: 'band', header: 'Band', render: (v) => <RiskBandBadge band={v.band} /> },
    {
      key: 'factors',
      header: 'Contributing factors',
      render: (v) => (
        <ul className="chip-list">
          {v.factors.map((f) => (
            <li key={f} className="chip">
              {f}
            </li>
          ))}
        </ul>
      ),
    },
    { key: 'assessedAt', header: 'Assessed', render: (v) => formatDateTime(v.assessedAt) },
  ];

  return (
    <section aria-labelledby="vendor-heading">
      <header className="view__header">
        <h1 id="vendor-heading">Vendor Risk</h1>
        <p className="view__lede">External providers ranked by composite risk score.</p>
      </header>

      {fromMock && <MockNotice />}

      <DataTable columns={columns} rows={ranked} rowKey={(v) => v.vendorId} />
    </section>
  );
}
