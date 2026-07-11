import { useEffect, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ContentLayout from '@cloudscape-design/components/content-layout';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import Table from '@cloudscape-design/components/table';

import {
  createApiKey as createKeyApi,
  listApiKeys,
  revokeApiKey,
  type ApiKeyPreview,
} from '../api.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { formatDateTime } from '../format.ts';

export function ApiKeysView() {
  const { session } = useAuth();
  const projectId = session?.currentProjectId ?? null;

  const [keys, setKeys] = useState<ApiKeyPreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [revealedKey, setRevealedKey] = useState<string | null>(null);

  const refresh = async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      setKeys(await listApiKeys(projectId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load keys');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const create = async () => {
    if (!projectId || !newLabel.trim()) return;
    try {
      const result = await createKeyApi(projectId, newLabel.trim());
      setRevealedKey(result.key);
      setNewLabel('');
      setCreating(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create key');
    }
  };

  const revoke = async (id: string) => {
    if (!window.confirm('Revoke this API key? Apps using it will stop working immediately.')) {
      return;
    }
    try {
      await revokeApiKey(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to revoke key');
    }
  };

  if (!session) {
    return (
      <ContentLayout header={<Header variant="h1">API Keys</Header>}>
        <Alert type="info" header="Sign in to manage API keys">
          API key management is available to signed-in users.
        </Alert>
      </ContentLayout>
    );
  }

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Manage API keys for this project. Each key carries an org+project label scope."
          actions={
            <Button variant="primary" onClick={() => setCreating(true)}>
              Create key
            </Button>
          }
        >
          API Keys
        </Header>
      }
    >
      <SpaceBetween size="l">
        {error && (
          <Alert type="error" header="Operation failed">
            {error}
          </Alert>
        )}
        {loading ? (
          <Spinner size="large" />
        ) : (
          <Table<ApiKeyPreview>
            variant="container"
            items={keys}
            trackBy={(k) => k.id}
            empty={
              <Box textAlign="center" color="inherit">
                No API keys yet. Create one to start ingesting events.
              </Box>
            }
            columnDefinitions={[
              {
                id: 'label',
                header: 'Label',
                cell: (k) => k.label || <Box color="text-body-secondary">(unlabeled)</Box>,
              },
              {
                id: 'prefix',
                header: 'Prefix',
                cell: (k) => <Box variant="code">{k.prefix}…</Box>,
              },
              {
                id: 'created',
                header: 'Created',
                cell: (k) => formatDateTime(new Date(k.createdAt).toISOString()),
              },
              {
                id: 'lastUsed',
                header: 'Last used',
                cell: (k) =>
                  k.lastUsedAt ? formatDateTime(new Date(k.lastUsedAt).toISOString()) : 'Never',
              },
              {
                id: 'status',
                header: 'Status',
                cell: (k) =>
                  k.revokedAt ? <Box color="text-status-error">Revoked</Box> : 'Active',
              },
              {
                id: 'actions',
                header: '',
                cell: (k) =>
                  k.revokedAt ? null : (
                    <Button variant="link" onClick={() => void revoke(k.id)}>
                      Revoke
                    </Button>
                  ),
              },
            ]}
          />
        )}
      </SpaceBetween>

      <Modal
        visible={creating}
        onDismiss={() => setCreating(false)}
        header="Create API key"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setCreating(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => void create()} disabled={!newLabel.trim()}>
                Create
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <FormField label="Label" description="Anything that helps you identify this key later.">
          <Input
            value={newLabel}
            onChange={(e: { detail: { value: string } }) => setNewLabel(e.detail.value)}
            placeholder="production server"
            autoFocus
          />
        </FormField>
      </Modal>

      <Modal
        visible={revealedKey !== null}
        onDismiss={() => setRevealedKey(null)}
        header="Copy your API key now"
        footer={
          <Box float="right">
            <Button
              variant="primary"
              onClick={() => {
                if (revealedKey !== null) void navigator.clipboard.writeText(revealedKey);
                setRevealedKey(null);
              }}
            >
              Copy and close
            </Button>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <Alert type="warning" header="You won't see this key again">
            We never store the plaintext. Save it somewhere safe.
          </Alert>
          <Box variant="code" padding="s">
            {revealedKey}
          </Box>
        </SpaceBetween>
      </Modal>
    </ContentLayout>
  );
}
