import { VeritrailError } from '@veritrail/core';

import type { FetchImpl, NotificationEvent, NotificationSeverity } from './types.js';

/** PagerDuty Events API v2 severity bands. */
export type PagerDutySeverity = 'critical' | 'error' | 'warning' | 'info';

/** PagerDuty Events API v2 actions. */
export type PagerDutyAction = 'trigger' | 'acknowledge' | 'resolve';

/** Options for shaping the Events API v2 payload. */
export interface PagerDutyFormatOptions {
  readonly routingKey: string;
  readonly source?: string;
  readonly action?: PagerDutyAction;
  readonly baseConsoleUrl?: string;
  readonly client?: string;
}

/** PagerDuty Events API v2 envelope. */
export interface PagerDutyPayload {
  readonly routing_key: string;
  readonly event_action: PagerDutyAction;
  readonly dedup_key?: string;
  readonly client?: string;
  readonly client_url?: string;
  readonly links?: readonly { readonly href: string; readonly text: string }[];
  readonly payload: {
    readonly summary: string;
    readonly severity: PagerDutySeverity;
    readonly source: string;
    readonly timestamp?: string;
    readonly component?: string;
    readonly group?: string;
    readonly class?: string;
    readonly custom_details: Readonly<Record<string, unknown>>;
  };
}

/** Arguments for `deliverPagerDuty`. */
export interface DeliverPagerDutyOptions {
  readonly payload: PagerDutyPayload;
  readonly fetchImpl?: FetchImpl;
  readonly endpoint?: string;
}

/** Default PagerDuty Events API v2 endpoint. */
export const PAGERDUTY_EVENTS_ENDPOINT = 'https://events.pagerduty.com/v2/enqueue';

const SEVERITY_MAP: Readonly<Record<NotificationSeverity, PagerDutySeverity>> = {
  critical: 'critical',
  error: 'error',
  warn: 'warning',
  info: 'info',
};

/** Map a Veritrail severity band onto PagerDuty's severity vocabulary. */
export function mapPagerDutySeverity(
  severity: NotificationSeverity | undefined,
): PagerDutySeverity {
  if (severity === undefined) return 'info';
  return SEVERITY_MAP[severity];
}

const trimConsoleBase = (base: string): string => (base.endsWith('/') ? base.slice(0, -1) : base);

const buildIncidentUrl = (base: string, event: NotificationEvent): string | undefined => {
  const trimmed = trimConsoleBase(base);
  if (event.incidentId !== undefined && event.incidentId.length > 0) {
    return `${trimmed}/incidents/${encodeURIComponent(event.incidentId)}`;
  }
  if (event.correlationId !== undefined && event.correlationId.length > 0) {
    return `${trimmed}/incidents?correlationId=${encodeURIComponent(event.correlationId)}`;
  }
  return undefined;
};

/**
 * Format a Veritrail notification as a PagerDuty Events API v2 payload.
 *
 * `dedup_key` is the incident or correlation id when present, so retries and
 * follow-up events on the same incident collapse into a single alert.
 */
export function formatPagerDutyEvent(
  event: NotificationEvent,
  options: PagerDutyFormatOptions,
): PagerDutyPayload {
  const severity = mapPagerDutySeverity(event.severity);
  const source = options.source ?? event.source ?? event.actorId;
  const summary =
    event.message !== undefined && event.message.length > 0
      ? `${event.type}: ${event.message}`
      : event.type;
  const dedup = event.incidentId ?? event.correlationId;

  const links = (() => {
    if (options.baseConsoleUrl === undefined) return undefined;
    const href = buildIncidentUrl(options.baseConsoleUrl, event);
    if (href === undefined) return undefined;
    return [{ href, text: 'View incident in Veritrail' }] as const;
  })();

  const customDetails: Record<string, unknown> = {
    actor_id: event.actorId,
    event_type: event.type,
  };
  if (event.correlationId !== undefined) customDetails['correlation_id'] = event.correlationId;
  if (event.causationId !== undefined) customDetails['causation_id'] = event.causationId;
  if (event.details !== undefined) customDetails['details'] = event.details;

  return {
    routing_key: options.routingKey,
    event_action: options.action ?? 'trigger',
    ...(dedup !== undefined ? { dedup_key: dedup } : {}),
    ...(options.client !== undefined ? { client: options.client } : {}),
    ...(links !== undefined ? { links } : {}),
    payload: {
      summary,
      severity,
      source,
      ...(event.occurredAt !== undefined ? { timestamp: event.occurredAt } : {}),
      custom_details: customDetails,
    },
  };
}

/**
 * POST a formatted Events API v2 payload to PagerDuty.
 *
 * Throws `VeritrailError` of code `STORAGE` on transport failure or non-2xx
 * response.
 */
export async function deliverPagerDuty(opts: DeliverPagerDutyOptions): Promise<void> {
  const fetchImpl: FetchImpl = opts.fetchImpl ?? fetch;
  const endpoint = opts.endpoint ?? PAGERDUTY_EVENTS_ENDPOINT;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts.payload),
    });
  } catch (cause) {
    throw new VeritrailError('STORAGE', 'pagerduty request failed', { cause });
  }
  if (!response.ok) {
    throw new VeritrailError('STORAGE', `pagerduty returned ${response.status}`, {
      details: { status: response.status },
    });
  }
}
