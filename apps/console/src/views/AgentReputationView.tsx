import { useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';

import { formatDateTime, formatNumber, formatUsd } from '../format.ts';

type Badge = 'verified' | 'caution' | 'unverified';

interface ReputationFactor {
  readonly name: string;
  readonly impact: number;
  readonly reason: string;
}

interface AgentReputation {
  readonly agentId: string;
  readonly badge: Badge;
  readonly score: number;
  readonly totalDecisions: number;
  readonly totalActions: number;
  readonly denialRate: number;
  readonly spendUsdMinor: number;
  readonly incidentCount: number;
  readonly verifiedSince: string | null;
  readonly factors: ReadonlyArray<ReputationFactor>;
}

function badgeStatusType(badge: Badge): 'success' | 'error' | 'info' {
  if (badge === 'verified') return 'success';
  if (badge === 'caution') return 'error';
  return 'info';
}

function badgeLabel(badge: Badge): string {
  if (badge === 'verified') return 'Verified';
  if (badge === 'caution') return 'Caution';
  return 'Unverified';
}

function scoreColor(
  badge: Badge,
): 'text-status-success' | 'text-status-warning' | 'text-status-error' {
  if (badge === 'verified') return 'text-status-success';
  if (badge === 'caution') return 'text-status-error';
  return 'text-status-warning';
}

export function AgentReputationView() {
  const [agentId, setAgentId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<AgentReputation | null>(null);
  const [copied, setCopied] = useState(false);

  const lookup = async () => {
    const id = agentId.trim();
    if (!id) return;
    setLoading(true);
    setError(null);
    setProfile(null);
    setCopied(false);
    try {
      const res = await fetch(`/api/v1/agent/${encodeURIComponent(id)}/reputation`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const data = (await res.json()) as AgentReputation;
      setProfile(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load reputation');
    } finally {
      setLoading(false);
    }
  };

  const copyBadgeUrl = () => {
    if (!profile) return;
    const url = `/api/v1/agent/${encodeURIComponent(profile.agentId)}/reputation/badge`;
    void navigator.clipboard.writeText(url);
    setCopied(true);
  };

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Look up the public reputation profile for any agent by its ID."
        >
          Agent reputation
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Container header={<Header variant="h2">Lookup</Header>}>
          <SpaceBetween size="m">
            <FormField label="Agent ID" description="Public agent identifier.">
              <Input
                value={agentId}
                onChange={(e: { detail: { value: string } }) => setAgentId(e.detail.value)}
                placeholder="agent_..."
                onKeyDown={(e: { detail: { key: string } }) => {
                  if (e.detail.key === 'Enter') void lookup();
                }}
              />
            </FormField>
            <Button
              variant="primary"
              onClick={() => void lookup()}
              disabled={!agentId.trim() || loading}
            >
              Lookup reputation
            </Button>
          </SpaceBetween>
        </Container>

        {error !== null && (
          <Alert type="error" header="Lookup failed">
            {error}
          </Alert>
        )}

        {loading && <Spinner size="large" />}

        {profile !== null && !loading && (
          <>
            <Container
              header={
                <Header
                  variant="h2"
                  actions={
                    <Button onClick={copyBadgeUrl} iconName={copied ? 'status-positive' : 'copy'}>
                      {copied ? 'Copied' : 'Copy badge URL'}
                    </Button>
                  }
                >
                  Profile
                </Header>
              }
            >
              <ColumnLayout columns={2} variant="text-grid">
                <div>
                  <Box variant="awsui-key-label">Badge</Box>
                  <Box padding={{ top: 'xs' }} fontSize="heading-l">
                    <StatusIndicator type={badgeStatusType(profile.badge)}>
                      {badgeLabel(profile.badge)}
                    </StatusIndicator>
                  </Box>
                </div>
                <div>
                  <Box variant="awsui-key-label">Score</Box>
                  <Box variant="h1" color={scoreColor(profile.badge)}>
                    {profile.score}
                  </Box>
                </div>
              </ColumnLayout>
            </Container>

            <Container header={<Header variant="h2">Metrics</Header>}>
              <KeyValuePairs
                columns={3}
                items={[
                  {
                    label: 'Total decisions',
                    value: formatNumber(profile.totalDecisions),
                  },
                  {
                    label: 'Total actions',
                    value: formatNumber(profile.totalActions),
                  },
                  {
                    label: 'Denial rate',
                    value: `${(profile.denialRate * 100).toFixed(1)}%`,
                  },
                  {
                    label: 'Spend',
                    value: formatUsd(profile.spendUsdMinor / 100),
                  },
                  {
                    label: 'Incidents',
                    value: formatNumber(profile.incidentCount),
                  },
                  {
                    label: 'Verified since',
                    value:
                      profile.verifiedSince !== null ? formatDateTime(profile.verifiedSince) : '—',
                  },
                ]}
              />
            </Container>

            <Table<ReputationFactor>
              variant="container"
              header={<Header variant="h2">Factors</Header>}
              items={[...profile.factors]}
              trackBy={(f) => f.name}
              empty={
                <Box textAlign="center" color="inherit">
                  No contributing factors recorded.
                </Box>
              }
              columnDefinitions={[
                {
                  id: 'name',
                  header: 'Name',
                  cell: (f) => f.name,
                },
                {
                  id: 'impact',
                  header: 'Impact',
                  cell: (f) => (
                    <Box
                      color={
                        f.impact > 0
                          ? 'text-status-success'
                          : f.impact < 0
                            ? 'text-status-error'
                            : 'text-body-secondary'
                      }
                    >
                      {f.impact > 0 ? `+${f.impact}` : `${f.impact}`}
                    </Box>
                  ),
                },
                {
                  id: 'reason',
                  header: 'Reason',
                  cell: (f) => f.reason,
                },
              ]}
            />
          </>
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}
