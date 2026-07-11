import { useEffect, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import Table from '@cloudscape-design/components/table';
import Textarea from '@cloudscape-design/components/textarea';

import { useAuth } from '../auth/AuthContext.tsx';

interface PolicyView {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly effect: 'allow' | 'deny' | 'require_approval';
  readonly enabled: boolean;
  readonly priority: number;
  readonly tenant?: Record<string, string>;
  readonly match?: Record<string, unknown>;
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  try {
    const raw = window.localStorage.getItem('veritrail.session');
    const session = raw ? (JSON.parse(raw) as { token?: string }) : null;
    return {
      Accept: 'application/json',
      ...(session?.token ? { authorization: `Bearer ${session.token}` } : {}),
      ...(extra ?? {}),
    };
  } catch {
    return { Accept: 'application/json', ...(extra ?? {}) };
  }
}

const SAMPLE_POLICY = `{
  "id": "pol-block-egress",
  "name": "Block external egress",
  "description": "Deny all network egress to non-allowlisted hosts.",
  "effect": "deny",
  "enabled": true,
  "priority": 100,
  "match": { "actionTypes": ["network.egress"] }
}`;

export function PoliciesView() {
  const { session } = useAuth();
  const [policies, setPolicies] = useState<PolicyView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(SAMPLE_POLICY);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/permissions/policies', { headers: authHeaders() });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          setPolicies([]);
          setError(null);
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as { policies?: PolicyView[] } | PolicyView[];
      const list = Array.isArray(body) ? body : (body.policies ?? []);
      setPolicies(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load policies');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const create = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'JSON parse error');
      return;
    }
    try {
      const res = await fetch('/api/permissions/policies', {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(parsed),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body}`);
      }
      setCreating(false);
      setDraft(SAMPLE_POLICY);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save policy');
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm(`Delete policy ${id}?`)) return;
    try {
      const res = await fetch(`/api/permissions/policies/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete policy');
    }
  };

  if (!session) {
    return (
      <ContentLayout header={<Header variant="h1">Policies</Header>}>
        <Alert type="info" header="Sign in to manage policies">
          Policy management is available to signed-in users.
        </Alert>
      </ContentLayout>
    );
  }

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Deny-by-default policies governing agent actions."
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => void refresh()}>Refresh</Button>
              <Button
                variant="primary"
                onClick={() => {
                  setDraft(SAMPLE_POLICY);
                  setCreating(true);
                }}
              >
                Add policy
              </Button>
            </SpaceBetween>
          }
        >
          Policies
        </Header>
      }
    >
      <SpaceBetween size="l">
        {error && (
          <Alert type="error" header="Policy operation failed">
            {error}
          </Alert>
        )}
        {loading ? (
          <Spinner size="large" />
        ) : (
          <Table<PolicyView>
            variant="container"
            items={policies}
            trackBy={(p) => p.id}
            empty={
              <Box textAlign="center" padding={{ vertical: 'xs' }}>
                <SpaceBetween size="s">
                  <Box variant="strong" fontSize="heading-m">
                    No policies yet
                  </Box>
                  <Box variant="p" color="text-body-secondary">
                    Deny-by-default applies until you add one.
                  </Box>
                </SpaceBetween>
              </Box>
            }
            columnDefinitions={[
              { id: 'id', header: 'ID', cell: (p) => <Box variant="code">{p.id}</Box> },
              { id: 'name', header: 'Name', cell: (p) => p.name },
              {
                id: 'effect',
                header: 'Effect',
                cell: (p) => <Box variant="code">{p.effect}</Box>,
              },
              { id: 'priority', header: 'Priority', cell: (p) => p.priority },
              {
                id: 'enabled',
                header: 'Enabled',
                cell: (p) => (p.enabled ? 'Yes' : 'No'),
              },
              {
                id: 'tenant',
                header: 'Tenant scope',
                cell: (p) =>
                  p.tenant && Object.keys(p.tenant).length > 0 ? (
                    <Box variant="code">
                      {Object.entries(p.tenant)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(',')}
                    </Box>
                  ) : (
                    <Box color="text-body-secondary">global</Box>
                  ),
              },
              {
                id: 'actions',
                header: '',
                cell: (p) => (
                  <Button variant="link" onClick={() => void remove(p.id)}>
                    Delete
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
        size="large"
        header="Add policy"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setCreating(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => void create()}>
                Save
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <Container>
          <FormField
            label="Policy JSON"
            description="The policy must conform to PolicySchema. See the docs for the full grammar."
            stretch
          >
            <Textarea
              value={draft}
              onChange={({ detail }: { detail: { value: string } }) => setDraft(detail.value)}
              rows={16}
            />
          </FormField>
        </Container>
      </Modal>
    </ContentLayout>
  );
}
