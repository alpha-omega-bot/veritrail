import { useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Textarea from '@cloudscape-design/components/textarea';

import {
  AiBackendUnavailableError,
  analyzeIncident,
  type RcaCausalContributor,
  type RcaRecommendation,
  type RcaReport,
} from '../api.ts';
import { useAuth } from '../auth/AuthContext.tsx';

function confidenceStatus(confidence: number): {
  type: 'success' | 'info' | 'warning' | 'error';
  label: string;
} {
  if (confidence >= 0.7)
    return { type: 'success', label: `High confidence (${confidence.toFixed(2)})` };
  if (confidence >= 0.4)
    return { type: 'warning', label: `Medium confidence (${confidence.toFixed(2)})` };
  return { type: 'error', label: `Low confidence (${confidence.toFixed(2)})` };
}

export function IncidentRcaView() {
  const { session } = useAuth();

  const [correlationId, setCorrelationId] = useState('');
  const [operatorContext, setOperatorContext] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [report, setReport] = useState<RcaReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aiUnavailable, setAiUnavailable] = useState(false);

  const analyze = async () => {
    if (!correlationId.trim()) return;
    setAnalyzing(true);
    setError(null);
    setAiUnavailable(false);
    setReport(null);
    try {
      const result = await analyzeIncident(
        correlationId.trim(),
        operatorContext.trim() || undefined,
      );
      setReport(result.report);
    } catch (e) {
      if (e instanceof AiBackendUnavailableError) {
        setAiUnavailable(true);
      } else {
        setError(e instanceof Error ? e.message : 'Failed to analyze incident');
      }
    } finally {
      setAnalyzing(false);
    }
  };

  const sendToSimulator = () => {
    if (!report?.proposedFix) return;
    localStorage.setItem('veritrail.simulator.draft', JSON.stringify(report.proposedFix));
    window.location.hash = '#/simulator';
  };

  if (!session) {
    return (
      <ContentLayout header={<Header variant="h1">Incident RCA</Header>}>
        <Alert type="info" header="Sign in to use this feature">
          AI-assisted incident root cause analysis is available to signed-in users.
        </Alert>
      </ContentLayout>
    );
  }

  const status = report ? confidenceStatus(report.confidence) : null;

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="AI-assisted root cause analysis for incidents. Provide a correlation ID and optional operator context."
        >
          Incident RCA
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Container header={<Header variant="h2">Analyze incident</Header>}>
          <SpaceBetween size="m">
            <FormField label="Correlation ID" description="The incident correlation ID to analyze.">
              <Input
                value={correlationId}
                onChange={(e: { detail: { value: string } }) => setCorrelationId(e.detail.value)}
                placeholder="incident-12345"
                disabled={analyzing}
              />
            </FormField>
            <FormField
              label="Operator context (optional)"
              description="Add any extra context the AI should consider."
            >
              <Textarea
                value={operatorContext}
                onChange={(e: { detail: { value: string } }) => setOperatorContext(e.detail.value)}
                placeholder="The incident occurred after a deploy to the auth service..."
                rows={4}
                disabled={analyzing}
              />
            </FormField>
            <Box>
              <Button
                variant="primary"
                onClick={() => void analyze()}
                loading={analyzing}
                disabled={!correlationId.trim()}
              >
                Analyze with AI
              </Button>
            </Box>
          </SpaceBetween>
        </Container>

        {aiUnavailable && (
          <Alert type="warning" header="AI backend unavailable">
            AI backend not configured. Set ANTHROPIC_API_KEY on the server.
          </Alert>
        )}

        {error && (
          <Alert type="error" header="Analysis failed">
            {error}
          </Alert>
        )}

        {analyzing && (
          <Box textAlign="center">
            <Spinner size="large" />
          </Box>
        )}

        {report && status && (
          <SpaceBetween size="l">
            <Header variant="h2">{report.headline}</Header>
            <Box>{report.summary}</Box>
            <Box>
              <StatusIndicator type={status.type}>{status.label}</StatusIndicator>
            </Box>

            <Table<RcaCausalContributor & { __idx: number }>
              variant="container"
              header={<Header variant="h2">Causal contributors</Header>}
              items={report.causalContributors.map((c, idx) => ({ ...c, __idx: idx }))}
              trackBy={(c) => String(c.__idx)}
              empty={
                <Box textAlign="center" color="inherit">
                  No causal contributors identified.
                </Box>
              }
              columnDefinitions={[
                {
                  id: 'description',
                  header: 'Description',
                  cell: (c) => c.description,
                },
                {
                  id: 'weight',
                  header: 'Weight',
                  cell: (c) =>
                    typeof c.weight === 'number' ? (
                      c.weight.toFixed(2)
                    ) : (
                      <Box color="text-body-secondary">—</Box>
                    ),
                },
                {
                  id: 'evidence',
                  header: 'Evidence',
                  cell: (c) =>
                    c.evidenceRef ? (
                      <Box variant="code">{c.evidenceRef}</Box>
                    ) : (
                      <Box color="text-body-secondary">—</Box>
                    ),
                },
              ]}
            />

            {report.proposedFix !== undefined && report.proposedFix !== null && (
              <Container
                header={
                  <Header
                    variant="h2"
                    actions={
                      <Button variant="primary" onClick={sendToSimulator}>
                        Test in simulator
                      </Button>
                    }
                  >
                    Proposed policy fix
                  </Header>
                }
              >
                <Box variant="code" padding="s">
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                    {JSON.stringify(report.proposedFix, null, 2)}
                  </pre>
                </Box>
              </Container>
            )}

            <Table<RcaRecommendation & { __idx: number }>
              variant="container"
              header={<Header variant="h2">Recommendations</Header>}
              items={report.recommendations.map((r, idx) => ({ ...r, __idx: idx }))}
              trackBy={(r) => String(r.__idx)}
              empty={
                <Box textAlign="center" color="inherit">
                  No recommendations.
                </Box>
              }
              columnDefinitions={[
                {
                  id: 'title',
                  header: 'Title',
                  cell: (r) => r.title,
                },
                {
                  id: 'detail',
                  header: 'Detail',
                  cell: (r) => r.detail ?? <Box color="text-body-secondary">—</Box>,
                },
                {
                  id: 'priority',
                  header: 'Priority',
                  cell: (r) => r.priority ?? <Box color="text-body-secondary">—</Box>,
                },
              ]}
            />
          </SpaceBetween>
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}
