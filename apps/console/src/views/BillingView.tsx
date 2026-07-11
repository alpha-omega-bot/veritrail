import { useEffect, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import ProgressBar from '@cloudscape-design/components/progress-bar';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';

import { getUsage, startCheckout, type UsageSummary } from '../api.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { formatNumber, formatPercent } from '../format.ts';

const TIER_LABEL: Record<string, string> = {
  free: 'Free',
  starter: 'Starter',
  pro: 'Pro',
  enterprise: 'Enterprise',
};

const TIER_PRICE: Record<string, string> = {
  free: '$0 / month',
  starter: '$49 / month',
  pro: '$299 / month',
  enterprise: 'Contact sales',
};

const TIER_FEATURES: Record<string, ReadonlyArray<string>> = {
  free: ['10,000 events / month', '1 project', 'Audit + permissions + spend'],
  starter: ['100,000 events / month', '3 projects', 'Email support'],
  pro: ['1,000,000 events / month', '10 projects', 'Receipts, policy simulator, auto-RCA'],
  enterprise: ['Unlimited events', 'Unlimited projects', 'SSO, custom signing, on-prem option'],
};

export function BillingView() {
  const { session } = useAuth();
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    void (async () => {
      try {
        setUsage(await getUsage());
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load usage');
      } finally {
        setLoading(false);
      }
    })();
  }, [session]);

  if (!session) {
    return (
      <ContentLayout header={<Header variant="h1">Billing</Header>}>
        <Alert type="info" header="Sign in to view your subscription">
          Billing is available to signed-in users.
        </Alert>
      </ContentLayout>
    );
  }

  const currentOrg = session.orgs.find((o) => o.id === session.currentOrgId);
  const upgrade = async (tier: string) => {
    if (!session.currentOrgId) return;
    try {
      const { url } = await startCheckout(session.currentOrgId, tier);
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start checkout');
    }
  };

  const usagePercent = usage && usage.limit > 0 ? (usage.usage / usage.limit) * 100 : 0;

  return (
    <ContentLayout
      header={
        <Header variant="h1" description="Manage your subscription and see this month's usage.">
          Billing
        </Header>
      }
    >
      <SpaceBetween size="l">
        {error && (
          <Alert type="error" header="Could not load billing data">
            {error}
          </Alert>
        )}

        <Container header={<Header variant="h2">This period</Header>}>
          {loading ? (
            <Spinner size="large" />
          ) : usage ? (
            <SpaceBetween size="m">
              <ColumnLayout columns={3} variant="text-grid">
                <div>
                  <Box variant="awsui-key-label">Plan</Box>
                  <Box variant="h2">{TIER_LABEL[usage.tier] ?? usage.tier}</Box>
                </div>
                <div>
                  <Box variant="awsui-key-label">Events used</Box>
                  <Box variant="h2">
                    {formatNumber(usage.usage)} / {formatNumber(usage.limit)}
                  </Box>
                </div>
                <div>
                  <Box variant="awsui-key-label">Utilisation</Box>
                  <Box variant="h2">{formatPercent(usagePercent)}</Box>
                </div>
              </ColumnLayout>
              <ProgressBar
                value={Math.min(100, usagePercent)}
                status={
                  usagePercent > 100 ? 'error' : usagePercent > 80 ? 'in-progress' : 'in-progress'
                }
                ariaLabel="Period usage"
              />
              {usagePercent > 80 && usagePercent <= 100 && (
                <Alert
                  type="warning"
                  header={`You're at ${formatPercent(usagePercent)} of your plan`}
                >
                  Approaching your monthly cap. Consider upgrading to avoid throttling.
                </Alert>
              )}
              {usagePercent > 100 && (
                <Alert type="error" header="Over plan limit">
                  {usage.tier === 'free'
                    ? 'New events are being rejected. Upgrade to continue ingesting.'
                    : 'Overage is being metered. See pricing for per-event rates.'}
                </Alert>
              )}
            </SpaceBetween>
          ) : null}
        </Container>

        <Container header={<Header variant="h2">Plans</Header>}>
          <ColumnLayout columns={4} borders="vertical">
            {(['free', 'starter', 'pro', 'enterprise'] as const).map((tier) => (
              <SpaceBetween size="s" key={tier}>
                <Header variant="h3">{TIER_LABEL[tier]}</Header>
                <Box variant="h3" color="text-status-info">
                  {TIER_PRICE[tier]}
                </Box>
                {TIER_FEATURES[tier]?.map((feature) => (
                  <Box key={feature} variant="small">
                    · {feature}
                  </Box>
                ))}
                <Box padding={{ top: 's' }}>
                  {currentOrg?.tier === tier ? (
                    <Button disabled>Current plan</Button>
                  ) : tier === 'enterprise' ? (
                    <Button onClick={() => (window.location.href = 'mailto:sales@veritrail.io')}>
                      Contact sales
                    </Button>
                  ) : (
                    <Button variant="primary" onClick={() => void upgrade(tier)}>
                      {currentOrg && tierOrder(tier) < tierOrder(currentOrg.tier)
                        ? 'Downgrade'
                        : 'Upgrade'}
                    </Button>
                  )}
                </Box>
              </SpaceBetween>
            ))}
          </ColumnLayout>
        </Container>
      </SpaceBetween>
    </ContentLayout>
  );
}

function tierOrder(t: string): number {
  return ['free', 'starter', 'pro', 'enterprise'].indexOf(t);
}
