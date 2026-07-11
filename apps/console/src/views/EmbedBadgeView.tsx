import { useMemo, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';

import { useAuth } from '../auth/AuthContext.tsx';

interface SnippetProps {
  readonly label: string;
  readonly description: string;
  readonly code: string;
}

function Snippet({ label, description, code }: SnippetProps) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (e.g. insecure context) - fall through silently.
    }
  };

  return (
    <FormField label={label} description={description}>
      <SpaceBetween size="xs">
        <Box variant="code" padding="s">
          {code}
        </Box>
        <Box>
          <SpaceBetween direction="horizontal" size="xs" alignItems="center">
            <Button iconName="copy" onClick={() => void copy()}>
              Copy
            </Button>
            {copied && <StatusIndicator type="success">Copied</StatusIndicator>}
          </SpaceBetween>
        </Box>
      </SpaceBetween>
    </FormField>
  );
}

export function EmbedBadgeView() {
  const { session } = useAuth();
  const sessionAgentId = session?.user.id ?? null;

  const [manualAgentId, setManualAgentId] = useState('');

  const effectiveAgentId = (sessionAgentId ?? manualAgentId).trim();
  const previewAgentId = effectiveAgentId || 'your-agent-id';

  const badgeUrl = useMemo(
    () =>
      `https://veritrail.io/api/v1/agent/${encodeURIComponent(previewAgentId)}/reputation/badge`,
    [previewAgentId],
  );
  const profileUrl = useMemo(
    () => `https://veritrail.io/agent/${encodeURIComponent(previewAgentId)}`,
    [previewAgentId],
  );

  const htmlSnippet = `<img src="${badgeUrl}" alt="Veritrail verified" />`;
  const markdownSnippet = `![Veritrail verified](${badgeUrl})`;
  const shieldsSnippet = `[![Veritrail](${badgeUrl})](${profileUrl})`;

  const hasUsableId = effectiveAgentId.length > 0;

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Show the world your agent is Veritrail-verified. Drop the badge into your README, docs, or status page."
        >
          Embed your badge
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Container header={<Header variant="h2">Your agent</Header>}>
          {sessionAgentId ? (
            <KeyValueAgent agentId={sessionAgentId} />
          ) : (
            <SpaceBetween size="s">
              <Alert type="info" header="Not signed in">
                Sign in to use your own agent ID automatically, or enter one below to preview the
                snippets.
              </Alert>
              <FormField
                label="Agent ID"
                description="The badge URL points at this ID. Snippets update as you type."
              >
                <Input
                  value={manualAgentId}
                  onChange={(e: { detail: { value: string } }) => setManualAgentId(e.detail.value)}
                  placeholder="agent_01HZX..."
                />
              </FormField>
            </SpaceBetween>
          )}
        </Container>

        <Container header={<Header variant="h2">Live preview</Header>}>
          <SpaceBetween size="s">
            <Box>
              <img
                src={badgeUrl}
                alt="Veritrail verified"
                style={{ maxHeight: 32, verticalAlign: 'middle' }}
              />
            </Box>
            <Box variant="small" color="text-body-secondary">
              Served by{' '}
              <Box variant="code" display="inline">
                {badgeUrl}
              </Box>
            </Box>
            {!hasUsableId && (
              <Box variant="small" color="text-status-info">
                Showing a placeholder ID. Enter an agent ID above to preview your own badge.
              </Box>
            )}
          </SpaceBetween>
        </Container>

        <Container
          header={
            <Header
              variant="h2"
              description="Pick the format that matches where you are embedding the badge."
            >
              Embed snippets
            </Header>
          }
        >
          <ColumnLayout columns={1}>
            <Snippet
              label="HTML"
              description="For static sites, status pages, or anywhere raw HTML works."
              code={htmlSnippet}
            />
            <Snippet
              label="Markdown"
              description="Drop into a GitHub README or any Markdown-rendered doc."
              code={markdownSnippet}
            />
            <Snippet
              label="Shields.io style (linked)"
              description="Markdown that links the badge to the agent's public reputation profile."
              code={shieldsSnippet}
            />
          </ColumnLayout>
        </Container>
      </SpaceBetween>
    </ContentLayout>
  );
}

function KeyValueAgent({ agentId }: { readonly agentId: string }) {
  return (
    <SpaceBetween size="xs">
      <Box variant="awsui-key-label">Agent ID</Box>
      <Box variant="code">{agentId}</Box>
      <Box variant="small" color="text-body-secondary">
        Using your current session's agent ID. Sign out to embed a different one.
      </Box>
    </SpaceBetween>
  );
}
