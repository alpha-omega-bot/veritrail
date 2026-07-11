import { describe, expect, it } from 'vitest';

import { RESEND_EMAIL_ENDPOINT, ResendEmailAdapter } from '../src/email.js';
import {
  buildBillingReceiptEmail,
  buildMagicLinkEmail,
  buildQuotaWarningEmail,
  buildWelcomeEmail,
} from '../src/email-templates.js';

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit;
}

const captureFetch = (
  status = 200,
  bodyJson: unknown = { id: 'msg_123' },
): { fetchImpl: typeof fetch; calls: CapturedRequest[] } => {
  const calls: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(bodyJson), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
};

describe('buildMagicLinkEmail', () => {
  it('interpolates the link in both html and text bodies', () => {
    const link = 'https://console.example/auth/m/abc123';
    const rendered = buildMagicLinkEmail({ link, expiresMinutes: 15 });
    expect(rendered.html).toContain(link);
    expect(rendered.text).toBeDefined();
    expect(rendered.text).toContain(link);
    expect(rendered.text).toContain('15 minutes');
    expect(rendered.subject).toContain('Veritrail');
  });
});

describe('buildWelcomeEmail', () => {
  it('greets "Welcome aboard" when displayName is missing', () => {
    const rendered = buildWelcomeEmail({ consoleUrl: 'https://console.example' });
    expect(rendered.html).toContain('Welcome aboard');
    expect(rendered.text).toContain('Welcome aboard');
    expect(rendered.html).not.toContain('Welcome, ');
  });

  it('uses the displayName when provided', () => {
    const rendered = buildWelcomeEmail({
      consoleUrl: 'https://console.example',
      displayName: 'Ada',
    });
    expect(rendered.html).toContain('Welcome, Ada');
    expect(rendered.text).toContain('Welcome, Ada');
  });
});

describe('buildQuotaWarningEmail', () => {
  it('mentions the percent and the tier', () => {
    const rendered = buildQuotaWarningEmail({
      percent: 85,
      tier: 'starter',
      upgradeUrl: 'https://console.example/billing',
    });
    expect(rendered.subject).toContain('85%');
    expect(rendered.subject).toContain('starter');
    expect(rendered.html).toContain('85%');
    expect(rendered.html).toContain('starter');
    expect(rendered.text).toContain('85%');
    expect(rendered.text).toContain('starter');
  });
});

describe('buildBillingReceiptEmail', () => {
  it('formats the amount as a USD currency string', () => {
    const rendered = buildBillingReceiptEmail({
      amountUsdMinor: 4999,
      periodEnd: '2026-06-30',
      invoiceUrl: 'https://invoice.example/abc',
    });
    expect(rendered.subject).toContain('$49.99');
    expect(rendered.html).toContain('$49.99');
    expect(rendered.text).toContain('$49.99');
  });
});

describe('ResendEmailAdapter.send', () => {
  it('POSTs to /emails with Bearer auth and returns the provider id', async () => {
    const { fetchImpl, calls } = captureFetch(200, { id: 'msg_abc' });
    const adapter = new ResendEmailAdapter({
      apiKey: 're_test_key',
      from: 'no-reply@veritrail.dev',
      fetchImpl,
    });
    const result = await adapter.send({
      to: 'alice@example.com',
      subject: 'hello',
      html: '<p>hi</p>',
      text: 'hi',
    });
    expect(result.id).toBe('msg_abc');
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(RESEND_EMAIL_ENDPOINT);
    expect(call?.init.method).toBe('POST');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer re_test_key');
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse(String(call?.init.body)) as {
      from: string;
      to: string[];
      subject: string;
      html: string;
      text?: string;
    };
    expect(body.from).toBe('no-reply@veritrail.dev');
    expect(body.to).toEqual(['alice@example.com']);
    expect(body.subject).toBe('hello');
    expect(body.html).toBe('<p>hi</p>');
    expect(body.text).toBe('hi');
  });

  it('throws on a non-2xx response', async () => {
    const fetchImpl: typeof fetch = async () => new Response('{"error":"nope"}', { status: 422 });
    const adapter = new ResendEmailAdapter({
      apiKey: 're_bad',
      from: 'no-reply@veritrail.dev',
      fetchImpl,
    });
    await expect(
      adapter.send({ to: 'alice@example.com', subject: 's', html: '<p>x</p>' }),
    ).rejects.toThrow(/422/);
  });

  it('honors a custom baseUrl', async () => {
    const { fetchImpl, calls } = captureFetch();
    const adapter = new ResendEmailAdapter({
      apiKey: 're_test',
      from: 'a@b.dev',
      baseUrl: 'https://eu.api.resend.com',
      fetchImpl,
    });
    await adapter.send({ to: 'a@example.com', subject: 's', html: '<p>x</p>' });
    expect(calls[0]?.url).toBe('https://eu.api.resend.com/emails');
  });
});
