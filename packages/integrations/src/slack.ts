import { VeritrailError } from '@veritrail/core';

import type { FetchImpl, NotificationEvent } from './types.js';

/**
 * Options for shaping the Slack Block Kit payload.
 *
 * `baseConsoleUrl` enables a "View incident" deep link block when the
 * notification carries either an `incidentId` or a `correlationId` that the
 * Veritrail console can resolve.
 */
export interface SlackFormatOptions {
  readonly baseConsoleUrl?: string;
}

/** Block Kit text object. */
export interface SlackTextObject {
  readonly type: 'mrkdwn' | 'plain_text';
  readonly text: string;
  readonly emoji?: boolean;
}

/** Block Kit button element (used inside an `actions` block). */
export interface SlackButtonElement {
  readonly type: 'button';
  readonly text: SlackTextObject;
  readonly url: string;
  readonly action_id: string;
  readonly style?: 'primary' | 'danger';
}

/** Block Kit block — narrow union of the kinds emitted by this formatter. */
export type SlackBlock =
  | { readonly type: 'header'; readonly text: SlackTextObject }
  | { readonly type: 'section'; readonly fields: readonly SlackTextObject[] }
  | { readonly type: 'context'; readonly elements: readonly SlackTextObject[] }
  | { readonly type: 'actions'; readonly elements: readonly SlackButtonElement[] };

/** A Slack incoming-webhook payload using Block Kit. */
export interface SlackPayload {
  readonly text: string;
  readonly blocks: readonly SlackBlock[];
}

/** Arguments for `deliverSlack`. */
export interface DeliverSlackOptions {
  readonly webhookUrl: string;
  readonly payload: SlackPayload;
  readonly fetchImpl?: FetchImpl;
}

const SEVERITY_EMOJI: Readonly<Record<string, string>> = {
  critical: ':rotating_light:',
  error: ':x:',
  warn: ':warning:',
  info: ':information_source:',
};

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
 * Format a Veritrail notification as a Slack Block Kit payload.
 *
 * Layout: a header carrying the event type, a fields section with actor,
 * correlation id, and severity, an optional context line for the event
 * `message`, and — when `baseConsoleUrl` is provided and the event carries an
 * `incidentId` or `correlationId` — an actions block with a "View incident"
 * button.
 */
export function formatSlackMessage(
  event: NotificationEvent,
  options: SlackFormatOptions = {},
): SlackPayload {
  const severityKey = event.severity ?? 'info';
  const emoji = SEVERITY_EMOJI[severityKey] ?? ':bell:';
  const title = `${emoji} ${event.type}`;

  const fields: SlackTextObject[] = [
    { type: 'mrkdwn', text: `*Actor*\n${event.actorId}` },
    {
      type: 'mrkdwn',
      text: `*Correlation*\n${event.correlationId ?? '_unset_'}`,
    },
    { type: 'mrkdwn', text: `*Severity*\n${severityKey}` },
  ];
  if (event.occurredAt !== undefined) {
    fields.push({ type: 'mrkdwn', text: `*Occurred*\n${event.occurredAt}` });
  }

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: title, emoji: true },
    },
    { type: 'section', fields },
  ];

  if (event.message !== undefined && event.message.length > 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: event.message }],
    });
  }

  if (options.baseConsoleUrl !== undefined) {
    const url = buildIncidentUrl(options.baseConsoleUrl, event);
    if (url !== undefined) {
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View incident' },
            url,
            action_id: 'view_incident',
          },
        ],
      });
    }
  }

  return { text: title, blocks };
}

/**
 * POST a formatted Block Kit payload to a Slack incoming webhook.
 *
 * Throws `VeritrailError` of code `STORAGE` on transport failure or non-2xx
 * response.
 */
export async function deliverSlack(opts: DeliverSlackOptions): Promise<void> {
  const fetchImpl: FetchImpl = opts.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(opts.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts.payload),
    });
  } catch (cause) {
    throw new VeritrailError('STORAGE', 'slack webhook request failed', { cause });
  }
  if (!response.ok) {
    throw new VeritrailError('STORAGE', `slack webhook returned ${response.status}`, {
      details: { status: response.status },
    });
  }
}
