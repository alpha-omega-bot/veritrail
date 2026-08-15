// Shared UI primitives: error rendering and the session credential control.

import { useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import { getApiToken, setApiToken, type ApiError } from './api.ts';

const HEADER_FOR_KIND: Record<ApiError['kind'], string> = {
  unauthorized: 'Authentication required',
  forbidden: 'Insufficient permissions',
  network: 'Cannot reach the Veritrail API',
  server: 'Request failed',
};

/**
 * Render a failed request. Deliberately explicit: this view shows no data at all
 * when the request failed, because a partially-populated audit view is worse
 * than an empty one.
 */
export function ErrorAlert({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <Alert
      type={error.kind === 'network' ? 'warning' : 'error'}
      header={HEADER_FOR_KIND[error.kind]}
      {...(onRetry !== undefined ? { action: <Button onClick={onRetry}>Retry</Button> } : {})}
    >
      <SpaceBetween size="xs">
        <Box>{error.message}</Box>
        {error.code !== null && (
          <Box variant="small" color="text-body-secondary">
            Error code: <Box variant="code">{error.code}</Box>
            {error.status !== null && ` · HTTP ${error.status}`}
          </Box>
        )}
      </SpaceBetween>
    </Alert>
  );
}

/** Centered spinner with an accessible label. */
export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <Box textAlign="center" padding={{ vertical: 'xl' }}>
      <Spinner size="large" />
      <Box variant="small" color="text-body-secondary" padding={{ top: 's' }}>
        {label}
      </Box>
    </Box>
  );
}

/** A labelled metric with an optional secondary hint. */
export function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div>
      <Box variant="awsui-key-label">{label}</Box>
      <Box variant="h2" padding={{ top: 'xxs' }}>
        {value}
      </Box>
      {hint !== undefined && (
        <Box variant="small" color="text-body-secondary">
          {hint}
        </Box>
      )}
    </div>
  );
}

/**
 * Operator credential entry.
 *
 * The token lives in `sessionStorage` only — it is never bundled, never written
 * to disk, and is discarded when the browser session ends. Deployments that
 * terminate authentication at a reverse proxy can leave this empty.
 */
export function CredentialPanel({ onChange }: { onChange: () => void }) {
  const [value, setValue] = useState('');
  const hasToken = getApiToken() !== null;

  const save = () => {
    setApiToken(value.trim().length > 0 ? value.trim() : null);
    setValue('');
    onChange();
  };

  const clear = () => {
    setApiToken(null);
    setValue('');
    onChange();
  };

  return (
    <Alert
      type="info"
      header={
        <Header variant="h3">
          {hasToken ? 'Operator token set for this session' : 'Operator API token'}
        </Header>
      }
    >
      <SpaceBetween size="s">
        <Box variant="small">
          The console reads the ledger through the Veritrail API, which requires an operator
          credential. The token is kept in session storage for this browser session only and is
          never written into the built assets. Leave this empty if authentication is handled by a
          reverse proxy in front of the API.
        </Box>
        <SpaceBetween direction="horizontal" size="xs">
          <Input
            value={value}
            type="password"
            placeholder={hasToken ? 'Replace token' : 'Paste operator API token'}
            onChange={({ detail }: { detail: { value: string } }) => setValue(detail.value)}
            ariaLabel="Operator API token"
          />
          <Button variant="primary" disabled={value.trim().length === 0} onClick={save}>
            Use token
          </Button>
          {hasToken && <Button onClick={clear}>Clear</Button>}
        </SpaceBetween>
      </SpaceBetween>
    </Alert>
  );
}
