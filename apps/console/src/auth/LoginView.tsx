import { useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import SpaceBetween from '@cloudscape-design/components/space-between';

import { requestMagicLink } from '../api.ts';

/**
 * Magic-link login screen. The user types an email and clicks "Send link".
 * The server emails a one-time link with a short-lived token. When the user
 * clicks it, MagicLinkView consumes the token and creates a session.
 *
 * "Demo mode" remains a first-class option — users who don't want to sign up
 * can click "Continue in demo mode" and see the sample data we've always
 * shown.
 */
export function LoginView({
  onDemo,
}: {
  /** Called when the user chooses the demo path. */
  onDemo: () => void;
}) {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!email.trim()) return;
    setSending(true);
    setError(null);
    try {
      await requestMagicLink(email.trim());
      setSent(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      // We deliberately tell users "if the email exists, a link was sent"
      // for privacy (no enumeration). Only surface a real error when the
      // server itself failed (rate-limit, network).
      if (message.toLowerCase().includes('rate')) {
        setError('Too many attempts. Please wait a minute and try again.');
      } else if (message.toLowerCase().includes('network')) {
        setError('Could not reach the Veritrail API. Check your connection or try demo mode.');
      } else {
        // Treat unknown errors as success for enumeration safety.
        setSent(true);
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <Box padding={{ vertical: 'xxl', horizontal: 'l' }}>
      <Container
        header={
          <Header variant="h1" description="Sign in to your Veritrail console.">
            Welcome back
          </Header>
        }
      >
        <SpaceBetween size="l">
          {sent ? (
            <Alert type="success" header="Check your email">
              If an account exists for <strong>{email}</strong>, we&rsquo;ve sent a sign-in link. It
              expires in 15 minutes.
            </Alert>
          ) : (
            <Form
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  <Button variant="link" onClick={onDemo}>
                    Continue in demo mode
                  </Button>
                  <Button
                    variant="primary"
                    loading={sending}
                    disabled={!email.trim()}
                    onClick={() => void submit()}
                  >
                    Send sign-in link
                  </Button>
                </SpaceBetween>
              }
            >
              <SpaceBetween size="l">
                {error && (
                  <Alert type="error" header="Could not send link">
                    {error}
                  </Alert>
                )}
                <FormField label="Email" description="We&rsquo;ll send a one-time sign-in link.">
                  <Input
                    type="email"
                    autoFocus
                    value={email}
                    onChange={(e: { detail: { value: string } }) => setEmail(e.detail.value)}
                    placeholder="you@company.com"
                    ariaLabel="Email address"
                  />
                </FormField>
              </SpaceBetween>
            </Form>
          )}
          <Box variant="small" color="text-body-secondary">
            By signing in you agree to the Veritrail terms of service.
          </Box>
        </SpaceBetween>
      </Container>
    </Box>
  );
}
