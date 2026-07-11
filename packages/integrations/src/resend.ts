import { VeritrailError } from '@veritrail/core';

import type { FetchImpl } from './types.js';

/** Logical email payload accepted by the Resend adapter. */
export interface ResendEmailInput {
  readonly to: string | readonly string[];
  readonly subject: string;
  readonly html: string;
  readonly text?: string;
  readonly replyTo?: string;
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
}

/** Wire-shaped payload posted to `POST /emails`. */
export interface ResendEmailPayload {
  readonly to: readonly string[];
  readonly subject: string;
  readonly html: string;
  readonly text?: string;
  readonly reply_to?: string;
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
}

/** Arguments for `deliverResend`. */
export interface DeliverResendOptions {
  readonly apiKey: string;
  readonly from: string;
  readonly payload: ResendEmailPayload;
  readonly fetchImpl?: FetchImpl;
  readonly endpoint?: string;
}

/** Default Resend HTTP endpoint. */
export const RESEND_EMAIL_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Normalize a logical email input into the snake_cased shape Resend expects on
 * the wire. The `from` address is passed separately to `deliverResend` so a
 * single configured sender can be reused across templates.
 */
export function formatResendEmail(input: ResendEmailInput): ResendEmailPayload {
  const to = Array.isArray(input.to) ? [...input.to] : [input.to as string];
  return {
    to,
    subject: input.subject,
    html: input.html,
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.replyTo !== undefined ? { reply_to: input.replyTo } : {}),
    ...(input.cc !== undefined ? { cc: [...input.cc] } : {}),
    ...(input.bcc !== undefined ? { bcc: [...input.bcc] } : {}),
  };
}

/**
 * POST a Resend payload to the transactional email API using Bearer auth.
 *
 * Throws `VeritrailError` of code `STORAGE` on transport failure or non-2xx
 * response.
 */
export async function deliverResend(opts: DeliverResendOptions): Promise<void> {
  const fetchImpl: FetchImpl = opts.fetchImpl ?? fetch;
  const endpoint = opts.endpoint ?? RESEND_EMAIL_ENDPOINT;
  const body = JSON.stringify({ from: opts.from, ...opts.payload });
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.apiKey}`,
      },
      body,
    });
  } catch (cause) {
    throw new VeritrailError('STORAGE', 'resend request failed', { cause });
  }
  if (!response.ok) {
    throw new VeritrailError('STORAGE', `resend returned ${response.status}`, {
      details: { status: response.status },
    });
  }
}
