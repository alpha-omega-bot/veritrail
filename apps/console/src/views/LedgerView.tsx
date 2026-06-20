import { getLedgerEvents, useAsync } from '../api.ts';
import { formatDateTime, shortHash } from '../format.ts';
import { SeverityStatus } from '../status.tsx';
import { useMemo, useState } from 'react';
import type { LedgerEvent } from '../types.ts';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Select from '@cloudscape-design/components/select';
import type { SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import Table from '@cloudscape-design/components/table';

const ALL = '__all__';

export function LedgerView() {
  const { data, loading, error, fromMock } = useAsync(() => getLedgerEvents(50), []);
  const [typeFilter, setTypeFilter] = useState<SelectProps.Option>({
    value: ALL,
    label: 'All types',
  });

  const typeOptions = useMemo<SelectProps.Option[]>(() => {
    const types = data === null ? [] : Array.from(new Set(data.events.map((e) => e.type))).sort();
    return [{ value: ALL, label: 'All types' }, ...types.map((t) => ({ value: t, label: t }))];
  }, [data]);

  const visible = useMemo(() => {
    if (data === null) return [];
    return typeFilter.value === ALL
      ? data.events
      : data.events.filter((e) => e.type === typeFilter.value);
  }, [data, typeFilter]);

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          counter={data ? `(${visible.length}/${data.total.toLocaleString('en-US')})` : undefined}
          description="Append-only, hash-chained audit events."
        >
          Ledger
        </Header>
      }
    >
      <SpaceBetween size="l">
        {fromMock && (
          <Alert type="info" header="Showing sample data">
            The console could not reach the Veritrail API, so it is displaying sample data.
          </Alert>
        )}
        {loading && <Spinner size="large" />}
        {!loading && error !== null && (
          <Alert type="error" header="Failed to load ledger">
            {error}
          </Alert>
        )}
        {!loading && error === null && data !== null && (
          <Table<LedgerEvent>
            variant="container"
            stickyHeader
            resizableColumns
            items={visible}
            trackBy={(e) => String(e.seq)}
            empty={
              <Box textAlign="center" color="inherit">
                No events match this filter.
              </Box>
            }
            filter={
              <Select
                selectedOption={typeFilter}
                onChange={({ detail }: { detail: SelectProps.ChangeDetail }) =>
                  setTypeFilter(detail.selectedOption)
                }
                options={typeOptions}
                ariaLabel="Filter events by type"
              />
            }
            columnDefinitions={[
              {
                id: 'seq',
                header: '#',
                cell: (e) => e.seq,
                width: 80,
              },
              { id: 'timestamp', header: 'Time', cell: (e) => formatDateTime(e.timestamp) },
              {
                id: 'type',
                header: 'Type',
                cell: (e) => <Box variant="code">{e.type}</Box>,
              },
              { id: 'agentId', header: 'Agent', cell: (e) => e.agentId },
              {
                id: 'severity',
                header: 'Severity',
                cell: (e) => <SeverityStatus severity={e.severity} />,
              },
              {
                id: 'correlationId',
                header: 'Correlation',
                cell: (e) => <Box variant="code">{e.correlationId}</Box>,
              },
              {
                id: 'hash',
                header: 'Hash',
                cell: (e) => (
                  <Box variant="code">
                    <span title={e.hash}>{shortHash(e.hash)}</span>
                  </Box>
                ),
              },
              { id: 'detail', header: 'Detail', cell: (e) => e.detail },
            ]}
          />
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}
