import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';

import { useAuth } from '../auth/AuthContext.tsx';

/**
 * Placeholder Team view — full member management (invites, role changes,
 * removal) is wired into the control plane endpoints in a follow-up.
 */
export function TeamView() {
  const { session } = useAuth();
  if (!session) {
    return (
      <ContentLayout header={<Header variant="h1">Team</Header>}>
        <Alert type="info" header="Sign in to manage your team">
          Member management is available to signed-in users.
        </Alert>
      </ContentLayout>
    );
  }
  return (
    <ContentLayout
      header={
        <Header variant="h1" description="Invite teammates and manage roles within your org.">
          Team
        </Header>
      }
    >
      <Box padding="l">
        <Alert type="info" header="Coming soon">
          Member management UI is in the next release. In the meantime, contact support to invite
          teammates to <strong>{session.orgs[0]?.name ?? 'your org'}</strong>.
        </Alert>
      </Box>
    </ContentLayout>
  );
}
