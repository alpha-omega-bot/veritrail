import { useEffect, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import ProgressBar from '@cloudscape-design/components/progress-bar';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import Table from '@cloudscape-design/components/table';

import {
  getCostForecast,
  getUsage,
  type CostForecastResponse,
  type ModelSwapRecommendation,
  type SpendAnomaly,
  type UsageSummary,
} from '../api.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { formatDateTime, formatNumber, formatPercent, formatUsd } from '../format.ts';

const TIER_LABEL: Record<string, string> = {
  free: 'Free',
  starter: 'Starter',
  pro: 'Pro',
  enterprise: 'Enterprise',
};

function planLabel(tier: string): string {
  return TIER_LABEL[tier] ?? tier;
}

function minorToUsd(minor: number): string {
  return formatUsd(minor / 100);
}

function daysRemaining(periodEnd: number): number {
  const ms = periodEnd - Date.now();
  if (ms <= 0) return 0;
  return Math.ceil(ms / 86_400_000);
}

export function UsageAnalyticsView() {
  const { session } = useAuth();
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [forecast, setForecast] = useState<CostForecastResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [forecastError, setForecastError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      let usageResult: UsageSummary | null = null;
      try {
        usageResult = await getUsage();
        if (!cancelled) setUsage(usageResult);
      } catch (e) {
        if (!cancelled) {
          setUsageError(e instanceof Error ? e.message : 'Failed to load usage summary');
        }
      }

      if (usageResult && usageResult.periodEnd > usageResult.periodStart) {
        try {
          const fc = await getCostForecast(usageResult.periodStart, usageResult.periodEnd);
          if (!cancelled) setForecast(fc);
        } catch (e) {
          if (!cancelled) {
            setForecastError(e instanceof Error ? e.message : 'Failed to load spend forecast');
          }
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  if (!session) {
    return (
      <ContentLayout header={<Header variant="h1">Usage analytics</Header>}>
        <Alert type="info" header="Sign in to use this feature">
          Usage analytics is available to signed-in users.
        </Alert>
      </ContentLayout>
    );
  }

  const utilizationPercent = usage && usage.limit > 0 ? (usage.usage / usage.limit) * 100 : 0;
  const utilizationStatus: 'in-progress' | 'error' | 'success' =
    utilizationPercent > 100 ? 'error' : utilizationPercent >= 100 ? 'success' : 'in-progress';

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Plan utilization and forecasted spend for the current billing period."
        >
          Usage analytics
        </Header>
      }
    >
      <SpaceBetween size="l">
        {usageError && (
          <Alert type="error" header="Could not load usage summary">
            {usageError}
          </Alert>
        )}
        {forecastError && (
          <Alert type="error" header="Could not load spend forecast">
            {forecastError}
          </Alert>
        )}

        <Container header={<Header variant="h2">Plan utilization</Header>}>
          {loading && usage === null ? (
            <Spinner size="large" />
          ) : usage ? (
            <SpaceBetween size="m">
              <KeyValuePairs
                columns={4}
                items={[
                  { label: 'Plan', value: planLabel(usage.tier) },
                  {
                    label: 'Period',
                    value: `${formatDateTime(new Date(usage.periodStart).toISOString())} → ${formatDateTime(new Date(usage.periodEnd).toISOString())}`,
                  },
                  {
                    label: 'Events used',
                    value: `${formatNumber(usage.usage)} / ${formatNumber(usage.limit)}`,
                  },
                  { label: 'Days remaining', value: formatNumber(daysRemaining(usage.periodEnd)) },
                ]}
              />
              <ProgressBar
                value={Math.min(100, utilizationPercent)}
                status={utilizationStatus}
                additionalInfo={`${formatPercent(utilizationPercent)} utilization`}
                ariaLabel="Plan utilization"
                label="Plan utilization"
              />
              <KeyValuePairs
                columns={3}
                items={[
                  { label: 'Tier', value: planLabel(usage.tier) },
                  { label: 'Period events', value: formatNumber(usage.usage) },
                  { label: 'Plan limit', value: formatNumber(usage.limit) },
                  { label: 'Utilization', value: formatPercent(utilizationPercent) },
                  {
                    label: 'Period start',
                    value: formatDateTime(new Date(usage.periodStart).toISOString()),
                  },
                  {
                    label: 'Period end',
                    value: formatDateTime(new Date(usage.periodEnd).toISOString()),
                  },
                ]}
              />
            </SpaceBetween>
          ) : (
            <Box color="text-body-secondary">No usage summary available.</Box>
          )}
        </Container>

        <Container header={<Header variant="h2">Spend forecast</Header>}>
          {loading && forecast === null && usage !== null ? (
            <Spinner size="large" />
          ) : forecast?.forecast ? (
            <SpaceBetween size="m">
              <KeyValuePairs
                columns={3}
                items={[
                  {
                    label: 'Projected total',
                    value: minorToUsd(forecast.forecast.projectedTotalMinor),
                  },
                  { label: 'Daily run rate', value: minorToUsd(forecast.forecast.dailyRateMinor) },
                  { label: 'Spent so far', value: minorToUsd(forecast.forecast.actualTotalMinor) },
                ]}
              />
              <ProgressBar
                value={Math.min(100, forecast.forecast.progress * 100)}
                status="in-progress"
                additionalInfo={`${formatPercent(forecast.forecast.progress * 100)} through the period`}
                ariaLabel="Period progress"
                label="Period progress"
              />
            </SpaceBetween>
          ) : (
            <Box color="text-body-secondary">Not enough spend data yet to project this period.</Box>
          )}
        </Container>

        <Container
          header={
            <Header variant="h2" counter={forecast ? `(${forecast.anomalies.length})` : undefined}>
              Anomalies
            </Header>
          }
        >
          <Table<SpendAnomaly>
            variant="embedded"
            items={forecast?.anomalies ?? []}
            trackBy={(a) => String(a.dayMs)}
            empty={
              <Box textAlign="center" color="inherit">
                No spend anomalies detected for this period.
              </Box>
            }
            columnDefinitions={[
              {
                id: 'date',
                header: 'Date',
                cell: (a) => formatDateTime(new Date(a.dayMs).toISOString()),
              },
              {
                id: 'amount',
                header: 'Amount',
                cell: (a) => minorToUsd(a.amountMinor),
              },
              {
                id: 'zScore',
                header: 'Z-score',
                cell: (a) => a.zScore.toFixed(2),
              },
              {
                id: 'summary',
                header: 'Summary',
                cell: (a) => a.summary,
              },
            ]}
          />
        </Container>

        <Container
          header={
            <Header
              variant="h2"
              counter={forecast ? `(${forecast.recommendations.length})` : undefined}
            >
              Recommendations
            </Header>
          }
        >
          <Table<ModelSwapRecommendation>
            variant="embedded"
            items={forecast?.recommendations ?? []}
            trackBy={(r) => `${r.currentModel}->${r.recommendedModel}`}
            empty={
              <Box textAlign="center" color="inherit">
                No model swap recommendations available.
              </Box>
            }
            columnDefinitions={[
              {
                id: 'current',
                header: 'Current model',
                cell: (r) => <Box variant="code">{r.currentModel}</Box>,
              },
              {
                id: 'recommended',
                header: 'Recommended model',
                cell: (r) => <Box variant="code">{r.recommendedModel}</Box>,
              },
              {
                id: 'savings',
                header: 'Projected savings',
                cell: (r) => minorToUsd(r.projectedSavingsMinor),
              },
              {
                id: 'confidence',
                header: 'Confidence',
                cell: (r) => formatPercent(r.confidence * 100),
              },
            ]}
          />
        </Container>
      </SpaceBetween>
    </ContentLayout>
  );
}
