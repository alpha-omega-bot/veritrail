import { getLedgerEvents, useAsync } from '../api.ts';
import { formatDateTime, shortHash } from '../format.ts';
import { SeverityStatus } from '../status.tsx';
import { TableSkeleton } from '../LoadingSkeleton.tsx';
import { useEventStream } from '../useEventStream.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { useEffect, useMemo, useState } from 'react';
import type { LedgerEvent } from '../types.ts';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Select from '@cloudscape-design/components/select';
import type { SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';

const ALL = '__all__';

export function LedgerView() {
  const { session } = useAuth();
  const { data, loading, error, fromMock } = useAsync(() => getLedgerEvents(50), []);
  const [typeFilter, setTypeFilter] = useState<SelectProps.Option>({
    value: ALL,
    label: 'All types',
  });

  const stream = useEventStream<LedgerEvent>({
    path: '/audit/events/stream',
    max: 200,
    enabled: session !== null,
  });

  // Merge polled snapshot + streamed deltas. The polled list is the truth at
  // load time; streamed events with seq > max(polled.seq) get prepended.
  const merged = useMemo(() => {
    const base = data?.events ?? [];
    if (stream.events.length === 0) return base;
    const baseMax = base.reduce<number>((m, e) => Math.max(m, e.seq ?? 0), 0);
    const fresh = stream.events.filter((e) => (e.seq ?? 0) > baseMax);
    return [...fresh.slice().reverse(), ...base];
  }, [data, stream.events]);

  const typeOptions = useMemo<SelectProps.Option[]>(() => {
    const types = Array.from(new Set(merged.map((e) => e.type))).sort();
    return [{ value: ALL, label: 'All types' }, ...types.map((t) => ({ value: t, label: t }))];
  }, [merged]);

  const visible = useMemo(
    () => (typeFilter.value === ALL ? merged : merged.filter((e) => e.type === typeFilter.value)),
    [merged, typeFilter],
  );

  // Pulse a "Live" badge when new events arrive.
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    if (stream.events.length === 0) return;
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 400);
    return () => clearTimeout(t);
  }, [stream.events.length]);

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          counter={data ? `(${visible.length}/${data.total.toLocaleString('en-US')})` : undefined}
          description="Append-only, hash-chained audit events."
          info={
            stream.status === 'open' ? (
              <Badge color={pulse ? 'green' : 'blue'}>Live</Badge>
            ) : stream.status === 'connecting' || stream.status === 'reconnecting' ? (
              <Badge color="grey">Connecting…</Badge>
            ) : null
          }
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
        {loading && <TableSkeleton rows={7} />}
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
              <Box textAlign="center" color="inherit" padding={{ vertical: 'xs' }}>
                <SpaceBetween size="s">
                  <Box variant="strong" fontSize="heading-m">
                    No events match this filter
                  </Box>
                  <Box variant="p" color="text-body-secondary">
                    Try selecting a different event type from the filter above.
                  </Box>
                </SpaceBetween>
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
