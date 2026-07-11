import { formatDateTime } from '../format.ts';
import { getVendorRisk, useAsync } from '../api.ts';
import { RiskBandStatus } from '../status.tsx';
import { TableSkeleton } from '../LoadingSkeleton.tsx';
import type { RiskBand, VendorRiskScore } from '../types.ts';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';

const BAND_RANK: Record<RiskBand, number> = { low: 0, moderate: 1, elevated: 2, high: 3 };

export function VendorRiskView() {
  const { data, loading, error, fromMock } = useAsync(getVendorRisk, []);

  const ranked =
    data === null
      ? []
      : [...data.vendors].sort((a, b) => {
          const byBand = BAND_RANK[b.band] - BAND_RANK[a.band];
          return byBand !== 0 ? byBand : b.score - a.score;
        });

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          counter={data ? `(${ranked.length})` : undefined}
          description="External providers ranked by composite risk score."
        >
          Vendor Risk
        </Header>
      }
    >
      <SpaceBetween size="l">
        {fromMock && (
          <Alert type="info" header="Showing sample data">
            The console could not reach the Veritrail API, so it is displaying sample data.
          </Alert>
        )}
        {loading && <TableSkeleton rows={4} />}
        {!loading && error !== null && (
          <Alert type="error" header="Failed to load vendor risk">
            {error}
          </Alert>
        )}
        {!loading && error === null && data !== null && (
          <Table<VendorRiskScore>
            variant="container"
            stickyHeader
            items={ranked}
            trackBy={(v) => v.vendorId}
            columnDefinitions={[
              {
                id: 'rank',
                header: '#',
                cell: (v) => ranked.indexOf(v) + 1,
                width: 70,
              },
              { id: 'name', header: 'Vendor', cell: (v) => v.name },
              {
                id: 'score',
                header: 'Score',
                cell: (v) => <Box fontWeight="bold">{v.score}</Box>,
                width: 100,
              },
              { id: 'band', header: 'Band', cell: (v) => <RiskBandStatus band={v.band} /> },
              {
                id: 'factors',
                header: 'Contributing factors',
                cell: (v) => (
                  <SpaceBetween direction="horizontal" size="xs">
                    {v.factors.map((f) => (
                      <Badge key={f}>{f}</Badge>
                    ))}
                  </SpaceBetween>
                ),
              },
              { id: 'assessedAt', header: 'Assessed', cell: (v) => formatDateTime(v.assessedAt) },
            ]}
          />
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}
