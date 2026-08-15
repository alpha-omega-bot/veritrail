import { getVendorRisk, useAsync } from '../api.ts';
import { CredentialPanel, ErrorAlert, Loading } from '../components.tsx';
import { EMPTY, formatCount, formatDateTime } from '../format.ts';
import { RiskBandStatus, SignalSeverityStatus } from '../status.tsx';
import type { VendorRiskScore } from '../types.ts';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import ContentLayout from '@cloudscape-design/components/content-layout';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';

export function VendorRiskView() {
  const { data, loading, error, reload } = useAsync(getVendorRisk, []);
  const needsCredentials =
    error !== null && (error.kind === 'unauthorized' || error.kind === 'forbidden');

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          {...(data !== null ? { counter: `(${formatCount(data.length)})` } : {})}
          description="Third parties ranked by time-decayed composite risk score, highest first."
        >
          Vendor Risk
        </Header>
      }
    >
      <SpaceBetween size="l">
        {needsCredentials && <CredentialPanel onChange={reload} />}
        {loading && <Loading label="Loading vendor assessments" />}
        {!loading && error !== null && <ErrorAlert error={error} onRetry={reload} />}
        {!loading && error === null && data !== null && (
          <>
            {data.length === 0 && (
              <Alert type="info" header="No vendors registered">
                No third parties have been registered in the ledger yet.
              </Alert>
            )}
            {data.length > 0 && (
              <Table<VendorRiskScore>
                variant="container"
                stickyHeader
                resizableColumns
                /* The server returns these already sorted by score descending. */
                items={data}
                trackBy={(v) => v.vendorId}
                columnDefinitions={[
                  {
                    id: 'rank',
                    header: '#',
                    cell: (v) => data.indexOf(v) + 1,
                    width: 70,
                  },
                  { id: 'name', header: 'Vendor', cell: (v) => v.name },
                  {
                    id: 'score',
                    header: 'Score',
                    /* Unbounded, not a percentage — never render as score/100. */
                    cell: (v) => <Box fontWeight="bold">{formatCount(v.score)}</Box>,
                    width: 100,
                  },
                  {
                    id: 'band',
                    header: 'Band',
                    cell: (v) => <RiskBandStatus band={v.band} />,
                    width: 130,
                  },
                  {
                    id: 'signalCount',
                    header: 'Signals',
                    cell: (v) => formatCount(v.signalCount),
                    width: 100,
                  },
                  {
                    id: 'topSignals',
                    header: 'Most severe signals',
                    cell: (v) =>
                      v.topSignals.length === 0 ? (
                        EMPTY
                      ) : (
                        <ExpandableSection
                          headerText={`${formatCount(v.topSignals.length)} shown`}
                          variant="footer"
                        >
                          <SpaceBetween size="s">
                            {v.topSignals.map((signal) => (
                              <div key={signal.id}>
                                <SpaceBetween direction="horizontal" size="xs">
                                  <SignalSeverityStatus severity={signal.severity} />
                                  <Box variant="code">{signal.kind}</Box>
                                </SpaceBetween>
                                <Box padding={{ top: 'xxs' }}>{signal.summary}</Box>
                                <Box variant="small" color="text-body-secondary">
                                  {formatDateTime(signal.observedAt)}
                                  {signal.source.length > 0 && ` · source: ${signal.source}`}
                                </Box>
                              </div>
                            ))}
                          </SpaceBetween>
                        </ExpandableSection>
                      ),
                  },
                ]}
              />
            )}
          </>
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}
