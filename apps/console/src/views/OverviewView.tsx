import {
  getAuditSummary,
  getHealth,
  getSpendStatus,
  getVendorRisk,
  useAsync,
  type ApiError,
} from '../api.ts';
import {
  EMPTY,
  formatCount,
  formatDateTime,
  formatDuration,
  formatMoney,
  shortHash,
} from '../format.ts';
import { CredentialPanel, ErrorAlert, Loading, Metric } from '../components.tsx';
import { IntegrityStatus, RiskBandStatus } from '../status.tsx';
import type { Money, SpendStatus } from '../types.ts';
import Box from '@cloudscape-design/components/box';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import SpaceBetween from '@cloudscape-design/components/space-between';

/**
 * Total spend and limit across budgets, but only when every budget shares one
 * currency. Summing minor units across currencies would be meaningless, so mixed
 * portfolios report `null` and the UI shows a per-budget breakdown instead.
 */
function aggregateSpend(budgets: readonly SpendStatus[]): { spent: Money; limit: Money } | null {
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

/** True when any request failed because credentials are missing or inadequate. */
function needsCredentials(errors: readonly (ApiError | null)[]): boolean {
  return errors.some((e) => e !== null && (e.kind === 'unauthorized' || e.kind === 'forbidden'));
}

export function OverviewView() {
  const summary = useAsync(getAuditSummary, []);
  const spend = useAsync(getSpendStatus, []);
  const vendors = useAsync(getVendorRisk, []);
  const health = useAsync(getHealth, []);

  const loading = summary.loading || spend.loading || vendors.loading || health.loading;
  const errors = [summary.error, spend.error, vendors.error, health.error];

  const reloadAll = () => {
    summary.reload();
    spend.reload();
    vendors.reload();
    health.reload();
  };

  // The server sorts assessments riskiest-first, so the head is the top risk.
  const topVendor = vendors.data !== null && vendors.data.length > 0 ? vendors.data[0]! : null;
  const totals = spend.data !== null ? aggregateSpend(spend.data) : null;
  const exceededCount = spend.data?.filter((b) => b.exceeded).length ?? 0;

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description={
            health.data !== null
              ? `Ledger integrity, spend, and vendor risk. API ${health.data.version}, up ${formatDuration(health.data.uptimeMs)}.`
              : 'Ledger integrity, spend, and vendor risk at a glance.'
          }
        >
          Overview
        </Header>
      }
    >
      <SpaceBetween size="l">
        {needsCredentials(errors) && <CredentialPanel onChange={reloadAll} />}

        {loading && <Loading label="Loading overview" />}

        {!loading && (
          <SpaceBetween size="l">
            {/* Integrity is reported only from a real verification result. */}
            <Container header={<Header variant="h2">Audit ledger integrity</Header>}>
              {summary.error !== null ? (
                <ErrorAlert error={summary.error} onRetry={summary.reload} />
              ) : (
                summary.data !== null && (
                  <KeyValuePairs
                    columns={4}
                    items={[
                      {
                        label: 'Chain integrity',
                        value: <IntegrityStatus ok={summary.data.integrityOk} />,
                      },
                      {
                        label: 'Head hash',
                        value: (
                          <Box variant="code">
                            <span title={summary.data.head ?? undefined}>
                              {shortHash(summary.data.head)}
                            </span>
                          </Box>
                        ),
                      },
                      { label: 'First event', value: formatDateTime(summary.data.firstAt) },
                      { label: 'Latest event', value: formatDateTime(summary.data.lastAt) },
                    ]}
                  />
                )
              )}
            </Container>

            <Container header={<Header variant="h2">Key metrics</Header>}>
              <ColumnLayout columns={4} variant="text-grid">
                <Metric
                  label="Ledger records"
                  value={
                    summary.error !== null
                      ? EMPTY
                      : summary.data !== null
                        ? formatCount(summary.data.totalRecords)
                        : EMPTY
                  }
                  {...(summary.data !== null
                    ? { hint: `${formatCount(summary.data.actorCount)} distinct actors` }
                    : {})}
                />
                <Metric
                  label="Spend to date"
                  value={
                    spend.error !== null
                      ? EMPTY
                      : totals !== null
                        ? formatMoney(totals.spent)
                        : EMPTY
                  }
                  {...(totals !== null
                    ? { hint: `of ${formatMoney(totals.limit)} across all budgets` }
                    : spend.data !== null && spend.data.length > 0
                      ? { hint: 'Multiple currencies — see Spend' }
                      : {})}
                />
                <Metric
                  label="Budgets tracked"
                  value={
                    spend.error !== null
                      ? EMPTY
                      : spend.data !== null
                        ? formatCount(spend.data.length)
                        : EMPTY
                  }
                  {...(spend.data !== null
                    ? { hint: `${formatCount(exceededCount)} over limit` }
                    : {})}
                />
                <Metric
                  label="Highest vendor risk"
                  value={
                    vendors.error !== null ? (
                      EMPTY
                    ) : topVendor !== null ? (
                      <RiskBandStatus band={topVendor.band} />
                    ) : (
                      EMPTY
                    )
                  }
                  {...(topVendor !== null
                    ? { hint: `${topVendor.name} · score ${formatCount(topVendor.score)}` }
                    : vendors.data !== null
                      ? { hint: 'No vendors registered' }
                      : {})}
                />
              </ColumnLayout>
            </Container>

            {/* Surface non-integrity failures without blocking the rest of the page. */}
            {spend.error !== null && <ErrorAlert error={spend.error} onRetry={spend.reload} />}
            {vendors.error !== null && (
              <ErrorAlert error={vendors.error} onRetry={vendors.reload} />
            )}
          </SpaceBetween>
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}
