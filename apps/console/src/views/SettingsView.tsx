import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import SpaceBetween from '@cloudscape-design/components/space-between';

import { useAuth } from '../auth/AuthContext.tsx';

export function SettingsView() {
  const { session, logout } = useAuth();
  if (!session) {
    return (
      <ContentLayout header={<Header variant="h1">Settings</Header>}>
        <Alert type="info" header="Sign in to view settings">
          You&rsquo;re viewing the public sample data. Sign in to manage your account.
        </Alert>
      </ContentLayout>
    );
  }

  const currentOrg = session.orgs.find((o) => o.id === session.currentOrgId);

  return (
    <ContentLayout
      header={
        <Header variant="h1" description="Account and workspace settings.">
          Settings
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Container header={<Header variant="h2">Account</Header>}>
          <KeyValuePairs
            columns={2}
            items={[
              { label: 'Email', value: session.user.email },
              { label: 'Display name', value: session.user.displayName ?? '—' },
              { label: 'User id', value: <Box variant="code">{session.user.id}</Box> },
            ]}
          />
        </Container>

        <Container header={<Header variant="h2">Current workspace</Header>}>
          {currentOrg ? (
            <KeyValuePairs
              columns={2}
              items={[
                { label: 'Organization', value: currentOrg.name },
                { label: 'Plan', value: currentOrg.tier },
                { label: 'Slug', value: <Box variant="code">{currentOrg.slug}</Box> },
                {
                  label: 'Project',
                  value: session.currentProjectId ? (
                    <Box variant="code">{session.currentProjectId}</Box>
                  ) : (
                    '—'
                  ),
                },
              ]}
            />
          ) : (
            <Box>No active workspace.</Box>
          )}
        </Container>

        <Container header={<Header variant="h2">Danger zone</Header>}>
          <SpaceBetween size="s">
            <Box>Signs you out of this device. You can sign back in with another magic link.</Box>
            <Button onClick={logout}>Sign out</Button>
          </SpaceBetween>
        </Container>
      </SpaceBetween>
    </ContentLayout>
  );
}
