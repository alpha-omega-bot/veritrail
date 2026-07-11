import { useEffect, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';

import { consumeMagicLink } from '../api.ts';
import { useAuth } from './AuthContext.tsx';

/** Reads the token from the URL hash query string: `#/magic-link?token=<>`. */
function readToken(): string | null {
  const raw = window.location.hash;
  const match = raw.match(/[?&]token=([^&]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function MagicLinkView() {
  const { setSession } = useAuth();
  const [state, setState] = useState<'pending' | 'ok' | 'error'>('pending');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = readToken();
    if (!token) {
      setState('error');
      setError('No sign-in token found in the URL. Try requesting a new link.');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const session = await consumeMagicLink(token);
        if (cancelled) return;
        setSession(session);
        setState('ok');
        // Land them on the overview after a beat.
        window.location.hash = '#/overview';
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'unknown error';
        setError(message);
        setState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setSession]);

  return (
    <Box padding={{ vertical: 'xxl', horizontal: 'l' }}>
      <Container
        header={
          <Header variant="h1">
            {state === 'pending'
              ? 'Signing you in...'
              : state === 'ok'
                ? 'Signed in'
                : 'Sign-in failed'}
          </Header>
        }
      >
        <SpaceBetween size="l">
          {state === 'pending' && (
            <Box textAlign="center">
              <Spinner size="large" />
            </Box>
          )}
          {state === 'ok' && (
            <Alert type="success" header="Welcome">
              Redirecting to the overview...
            </Alert>
          )}
          {state === 'error' && (
            <>
              <Alert type="error" header="Could not sign you in">
                {error ?? 'Your sign-in link is invalid or expired.'}
              </Alert>
              <Button onClick={() => (window.location.hash = '#/login')}>Request a new link</Button>
            </>
          )}
        </SpaceBetween>
      </Container>
    </Box>
  );
}
