import { getLedgerRecords, useAsync } from '../api.ts';
import { EMPTY, formatCount, formatDateTime, formatLabels, shortHash } from '../format.ts';
import { CredentialPanel, ErrorAlert, Loading } from '../components.tsx';
import { useMemo, useState } from 'react';
import type { LedgerRecord } from '../types.ts';
import Box from '@cloudscape-design/components/box';
import ContentLayout from '@cloudscape-design/components/content-layout';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Header from '@cloudscape-design/components/header';
import Select from '@cloudscape-design/components/select';
import type { SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';

const ALL = '__all__';
const PAGE_SIZE = 100;

/**
 * A one-line gist of an event payload for the table's summary column. The full
 * payload is always available in the expandable row detail, so this only needs to
 * surface the most identifying field per event type.
 */
function payloadGist(record: LedgerRecord): string {
  const { type, payload } = record.event;
  const read = (key: string): string | null => {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number') return String(value);
    return null;
  };

  switch (type) {
    case 'action.authorized':
    case 'action.executed':
    case 'action.failed':
    case 'action.denied':
    case 'action.rolled_back':
      return [read('actionId'), read('reason') ?? read('error') ?? read('outcome')]
        .filter((part): part is string => part !== null)
        .join(' · ');
    case 'policy.evaluated':
      return [read('effect'), read('actionId'), read('reason')]
        .filter((part): part is string => part !== null)
        .join(' · ');
    case 'budget.charged':
    case 'budget.exceeded':
      return read('budgetId') ?? read('scope') ?? EMPTY;
    case 'admin.action':
      return [read('action'), read('targetType'), read('outcome')]
        .filter((part): part is string => part !== null)
        .join(' · ');
    case 'note':
      return read('text') ?? EMPTY;
    default:
      return EMPTY;
  }
}

export function LedgerView() {
  const { data, loading, error, reload } = useAsync(() => getLedgerRecords(PAGE_SIZE), []);
  const [typeFilter, setTypeFilter] = useState<SelectProps.Option>({
    value: ALL,
    label: 'All types',
  });

  const typeOptions = useMemo<SelectProps.Option[]>(() => {
    const types = data === null ? [] : Array.from(new Set(data.map((r) => r.event.type))).sort();
    return [{ value: ALL, label: 'All types' }, ...types.map((t) => ({ value: t, label: t }))];
  }, [data]);

  const visible = useMemo(() => {
    if (data === null) return [];
    return typeFilter.value === ALL ? data : data.filter((r) => r.event.type === typeFilter.value);
  }, [data, typeFilter]);

  const needsCredentials =
    error !== null && (error.kind === 'unauthorized' || error.kind === 'forbidden');

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          {...(data !== null
            ? { counter: `(${formatCount(visible.length)} of ${formatCount(data.length)} loaded)` }
            : {})}
          description={`Append-only, hash-chained audit records. Showing the most recent ${PAGE_SIZE} entries.`}
        >
          Ledger
        </Header>
      }
    >
      <SpaceBetween size="l">
        {needsCredentials && <CredentialPanel onChange={reload} />}
        {loading && <Loading label="Loading ledger records" />}
        {!loading && error !== null && <ErrorAlert error={error} onRetry={reload} />}
        {!loading && error === null && data !== null && (
          <Table<LedgerRecord>
            variant="container"
            stickyHeader
            resizableColumns
            items={visible}
            trackBy={(r) => String(r.seq)}
            empty={
              <Box textAlign="center" color="inherit" padding={{ vertical: 'm' }}>
                {data.length === 0
                  ? 'The ledger has no records yet.'
                  : 'No records match this filter.'}
              </Box>
            }
            filter={
              <Select
                selectedOption={typeFilter}
                onChange={({ detail }: { detail: SelectProps.ChangeDetail }) =>
                  setTypeFilter(detail.selectedOption)
                }
                options={typeOptions}
                ariaLabel="Filter records by event type"
              />
            }
            columnDefinitions={[
              { id: 'seq', header: '#', cell: (r) => r.seq, width: 90 },
              { id: 'timestamp', header: 'Recorded', cell: (r) => formatDateTime(r.timestamp) },
              {
                id: 'type',
                header: 'Type',
                cell: (r) => <Box variant="code">{r.event.type}</Box>,
              },
              { id: 'actorId', header: 'Actor', cell: (r) => r.event.actorId },
              {
                id: 'correlationId',
                header: 'Correlation',
                cell: (r) =>
                  r.event.correlationId !== undefined ? (
                    <Box variant="code">{r.event.correlationId}</Box>
                  ) : (
                    EMPTY
                  ),
              },
              { id: 'gist', header: 'Summary', cell: (r) => payloadGist(r) },
              {
                id: 'hash',
                header: 'Hash',
                cell: (r) => (
                  <Box variant="code">
                    <span title={`hash ${r.hash}\nprev ${r.prevHash}`}>{shortHash(r.hash)}</span>
                  </Box>
                ),
              },
              {
                id: 'signed',
                header: 'Signed',
                cell: (r) => (r.signature !== undefined ? 'Yes' : 'No'),
                width: 100,
              },
              {
                id: 'payload',
                header: 'Detail',
                cell: (r) => (
                  <ExpandableSection headerText="Payload" variant="footer">
                    <SpaceBetween size="xs">
                      <Box variant="small" color="text-body-secondary">
                        Labels: {formatLabels(r.event.labels)}
                      </Box>
                      <Box variant="code">
                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                          {JSON.stringify(r.event.payload, null, 2)}
                        </pre>
                      </Box>
                    </SpaceBetween>
                  </ExpandableSection>
                ),
              },
            ]}
          />
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}
