/**
 * Email delivery primitives for control-plane flows (magic-link, welcome,
 * quota warnings, billing receipts).
 *
 * Lives in `@veritrail/control-plane` because it is invoked from the
 * control-plane during auth and billing flows. `@veritrail/integrations` ships
 * a parallel Resend helper for ledger notifications; the two share a template
 * style but are kept separate so a control-plane host need not pull in the
 * full notification stack.
 */

/** Optional caller-supplied `fetch` implementation; defaults to the global. */
export type FetchImpl = typeof fetch;

/** Logical email payload accepted by an `EmailAdapter`. */
export interface EmailMessage {
  /** Recipient address. A single string keeps the wire shape simple. */
  readonly to: string;
  /** Subject line as rendered to the recipient. */
  readonly subject: string;
  /** Rendered HTML body. */
  readonly html: string;
  /** Plain-text fallback for non-HTML clients. */
  readonly text?: string;
}

/**
 * Transport-agnostic email delivery port.
 *
 * Implementations transmit `EmailMessage` to a backend (Resend, SMTP, an
 * in-memory fake) and return the provider's message id.
 */
export interface EmailAdapter {
  /** Send `msg` and resolve with the provider message id. */
  send(msg: EmailMessage): Promise<{ id: string }>;
}

/** Default Resend HTTP endpoint. */
export const RESEND_EMAIL_ENDPOINT = 'https://api.resend.com/emails';

/** Constructor arguments for `ResendEmailAdapter`. */
export interface ResendEmailAdapterOptions {
  /** Resend API key (`re_*`). Sent as Bearer credential. */
  readonly apiKey: string;
  /** Sender address presented to recipients. */
  readonly from: string;
  /** Override the API base URL. Defaults to `https://api.resend.com`. */
  readonly baseUrl?: string;
  /** Injected `fetch` for tests. Defaults to the global. */
  readonly fetchImpl?: FetchImpl;
}

interface ResendEmailResponse {
  readonly id?: string;
}

/**
 * `EmailAdapter` backed by Resend's transactional email API.
 *
 * Posts to `${baseUrl}/emails` with Bearer auth and returns the message id
 * Resend assigns. Throws `Error` on transport failure or any non-2xx response.
 */
export class ResendEmailAdapter implements EmailAdapter {
  private readonly apiKey: string;
  private readonly from: string;
  private readonly endpoint: string;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: ResendEmailAdapterOptions) {
    this.apiKey = opts.apiKey;
    this.from = opts.from;
    const base = opts.baseUrl ?? 'https://api.resend.com';
    this.endpoint = `${base.replace(/\/+$/, '')}/emails`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async send(msg: EmailMessage): Promise<{ id: string }> {
    const body = JSON.stringify({
      from: this.from,
      to: [msg.to],
      subject: msg.subject,
      html: msg.html,
      ...(msg.text !== undefined ? { text: msg.text } : {}),
    });
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body,
      });
    } catch (cause) {
      throw new Error(`resend request failed: ${(cause as Error).message}`);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`resend returned ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    const parsed = (await response.json().catch(() => ({}))) as ResendEmailResponse;
    return { id: parsed.id ?? '' };
  }
}
