import { useEffect, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import Table from '@cloudscape-design/components/table';
import Textarea from '@cloudscape-design/components/textarea';

import { runSimulation, type SimulationDeniedSample, type SimulationResult } from '../api.ts';
import { useAuth } from '../auth/AuthContext.tsx';

const DRAFT_STORAGE_KEY = 'veritrail.simulator.draft';

const SAMPLE_POLICY_ARRAY = JSON.stringify(
  [
    {
      id: 'allow-everything',
      description: 'Sample policy that allows all actions. Replace with your proposed policy.',
      match: { actorId: '*', action: { type: '*' } },
      effect: 'allow',
    },
  ],
  null,
  2,
);

export function SimulatorView() {
  const { session } = useAuth();

  const [policyJson, setPolicyJson] = useState<string>(SAMPLE_POLICY_ARRAY);
  const [running, setRunning] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<SimulationResult | null>(null);

  // On mount, hydrate from a draft saved by another view (e.g. RCA deep-link).
  useEffect(() => {
    try {
      const draft = localStorage.getItem(DRAFT_STORAGE_KEY);
      if (draft) setPolicyJson(draft);
    } catch {
      // localStorage may be unavailable (private mode, etc.); ignore.
    }
  }, []);

  if (!session) {
    return (
      <ContentLayout header={<Header variant="h1">Policy Simulator</Header>}>
        <Alert type="info" header="Sign in to use this feature">
          Replaying proposed policies against the live ledger requires a signed-in session.
        </Alert>
      </ContentLayout>
    );
  }

  const run = async () => {
    setParseError(null);
    setRunError(null);

    let parsed: unknown;
    try {
      parsed = JSON.parse(policyJson);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : 'Invalid JSON');
      return;
    }
    if (!Array.isArray(parsed)) {
      setParseError('Proposed policies must be a JSON array.');
      return;
    }

    setRunning(true);
    try {
      const res = await runSimulation(parsed);
      setResult(res);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : 'Simulation failed');
    } finally {
      setRunning(false);
    }
  };

  const changeRatePct = result ? (result.metrics.changeRate * 100).toFixed(2) + '%' : '—';

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Replay recent events against a proposed policy array to see what would change."
        >
          Policy Simulator
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Container header={<Header variant="h2">Proposed policy array</Header>}>
          <SpaceBetween size="m">
            <FormField
              label="Policies (JSON array)"
              description="Paste an array of policy objects. The simulator replays the ledger window through them."
            >
              <Textarea
                value={policyJson}
                onChange={(e: { detail: { value: string } }) => setPolicyJson(e.detail.value)}
                rows={14}
                spellcheck={false}
              />
            </FormField>
            {parseError && (
              <Alert type="error" header="Could not parse JSON">
                {parseError}
              </Alert>
            )}
            {runError && (
              <Alert type="error" header="Simulation failed">
                {runError}
              </Alert>
            )}
            <Box>
              <Button variant="primary" onClick={() => void run()} loading={running}>
                Run simulation
              </Button>
            </Box>
          </SpaceBetween>
        </Container>

        {running && (
          <Box textAlign="center">
            <Spinner size="large" />
          </Box>
        )}

        {result && !running && (
          <>
            <Container header={<Header variant="h2">Impact summary</Header>}>
              <ColumnLayout columns={5} variant="text-grid">
                <div>
                  <Box variant="awsui-key-label">Events replayed</Box>
                  <Box variant="awsui-value-large">{result.metrics.eventsReplayed}</Box>
                </div>
                <div>
                  <Box variant="awsui-key-label">Events changed</Box>
                  <Box variant="awsui-value-large">{result.metrics.eventsChanged}</Box>
                </div>
                <div>
                  <Box variant="awsui-key-label">Affected actors</Box>
                  <Box variant="awsui-value-large">{result.metrics.affectedActorCount}</Box>
                </div>
                <div>
                  <Box variant="awsui-key-label">Affected action types</Box>
                  <Box variant="awsui-value-large">{result.metrics.affectedActionTypeCount}</Box>
                </div>
                <div>
                  <Box variant="awsui-key-label">Change rate</Box>
                  <Box variant="awsui-value-large">{changeRatePct}</Box>
                </div>
              </ColumnLayout>
            </Container>

            <Table<SimulationDeniedSample & { _idx: number }>
              header={
                <Header
                  variant="h2"
                  counter={`(${result.newlyDeniedSamples.length})`}
                  description="Events that were previously allowed but would be denied under the proposed policies."
                >
                  Newly denied samples
                </Header>
              }
              variant="container"
              items={result.newlyDeniedSamples.map((s, idx) => ({ ...s, _idx: idx }))}
              trackBy={(s) => `${s.actorId}:${s.action.type}:${s._idx}`}
              empty={
                <Box textAlign="center" color="inherit">
                  No events would be newly denied.
                </Box>
              }
              columnDefinitions={[
                {
                  id: 'actorId',
                  header: 'Actor',
                  cell: (s) => <Box variant="code">{s.actorId}</Box>,
                },
                {
                  id: 'actionType',
                  header: 'Action type',
                  cell: (s) => <Box variant="code">{s.action.type}</Box>,
                },
                {
                  id: 'originalEffect',
                  header: 'Original effect',
                  cell: (s) => s.originalEffect,
                },
                {
                  id: 'proposedEffect',
                  header: 'Proposed effect',
                  cell: (s) => <Box color="text-status-error">{s.proposedEffect}</Box>,
                },
              ]}
            />

            <Container
              header={
                <Header
                  variant="h2"
                  description="Full diff payload for power users — useful for piping into other tooling."
                >
                  Raw diff
                </Header>
              }
            >
              <Box variant="code" padding="s">
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {JSON.stringify(result.diff, null, 2)}
                </pre>
              </Box>
            </Container>
          </>
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}
