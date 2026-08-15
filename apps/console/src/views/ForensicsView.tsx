import { getIncident, useAsync } from '../api.ts';
import { CredentialPanel, ErrorAlert, Loading, Metric } from '../components.tsx';
import { EMPTY, formatCount, formatDateTime, formatDuration } from '../format.ts';
import { useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import type { TimelineEntry } from '../types.ts';

export function ForensicsView() {
  // Draft is what the operator is typing; `submitted` is what we actually query,
  // so each keystroke does not fire a request.
  const [draft, setDraft] = useState('');
  const [submitted, setSubmitted] = useState('');

  const { data, loading, error, reload } = useAsync(
    () => (submitted.length > 0 ? getIncident(submitted) : Promise.resolve(null)),
    [submitted],
  );

  const needsCredentials =
    error !== null && (error.kind === 'unauthorized' || error.kind === 'forbidden');

  const submit = () => setSubmitted(draft.trim());

  const span =
    data !== null && data.firstAt !== null && data.lastAt !== null
      ? formatDuration(data.lastAt - data.firstAt)
      : EMPTY;

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Reconstruct an incident timeline and causal chain from a correlation id."
        >
          Forensics
        </Header>
      }
    >
      <SpaceBetween size="l">
        {needsCredentials && <CredentialPanel onChange={reload} />}

        <Container>
          <Form
            actions={
              <Button variant="primary" disabled={draft.trim().length === 0} onClick={submit}>
                Reconstruct
              </Button>
            }
          >
            <FormField
              label="Correlation id"
              description="The correlation id shared by the events you want to reconstruct. Copy one from the Ledger view."
            >
              <Input
                value={draft}
                placeholder="e.g. the correlationId on a ledger record"
                onChange={({ detail }: { detail: { value: string } }) => setDraft(detail.value)}
                onKeyDown={({ detail }: { detail: { key: string } }) => {
                  if (detail.key === 'Enter') submit();
                }}
                ariaLabel="Correlation id"
              />
            </FormField>
          </Form>
        </Container>

        {submitted.length === 0 && (
          <Alert type="info" header="Enter a correlation id">
            Provide a correlation id above to reconstruct its timeline. The server has no endpoint
            that enumerates correlation ids, so ids come from the Ledger view or your own alerting.
          </Alert>
        )}

        {submitted.length > 0 && loading && <Loading label="Reconstructing incident" />}
        {submitted.length > 0 && !loading && error !== null && (
          <ErrorAlert error={error} onRetry={reload} />
        )}

        {/* An unknown correlation id is a successful empty result, not an error. */}
        {!loading && error === null && data !== null && data.entries.length === 0 && (
          <Alert type="info" header="No events found">
            No ledger records carry the correlation id{' '}
            <Box variant="code">{data.correlationId}</Box>.
          </Alert>
        )}

        {!loading && error === null && data !== null && data.entries.length > 0 && (
          <>
            <Container
              header={
                <Header variant="h2" description={<Box variant="code">{data.correlationId}</Box>}>
                  Incident summary
                </Header>
              }
            >
              <SpaceBetween size="l">
                <ColumnLayout columns={4} variant="text-grid">
                  <Metric label="First event" value={formatDateTime(data.firstAt)} />
                  <Metric label="Last event" value={formatDateTime(data.lastAt)} />
                  <Metric label="Duration" value={span} />
                  <Metric
                    label="Timeline steps"
                    value={formatCount(data.entries.length)}
                    hint={`${formatCount(data.actors.length)} actors involved`}
                  />
                </ColumnLayout>
                <ColumnLayout columns={4} variant="text-grid">
                  <Metric label="Failures" value={formatCount(data.failures)} />
                  <Metric label="Denials" value={formatCount(data.denials)} />
                  <Metric label="Rollbacks" value={formatCount(data.rollbacks)} />
                  <Metric
                    label="Actors"
                    value={data.actors.length > 0 ? data.actors.join(', ') : EMPTY}
                  />
                </ColumnLayout>
              </SpaceBetween>
            </Container>

            <Container header={<Header variant="h2">Event breakdown</Header>}>
              {Object.keys(data.counts).length === 0 ? (
                <Box color="text-body-secondary">{EMPTY}</Box>
              ) : (
                <SpaceBetween direction="horizontal" size="l">
                  {Object.entries(data.counts)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([type, count]) => (
                      <Box key={type}>
                        <Box variant="awsui-key-label">{type}</Box>
                        <Box variant="h3">{formatCount(count)}</Box>
                      </Box>
                    ))}
                </SpaceBetween>
              )}
            </Container>

            <Table<TimelineEntry>
              variant="container"
              header={<Header variant="h2">Timeline</Header>}
              stickyHeader
              resizableColumns
              items={data.entries}
              trackBy={(entry) => String(entry.seq)}
              columnDefinitions={[
                { id: 'seq', header: '#', cell: (e) => e.seq, width: 90 },
                { id: 'at', header: 'Recorded', cell: (e) => formatDateTime(e.at) },
                {
                  id: 'type',
                  header: 'Type',
                  cell: (e) => <Box variant="code">{e.type}</Box>,
                },
                { id: 'actorId', header: 'Actor', cell: (e) => e.actorId },
                { id: 'summary', header: 'Summary', cell: (e) => e.summary },
              ]}
              empty={
                <Box textAlign="center" color="inherit">
                  {EMPTY}
                </Box>
              }
            />
          </>
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}
