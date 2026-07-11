import { useState } from 'react';
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
import Table from '@cloudscape-design/components/table';
import Tabs from '@cloudscape-design/components/tabs';

import { generateComplianceReport } from '../api.ts';
import type { ComplianceControlRow, ComplianceReport } from '../api.ts';
import { useAuth } from '../auth/AuthContext.tsx';

interface FrameworkChoice {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

const FRAMEWORKS: ReadonlyArray<FrameworkChoice> = [
  {
    id: 'soc2-cc7',
    name: 'SOC 2 CC7',
    description: 'System operations: detection, response, change management.',
  },
  {
    id: 'eu-ai-act-annex-iv',
    name: 'EU AI Act Annex IV',
    description: 'High-risk AI system technical documentation.',
  },
  {
    id: 'hipaa-security',
    name: 'HIPAA Security',
    description: 'Administrative, physical, and technical safeguards.',
  },
  {
    id: 'iso-42001',
    name: 'ISO 42001',
    description: 'AI management system requirements.',
  },
];

function severityColor(severity: string): 'text-status-error' | 'text-status-warning' | 'inherit' {
  if (severity === 'critical' || severity === 'high') return 'text-status-error';
  if (severity === 'medium') return 'text-status-warning';
  return 'inherit';
}

function statusLabel(status: string): {
  text: string;
  color: 'text-status-success' | 'text-status-error' | 'text-status-warning' | 'inherit';
} {
  if (status === 'pass') return { text: 'Pass', color: 'text-status-success' };
  if (status === 'fail') return { text: 'Fail', color: 'text-status-error' };
  if (status === 'partial') return { text: 'Partial', color: 'text-status-warning' };
  if (status === 'not_applicable') return { text: 'N/A', color: 'inherit' };
  return { text: status, color: 'inherit' };
}

export function ComplianceView() {
  const { session } = useAuth();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ComplianceReport | null>(null);
  const [activeFrameworkId, setActiveFrameworkId] = useState<string | null>(null);

  const runReport = async (frameworkId: string) => {
    setLoading(true);
    setError(null);
    setActiveFrameworkId(frameworkId);
    try {
      const result = await generateComplianceReport(frameworkId);
      setReport(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate report');
      setReport(null);
    } finally {
      setLoading(false);
    }
  };

  const downloadMarkdown = () => {
    if (!report) return;
    const blob = new Blob([report.markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${report.frameworkId}-${report.generatedAt}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (!session) {
    return (
      <ContentLayout header={<Header variant="h1">Compliance</Header>}>
        <Alert type="info" header="Sign in to use this feature">
          One-click compliance reports require an active session.
        </Alert>
      </ContentLayout>
    );
  }

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Generate a tamper-evident compliance report from your ledger evidence in one click."
        >
          Compliance
        </Header>
      }
    >
      <SpaceBetween size="l">
        {error && (
          <Alert type="error" header="Report generation failed">
            {error}
          </Alert>
        )}

        <Container header={<Header variant="h2">Choose a framework</Header>}>
          <ColumnLayout columns={4} variant="text-grid">
            {FRAMEWORKS.map((f) => (
              <div key={f.id}>
                <Box variant="awsui-key-label">{f.name}</Box>
                <Box color="text-body-secondary" padding={{ bottom: 's' }}>
                  {f.description}
                </Box>
                <Button
                  variant={activeFrameworkId === f.id ? 'primary' : 'normal'}
                  onClick={() => void runReport(f.id)}
                  loading={loading && activeFrameworkId === f.id}
                  disabled={loading}
                >
                  Generate
                </Button>
              </div>
            ))}
          </ColumnLayout>
        </Container>

        {loading && (
          <Box textAlign="center">
            <Spinner size="large" />
          </Box>
        )}

        {!loading && report && (
          <>
            <Container
              header={
                <Header
                  variant="h2"
                  description={`Version ${report.frameworkVersion} - generated ${new Date(report.generatedAt).toLocaleString()}`}
                >
                  {report.frameworkName} - {report.scorePercent}%
                </Header>
              }
            >
              <ProgressBar
                value={Math.max(0, Math.min(100, report.scorePercent))}
                status={
                  report.scorePercent >= 80
                    ? 'success'
                    : report.scorePercent >= 50
                      ? 'in-progress'
                      : 'error'
                }
                ariaLabel="Compliance score"
              />
            </Container>

            <Table<ComplianceControlRow>
              variant="container"
              header={<Header variant="h2">Controls</Header>}
              items={[...report.controls]}
              trackBy={(c) => c.id}
              empty={
                <Box textAlign="center" color="inherit">
                  No controls reported.
                </Box>
              }
              columnDefinitions={[
                {
                  id: 'id',
                  header: 'ID',
                  cell: (c) => <Box variant="code">{c.id}</Box>,
                },
                { id: 'name', header: 'Name', cell: (c) => c.name },
                {
                  id: 'severity',
                  header: 'Severity',
                  cell: (c) => <Box color={severityColor(c.severity)}>{c.severity}</Box>,
                },
                {
                  id: 'evidence',
                  header: 'Evidence count',
                  cell: (c) => c.evidenceCount,
                },
                {
                  id: 'status',
                  header: 'Status',
                  cell: (c) => {
                    const s = statusLabel(c.status);
                    return <Box color={s.color}>{s.text}</Box>;
                  },
                },
              ]}
            />

            <Tabs
              tabs={[
                {
                  label: 'Markdown report',
                  id: 'markdown',
                  content: (
                    <Box variant="code" padding="s">
                      <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{report.markdown}</pre>
                    </Box>
                  ),
                },
                {
                  label: 'Download',
                  id: 'download',
                  content: (
                    <SpaceBetween size="m">
                      <Box>
                        Download a self-contained Markdown copy of this report. Filename:{' '}
                        <Box variant="code" display="inline">
                          {`${report.frameworkId}-${report.generatedAt}.md`}
                        </Box>
                      </Box>
                      <Box>
                        <Button variant="primary" iconName="download" onClick={downloadMarkdown}>
                          Download .md
                        </Button>
                      </Box>
                    </SpaceBetween>
                  ),
                },
              ]}
            />
          </>
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}
