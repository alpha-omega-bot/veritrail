import { getSpendStatus, useAsync } from '../api.ts';
import { BudgetStateStatus } from '../status.tsx';
import { CredentialPanel, ErrorAlert, Loading, Metric } from '../components.tsx';
import { EMPTY, formatCount, formatMoney, isNegative, usagePercent } from '../format.ts';
import type { Money, SpendStatus } from '../types.ts';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import ProgressBar from '@cloudscape-design/components/progress-bar';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';

/** Human label for a budget's matching scope. */
function scopeLabel(status: SpendStatus): string {
  const { kind, value } = status.budget.scope;
  if (kind === 'global') return 'Global';
  if (kind === 'actor') return `Actor: ${value}`;
  return `Label: ${value}`;
}

/**
 * Sum spend and limit across budgets, but only when they share a single
 * currency — adding minor units across currencies would produce a meaningless
 * number.
 */
function aggregate(budgets: readonly SpendStatus[]): { spent: Money; limit: Money } | null {
  if (budgets.length === 0) return null;
  const currency = budgets[0]!.budget.limit.currency;
  const uniform = budgets.every(
    (b) => b.budget.limit.currency === currency && b.spent.currency === currency,
  );
  if (!uniform) return null;
  return {
    spent: {
      currency,
      amountMinor: budgets.reduce((total, b) => total + b.spent.amountMinor, 0),
    },
    limit: {
      currency,
      amountMinor: budgets.reduce((total, b) => total + b.budget.limit.amountMinor, 0),
    },
  };
}

export function SpendView() {
  const { data, loading, error, reload } = useAsync(getSpendStatus, []);
  const needsCredentials =
    error !== null && (error.kind === 'unauthorized' || error.kind === 'forbidden');

  const totals = data !== null ? aggregate(data) : null;
  const mixedCurrencies = data !== null && data.length > 0 && totals === null;
  const remaining: Money | null =
    totals !== null
      ? {
          currency: totals.limit.currency,
          amountMinor: totals.limit.amountMinor - totals.spent.amountMinor,
        }
      : null;

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          {...(data !== null ? { counter: `(${formatCount(data.length)})` } : {})}
          description="Budgets and hard-stop cost control across actor, label, and global scopes."
        >
          Spend
        </Header>
      }
    >
      <SpaceBetween size="l">
        {needsCredentials && <CredentialPanel onChange={reload} />}
        {loading && <Loading label="Loading budgets" />}
        {!loading && error !== null && <ErrorAlert error={error} onRetry={reload} />}
        {!loading && error === null && data !== null && (
          <>
            {data.length === 0 && (
              <Alert type="info" header="No budgets configured">
                No spend budgets are currently defined on the server. Budgets are held in memory and
                must be re-created after a server restart.
              </Alert>
            )}

            {data.length > 0 && (
              <Container header={<Header variant="h2">Totals</Header>}>
                {mixedCurrencies ? (
                  <Alert type="info" header="Multiple currencies in use">
                    These budgets span more than one currency, so a combined total is not
                    meaningful. See the per-budget figures below.
                  </Alert>
                ) : (
                  <ColumnLayout columns={4} variant="text-grid">
                    <Metric label="Total spent" value={formatMoney(totals?.spent)} />
                    <Metric label="Total limit" value={formatMoney(totals?.limit)} />
                    <Metric
                      label="Remaining"
                      value={
                        <Box
                          variant="h2"
                          color={isNegative(remaining) ? 'text-status-error' : undefined}
                        >
                          {formatMoney(remaining)}
                        </Box>
                      }
                    />
                    <Metric
                      label="Over limit"
                      value={formatCount(data.filter((b) => b.exceeded).length)}
                      hint={`${formatCount(data.length)} budgets total`}
                    />
                  </ColumnLayout>
                )}
              </Container>
            )}

            {data.length > 0 && (
              <Table<SpendStatus>
                variant="container"
                stickyHeader
                resizableColumns
                items={data}
                trackBy={(b) => b.budget.id}
                columnDefinitions={[
                  { id: 'name', header: 'Budget', cell: (b) => b.budget.name },
                  { id: 'scope', header: 'Scope', cell: (b) => scopeLabel(b) },
                  {
                    id: 'window',
                    header: 'Window',
                    cell: (b) => b.budget.window,
                    width: 110,
                  },
                  {
                    id: 'usage',
                    header: 'Usage',
                    cell: (b) => {
                      const percent = usagePercent(b.spent, b.budget.limit);
                      return (
                        <ProgressBar
                          value={percent}
                          status={b.exceeded ? 'error' : 'in-progress'}
                          ariaLabel={`${Math.round(percent)} percent of ${b.budget.name} used`}
                        />
                      );
                    },
                    width: 220,
                  },
                  { id: 'spent', header: 'Spent', cell: (b) => formatMoney(b.spent) },
                  { id: 'limit', header: 'Limit', cell: (b) => formatMoney(b.budget.limit) },
                  {
                    id: 'remaining',
                    header: 'Remaining',
                    cell: (b) => (
                      <Box color={isNegative(b.remaining) ? 'text-status-error' : undefined}>
                        {formatMoney(b.remaining)}
                      </Box>
                    ),
                  },
                  {
                    id: 'enforcement',
                    header: 'Enforcement',
                    cell: (b) =>
                      !b.budget.enabled
                        ? 'Disabled'
                        : b.budget.hardStop
                          ? 'Hard stop'
                          : 'Warn only',
                    width: 130,
                  },
                  {
                    id: 'state',
                    header: 'State',
                    cell: (b) => <BudgetStateStatus exceeded={b.exceeded} />,
                  },
                ]}
                empty={
                  <Box textAlign="center" color="inherit">
                    {EMPTY}
                  </Box>
                }
              />
            )}
          </>
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}
