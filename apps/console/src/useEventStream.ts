import { useEffect, useState } from 'react';

import { readLabelScope, readSessionToken } from './auth/AuthContext.tsx';

/**
 * Subscribe to a server-sent event stream and accumulate incoming records
 * into a bounded buffer. The hook returns the most recent `max` events in
 * arrival order plus connection metadata.
 *
 * Falls back gracefully: if EventSource is unavailable (older browsers), if
 * the server returns 404 (no SSE route configured), or if the connection
 * keeps failing, the hook reports a 'closed' status and the caller can keep
 * showing the polled snapshot from useAsync.
 */

export type SseStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface UseEventStreamResult<T> {
  readonly events: ReadonlyArray<T>;
  readonly status: SseStatus;
  readonly error: string | null;
  /** Clear the local buffer (useful when changing the active project). */
  reset(): void;
}

export interface UseEventStreamOptions {
  /** Path under /api, e.g. '/audit/events/stream'. */
  readonly path: string;
  /** Max events to retain in the buffer. */
  readonly max?: number;
  /** Optional starting sequence (?fromSeq=...). */
  readonly fromSeq?: number;
  /** Set false to opt out (e.g. when the user is in demo mode). */
  readonly enabled?: boolean;
}

/**
 * The browser's native EventSource does not let us send custom headers, so
 * we attach the session token as `?token=` for SSE only. That token is
 * short-lived and same-origin; an attacker who can read the URL string in
 * server logs has bigger problems than EventSource auth.
 */
export function useEventStream<T = unknown>(
  options: UseEventStreamOptions,
): UseEventStreamResult<T> {
  const { path, max = 200, fromSeq, enabled = true } = options;
  const [events, setEvents] = useState<T[]>([]);
  const [status, setStatus] = useState<SseStatus>('closed');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setStatus('closed');
      return;
    }
    if (typeof EventSource === 'undefined') {
      setStatus('closed');
      return;
    }

    const params = new URLSearchParams();
    const token = readSessionToken();
    if (token) params.set('token', token);
    if (fromSeq !== undefined) params.set('fromSeq', String(fromSeq));
    const scope = readLabelScope();
    if (scope) {
      for (const [key, value] of Object.entries(scope)) params.append(`label.${key}`, value);
    }
    const url = `/api${path}${params.toString() ? `?${params}` : ''}`;

    setStatus('connecting');
    setError(null);
    const source = new EventSource(url);

    source.onopen = () => setStatus('open');

    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as T;
        setEvents((prev) => {
          const next = [...prev, parsed];
          return next.length > max ? next.slice(next.length - max) : next;
        });
      } catch {
        // Bad JSON from the server; drop the frame, keep the stream open.
      }
    };

    source.onerror = () => {
      // EventSource transitions to readyState 0 (connecting) for transient
      // errors and 2 (closed) for permanent ones. We only mark 'closed' when
      // the browser stops retrying.
      if (source.readyState === EventSource.CLOSED) {
        setStatus('closed');
        setError('Event stream closed by the server.');
      } else {
        setStatus('reconnecting');
      }
    };

    return () => {
      source.close();
      setStatus('closed');
    };
  }, [path, max, fromSeq, enabled]);

  return {
    events,
    status,
    error,
    reset() {
      setEvents([]);
    },
  };
}
