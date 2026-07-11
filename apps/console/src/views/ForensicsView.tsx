import { formatDateTime } from '../format.ts';
import { getIncident, useAsync } from '../api.ts';
import { mockCorrelationIds } from '../mocks.ts';
import { SeverityStatus } from '../status.tsx';
import { MetricSkeleton } from '../LoadingSkeleton.tsx';
import { useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Select from '@cloudscape-design/components/select';
import type { SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';

const CORRELATION_OPTIONS: SelectProps.Option[] = mockCorrelationIds.map((id) => ({
  value: id,
  label: id,
}));

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <Box variant="awsui-key-label">{label}</Box>
      <Box variant="h2" padding={{ top: 'xxs' }}>
        {value}
      </Box>
    </div>
  );
}

export function ForensicsView() {
  const [selected, setSelected] = useState<SelectProps.Option>(
    CORRELATION_OPTIONS[0] ?? { value: '', label: '' },
  );
  const correlationId = String(selected.value);
  const { data, loading, error, fromMock } = useAsync(
    () => getIncident(correlationId),
    [correlationId],
  );

  return (
    <ContentLayout
      header={
        <Header variant="h1" description="Reconstruct an incident timeline from a correlation id.">
          Forensics
        </Header>
      }
    >
      <SpaceBetween size="l">
        {fromMock && (
          <Alert type="info" header="Showing sample data">
            The console could not reach the Veritrail API, so it is displaying sample data.
          </Alert>
        )}

        <Container>
          <FormField label="Correlation id" description="Select an incident to view its timeline">
            <Select
              selectedOption={selected}
              onChange={({ detail }: { detail: SelectProps.ChangeDetail }) =>
                setSelected(detail.selectedOption)
              }
              options={CORRELATION_OPTIONS}
              ariaLabel="Select a correlation id"
            />
          </FormField>
        </Container>

        {loading && (
          <>
            <Container>
              <ColumnLayout columns={4} variant="text-grid">
                <MetricSkeleton />
                <MetricSkeleton />
                <MetricSkeleton />
                <MetricSkeleton />
              </ColumnLayout>
            </Container>
          </>
        )}
        {!loading && error !== null && (
          <Alert type="error" header="Failed to reconstruct incident">
            {error}
          </Alert>
        )}

        {!loading && error === null && data !== null && (
          <>
            <Container
              header={
                <Header
                  variant="h2"
                  actions={<SeverityStatus severity={data.peakSeverity} />}
                  description={<Box variant="code">{data.correlationId}</Box>}
                >
                  {data.title}
                </Header>
              }
            >
              <ColumnLayout columns={4} variant="text-grid">
                <Metric label="Opened" value={formatDateTime(data.openedAt)} />
                <Metric
                  label="Closed"
                  value={data.closedAt === null ? 'Open' : formatDateTime(data.closedAt)}
                />
                <Metric label="Timeline steps" value={data.timeline.length} />
                <Metric
                  label="Agents"
                  value={data.agents.length > 0 ? data.agents.join(', ') : '—'}
                />
              </ColumnLayout>
            </Container>

            <Container header={<Header variant="h2">Timeline</Header>}>
              {data.timeline.length === 0 ? (
                <Box color="text-body-secondary">No timeline entries for this correlation id.</Box>
              ) : (
                <SpaceBetween size="m">
                  {data.timeline.map((entry, i) => (
                    <div key={`${entry.timestamp}-${i}`}>
                      <SpaceBetween direction="horizontal" size="s">
                        <Box variant="code">{entry.type}</Box>
                        <SeverityStatus severity={entry.severity} />
                      </SpaceBetween>
                      <Box variant="small" color="text-body-secondary" padding={{ top: 'xxs' }}>
                        {formatDateTime(entry.timestamp)}
                      </Box>
                      <Box padding={{ top: 'xxs' }}>{entry.summary}</Box>
                    </div>
                  ))}
                </SpaceBetween>
              )}
            </Container>
          </>
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}
