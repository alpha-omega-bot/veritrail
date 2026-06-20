import { getAuditSummary, getHealth, getSpendStatus, getVendorRisk, useAsync } from '../api.ts';
import { formatDateTime, formatUsd, shortHash } from '../format.ts';
import { IntegrityStatus, RiskBandStatus } from '../status.tsx';
import type { RiskBand } from '../types.ts';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';

const BAND_RANK: Record<RiskBand, number> = { low: 0, moderate: 1, elevated: 2, high: 3 };

function Metric({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div>
      <Box variant="awsui-key-label">{label}</Box>
      <Box variant="h2" padding={{ top: 'xxs' }}>
        {value}
      </Box>
      {hint !== undefined && (
        <Box variant="small" color="text-body-secondary">
          {hint}
        </Box>
      )}
    </div>
  );
}

export function OverviewView() {
  const summary = useAsync(getAuditSummary, []);
  const spend = useAsync(getSpendStatus, []);
  const vendors = useAsync(getVendorRisk, []);
  const health = useAsync(getHealth, []);

  const loading = summary.loading || spend.loading || vendors.loading || health.loading;
  const usingMock = summary.fromMock || spend.fromMock || vendors.fromMock || health.fromMock;

  const topVendor =
    vendors.data?.vendors.reduce<(typeof vendors.data.vendors)[number] | null>((worst, v) => {
      if (worst === null) return v;
      return BAND_RANK[v.band] > BAND_RANK[worst.band] || v.score > worst.score ? v : worst;
    }, null) ?? null;

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description={`Ledger integrity, spend, and vendor risk at a glance${
            health.data && !health.fromMock ? ` · API ${health.data.version}` : ''
          }.`}
        >
          Overview
        </Header>
      }
    >
      <SpaceBetween size="l">
        {usingMock && (
          <Alert type="info" header="Showing sample data">
            The console could not reach the Veritrail API, so it is displaying sample data.
          </Alert>
        )}

        {loading && <Spinner size="large" />}

        {!loading && summary.error !== null && (
          <Alert type="error" header="Failed to load overview">
            {summary.error}
          </Alert>
        )}

        {!loading && summary.error === null && summary.data !== null && (
          <>
            <Container header={<Header variant="h2">Audit ledger integrity</Header>}>
              <KeyValuePairs
                columns={3}
                items={[
                  {
                    label: 'Integrity',
                    value: <IntegrityStatus ok={summary.data.integrityOk} />,
                  },
                  {
                    label: 'Last hash',
                    value: <Box variant="code">{shortHash(summary.data.lastHash)}</Box>,
                  },
                  { label: 'Last event', value: formatDateTime(summary.data.lastEventAt) },
                ]}
              />
            </Container>

            <Container>
              <ColumnLayout columns={4} variant="text-grid">
                <Metric
                  label="Total events"
                  value={summary.data.totalEvents.toLocaleString('en-US')}
                  hint={`${summary.data.distinctAgents} agents`}
                />
                <Metric
                  label="Spend this period"
                  value={spend.data ? formatUsd(spend.data.totalSpentUsd) : '—'}
                  hint={spend.data ? `of ${formatUsd(spend.data.totalLimitUsd)} limit` : undefined}
                />
                <Metric
                  label="Budgets tracked"
                  value={spend.data ? spend.data.budgets.length : '—'}
                  hint={
                    spend.data
                      ? `${spend.data.budgets.filter((b) => b.state !== 'ok').length} need attention`
                      : undefined
                  }
                />
                <Metric
                  label="Highest vendor risk"
                  value={topVendor ? <RiskBandStatus band={topVendor.band} /> : '—'}
                  hint={topVendor ? `${topVendor.name} · ${topVendor.score}/100` : undefined}
                />
              </ColumnLayout>
            </Container>
          </>
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}
