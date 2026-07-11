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

import { createApiKey } from '../api.ts';
import { useAuth } from '../auth/AuthContext.tsx';

/**
 * Three-step welcome wizard for first-time users:
 *
 *   1. Confirm the org name (pre-filled).
 *   2. Confirm the project name (pre-filled).
 *   3. Mint a first API key + show the curl example to ingest a first event.
 *
 * The org and project are created server-side as part of magic-link consumption
 * for fresh signups; this UI is purely the post-signup demo. If those don't
 * exist (returning user), we redirect straight to the overview.
 */
export function OnboardingView() {
  const { session } = useAuth();
  const [step, setStep] = useState(1);
  const [keyResult, setKeyResult] = useState<{ key: string; curl: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!session) {
    return (
      <ContentLayout header={<Header variant="h1">Welcome</Header>}>
        <Alert type="info" header="Sign in to start onboarding">
          Please sign in to set up your first project.
        </Alert>
      </ContentLayout>
    );
  }

  const projectId = session.currentProjectId;
  const orgName = session.orgs.find((o) => o.id === session.currentOrgId)?.name ?? 'Your team';

  const mintKey = async () => {
    if (!projectId) return;
    setCreating(true);
    setError(null);
    try {
      const result = await createApiKey(projectId, 'first key');
      const curl = `curl -X POST https://api.veritrail.io/api/events \\
  -H 'authorization: Bearer ${result.key}' \\
  -H 'content-type: application/json' \\
  -d '{
    "type": "note",
    "actorId": "agent-1",
    "payload": { "text": "hello from my first agent" }
  }'`;
      setKeyResult({ key: result.key, curl });
      setStep(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to mint key');
    } finally {
      setCreating(false);
    }
  };

  return (
    <ContentLayout
      header={
        <Header variant="h1" description={`Step ${step} of 3`}>
          Welcome to Veritrail
        </Header>
      }
    >
      <SpaceBetween size="l">
        {error && (
          <Alert type="error" header="Onboarding failed">
            {error}
          </Alert>
        )}

        {step === 1 && (
          <Container header={<Header variant="h2">1. Your workspace</Header>}>
            <SpaceBetween size="m">
              <FormField
                label="Organization"
                description="We created one for you. Rename later in Settings."
              >
                <Input value={orgName} disabled />
              </FormField>
              <Box>
                <Button variant="primary" onClick={() => setStep(2)}>
                  Continue
                </Button>
              </Box>
            </SpaceBetween>
          </Container>
        )}

        {step === 2 && (
          <Container header={<Header variant="h2">2. Your first project</Header>}>
            <SpaceBetween size="m">
              <Box>
                Every Veritrail project gets a dedicated tamper-evident ledger and tenant-scoped API
                keys. We&rsquo;ve created your first project — let&rsquo;s mint an API key for it.
              </Box>
              <Box>
                <Button variant="primary" onClick={() => void mintKey()} loading={creating}>
                  Mint API key
                </Button>
              </Box>
            </SpaceBetween>
          </Container>
        )}

        {step === 3 && keyResult && (
          <>
            <Container header={<Header variant="h2">3. Try your first event</Header>}>
              <SpaceBetween size="m">
                <Alert type="warning" header="Save this key now — you won't see it again">
                  <Box variant="code">{keyResult.key}</Box>
                </Alert>
                <Box>Run this from a terminal to send your first event:</Box>
                <Box variant="code" padding="s">
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{keyResult.curl}</pre>
                </Box>
                <Box>
                  When the request succeeds, head to the <a href="#/ledger">Ledger</a> to see it
                  appear (real-time).
                </Box>
              </SpaceBetween>
            </Container>
            <Box>
              <Button variant="primary" onClick={() => (window.location.hash = '#/overview')}>
                Go to overview
              </Button>
            </Box>
          </>
        )}

        {step === 2 && creating && (
          <Box textAlign="center">
            <Spinner />
          </Box>
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}
