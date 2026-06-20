import { BudgetStateStatus } from '../status.tsx';
import { clamp, formatUsd } from '../format.ts';
import { getSpendStatus, useAsync } from '../api.ts';
import type { SpendStatus } from '../types.ts';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import ProgressBar from '@cloudscape-design/components/progress-bar';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import Table from '@cloudscape-design/components/table';

function usagePercent(budget: SpendStatus): number {
  return budget.limitUsd > 0 ? clamp((budget.spentUsd / budget.limitUsd) * 100, 0, 100) : 0;
}

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

export function SpendView() {
  const { data, loading, error, fromMock } = useAsync(getSpendStatus, []);
  const remaining = data ? data.totalLimitUsd - data.totalSpentUsd : 0;

  return (
    <ContentLayout
      header={
        <Header variant="h1" description="Budgets and cost control across scopes.">
          Spend
        </Header>
      }
    >
      <SpaceBetween size="l">
        {fromMock && (
          <Alert type="info" header="Showing sample data">
            The console could not reach the Veritrail API, so it is displaying sample data.
          </Alert>
        )}
        {loading && <Spinner size="large" />}
        {!loading && error !== null && (
          <Alert type="error" header="Failed to load spend">
            {error}
          </Alert>
        )}
        {!loading && error === null && data !== null && (
          <>
            <Container>
              <ColumnLayout columns={4} variant="text-grid">
                <Metric label="Total spent" value={formatUsd(data.totalSpentUsd)} />
                <Metric label="Total limit" value={formatUsd(data.totalLimitUsd)} />
                <Metric
                  label="Remaining"
                  value={
                    <Box variant="h2" color={remaining < 0 ? 'text-status-error' : undefined}>
                      {formatUsd(remaining)}
                    </Box>
                  }
                />
                <Metric
                  label="Over budget"
                  value={data.budgets.filter((b) => b.state === 'exceeded').length}
                  hint={`${data.budgets.length} budgets total`}
                />
              </ColumnLayout>
            </Container>

            <Table<SpendStatus>
              variant="container"
              stickyHeader
              items={data.budgets}
              trackBy={(b) => b.scope}
              columnDefinitions={[
                { id: 'label', header: 'Scope', cell: (b) => b.label },
                {
                  id: 'usage',
                  header: 'Usage',
                  cell: (b) => (
                    <ProgressBar
                      value={usagePercent(b)}
                      status={b.state === 'exceeded' ? 'error' : 'in-progress'}
                      ariaLabel={`${Math.round(usagePercent(b))}% of budget used`}
                    />
                  ),
                  width: 220,
                },
                { id: 'spent', header: 'Spent', cell: (b) => formatUsd(b.spentUsd) },
                { id: 'limit', header: 'Limit', cell: (b) => formatUsd(b.limitUsd) },
                {
                  id: 'remaining',
                  header: 'Remaining',
                  cell: (b) => (
                    <Box color={b.remainingUsd < 0 ? 'text-status-error' : undefined}>
                      {formatUsd(b.remainingUsd)}
                    </Box>
                  ),
                },
                {
                  id: 'state',
                  header: 'State',
                  cell: (b) => <BudgetStateStatus state={b.state} />,
                },
              ]}
            />
          </>
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}
