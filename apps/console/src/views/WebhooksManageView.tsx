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
  createWebhook as createWebhookApi,
  deleteWebhook,
  listWebhooks,
  pauseWebhook,
  resumeWebhook,
  type WebhookPreview,
} from '../api.ts';
import { useAuth } from '../auth/AuthContext.tsx';
import { formatDateTime } from '../format.ts';

export function WebhooksManageView() {
  const { session } = useAuth();
  const projectId = session?.currentProjectId ?? null;

  const [webhooks, setWebhooks] = useState<WebhookPreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newEventsFilter, setNewEventsFilter] = useState('');
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);

  const refresh = async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      setWebhooks(await listWebhooks(projectId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load webhooks');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const create = async () => {
    if (!projectId || !newUrl.trim()) return;
    try {
      const result = await createWebhookApi(projectId, newUrl.trim(), newEventsFilter.trim());
      setRevealedSecret(result.secret);
      setNewUrl('');
      setNewEventsFilter('');
      setCreating(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create webhook');
    }
  };

  const pause = async (id: string) => {
    try {
      await pauseWebhook(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to pause webhook');
    }
  };

  const resume = async (id: string) => {
    try {
      await resumeWebhook(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to resume webhook');
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm('Delete this webhook? Deliveries will stop immediately.')) {
      return;
    }
    try {
      await deleteWebhook(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete webhook');
    }
  };

  if (!session) {
    return (
      <ContentLayout header={<Header variant="h1">Webhooks</Header>}>
        <Alert type="info" header="Sign in to use this feature">
          Webhook management is available to signed-in users.
        </Alert>
      </ContentLayout>
    );
  }

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Receive signed, retried HTTP callbacks for any event type your agents emit."
          actions={
            <Button variant="primary" onClick={() => setCreating(true)}>
              Create webhook
            </Button>
          }
        >
          Webhooks
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
          <Table<WebhookPreview>
            variant="container"
            items={webhooks}
            trackBy={(w) => w.id}
            empty={
              <Box textAlign="center" color="inherit">
                No webhooks yet. Create one to receive event callbacks.
              </Box>
            }
            columnDefinitions={[
              {
                id: 'url',
                header: 'URL',
                cell: (w) => <Box variant="code">{w.url}</Box>,
              },
              {
                id: 'eventsFilter',
                header: 'Events filter',
                cell: (w) =>
                  w.eventsFilter ? (
                    <Box variant="code">{w.eventsFilter}</Box>
                  ) : (
                    <Box color="text-body-secondary">(all)</Box>
                  ),
              },
              {
                id: 'status',
                header: 'Status',
                cell: (w) =>
                  w.status === 'paused' ? (
                    <Box color="text-status-warning">Paused</Box>
                  ) : w.status === 'active' ? (
                    'Active'
                  ) : (
                    w.status
                  ),
              },
              {
                id: 'createdAt',
                header: 'Created',
                cell: (w) => formatDateTime(new Date(w.createdAt).toISOString()),
              },
              {
                id: 'actions',
                header: '',
                cell: (w) => (
                  <SpaceBetween direction="horizontal" size="xs">
                    {w.status === 'paused' ? (
                      <Button variant="link" onClick={() => void resume(w.id)}>
                        Resume
                      </Button>
                    ) : (
                      <Button variant="link" onClick={() => void pause(w.id)}>
                        Pause
                      </Button>
                    )}
                    <Button variant="link" onClick={() => void remove(w.id)}>
                      Delete
                    </Button>
                  </SpaceBetween>
                ),
              },
            ]}
          />
        )}
      </SpaceBetween>

      <Modal
        visible={creating}
        onDismiss={() => setCreating(false)}
        header="Create webhook"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setCreating(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => void create()} disabled={!newUrl.trim()}>
                Create
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <FormField label="URL" description="HTTPS endpoint to receive signed delivery callbacks.">
            <Input
              value={newUrl}
              onChange={(e: { detail: { value: string } }) => setNewUrl(e.detail.value)}
              placeholder="https://example.com/webhooks/veritrail"
              autoFocus
            />
          </FormField>
          <FormField
            label="Events filter"
            description="Comma-separated event types, or leave blank for all events."
          >
            <Input
              value={newEventsFilter}
              onChange={(e: { detail: { value: string } }) => setNewEventsFilter(e.detail.value)}
              placeholder="policy.violation,receipt.anchored"
            />
          </FormField>
        </SpaceBetween>
      </Modal>

      <Modal
        visible={revealedSecret !== null}
        onDismiss={() => setRevealedSecret(null)}
        header="Save this secret now"
        footer={
          <Box float="right">
            <Button
              variant="primary"
              onClick={() => {
                if (revealedSecret !== null) void navigator.clipboard.writeText(revealedSecret);
                setRevealedSecret(null);
              }}
            >
              Copy and close
            </Button>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <Alert type="warning" header="Save this secret now - you will not see it again">
            We never store the plaintext. Use it to verify the{' '}
            <Box variant="code">x-veritrail-signature</Box> header on every delivery.
          </Alert>
          <Box variant="code" padding="s">
            {revealedSecret}
          </Box>
        </SpaceBetween>
      </Modal>
    </ContentLayout>
  );
}
