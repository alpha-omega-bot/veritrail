import { describe, expect, it } from 'vitest';

import {
  PAGERDUTY_EVENTS_ENDPOINT,
  RESEND_EMAIL_ENDPOINT,
  billingReceiptEmail,
  deliverPagerDuty,
  deliverResend,
  deliverSlack,
  formatPagerDutyEvent,
  formatResendEmail,
  formatSlackMessage,
  magicLinkEmail,
  mapPagerDutySeverity,
  quotaWarningEmail,
  vendorRiskAlertEmail,
  welcomeEmail,
} from '../src/index.js';
import type { NotificationEvent } from '../src/index.js';

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

const captureFetch = (): { fetchImpl: typeof fetch; calls: CapturedRequest[] } => {
  const calls: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
};

const sampleEvent: NotificationEvent = {
  type: 'policy.evaluated',
  actorId: 'agent-support-7',
  correlationId: 'corr-9f12',
  causationId: 'act-481',
  severity: 'error',
  occurredAt: '2026-06-30T12:00:00Z',
  message: 'egress to api.unknown-vendor.io denied by policy pol-42',
  incidentId: 'inc-12345',
  details: { policyId: 'pol-42' },
};

const flatten = (parts: ReadonlyArray<{ text: string }>): string =>
  parts.map((p) => p.text).join('\n');

describe('formatSlackMessage', () => {
  it('includes the event type, actorId, and correlationId in the rendered fields', () => {
    const payload = formatSlackMessage(sampleEvent);
    const allText = JSON.stringify(payload);
    expect(allText).toContain('policy.evaluated');
    expect(allText).toContain('agent-support-7');
    expect(allText).toContain('corr-9f12');
    const header = payload.blocks[0];
    expect(header?.type).toBe('header');
    if (header?.type === 'header') {
      expect(header.text.text).toContain('policy.evaluated');
    }
    const section = payload.blocks[1];
    expect(section?.type).toBe('section');
    if (section?.type === 'section') {
      const joined = flatten(section.fields);
      expect(joined).toContain('agent-support-7');
      expect(joined).toContain('corr-9f12');
    }
  });

  it('appends a "View incident" action block when baseConsoleUrl is supplied', () => {
    const payload = formatSlackMessage(sampleEvent, {
      baseConsoleUrl: 'https://console.veritrail.dev/',
    });
    const action = payload.blocks.find((b) => b.type === 'actions');
    expect(action).toBeDefined();
    if (action?.type === 'actions') {
      const button = action.elements[0];
      expect(button?.text.text).toBe('View incident');
      expect(button?.url).toBe('https://console.veritrail.dev/incidents/inc-12345');
    }
  });

  it('omits the actions block when no baseConsoleUrl is configured', () => {
    const payload = formatSlackMessage(sampleEvent);
    expect(payload.blocks.some((b) => b.type === 'actions')).toBe(false);
  });
});

describe('deliverSlack', () => {
  it('POSTs the payload as JSON to the webhook URL', async () => {
    const { fetchImpl, calls } = captureFetch();
    const payload = formatSlackMessage(sampleEvent);
    await deliverSlack({
      webhookUrl: 'https://hooks.slack.com/services/T/B/X',
      payload,
      fetchImpl,
    });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe('https://hooks.slack.com/services/T/B/X');
    expect(call?.init.method).toBe('POST');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse(String(call?.init.body));
    expect(body.blocks).toBeDefined();
    expect(body.text).toContain('policy.evaluated');
  });

  it('throws a VeritrailError on non-2xx response', async () => {
    const fetchImpl: typeof fetch = async () => new Response('nope', { status: 500 });
    const payload = formatSlackMessage(sampleEvent);
    await expect(
      deliverSlack({ webhookUrl: 'https://hooks.slack.com/x', payload, fetchImpl }),
    ).rejects.toMatchObject({ code: 'STORAGE' });
  });
});

describe('formatPagerDutyEvent', () => {
  it('maps every Veritrail severity onto PagerDuty severity vocabulary', () => {
    expect(mapPagerDutySeverity('critical')).toBe('critical');
    expect(mapPagerDutySeverity('error')).toBe('error');
    expect(mapPagerDutySeverity('warn')).toBe('warning');
    expect(mapPagerDutySeverity('info')).toBe('info');
    expect(mapPagerDutySeverity(undefined)).toBe('info');
  });

  it('produces a v2 trigger payload with summary, source, and custom_details', () => {
    const payload = formatPagerDutyEvent(sampleEvent, { routingKey: 'rk-abc' });
    expect(payload.routing_key).toBe('rk-abc');
    expect(payload.event_action).toBe('trigger');
    expect(payload.payload.severity).toBe('error');
    expect(payload.payload.summary).toContain('policy.evaluated');
    expect(payload.payload.summary).toContain('egress to api.unknown-vendor.io');
    expect(payload.payload.source).toBe('agent-support-7');
    expect(payload.payload.custom_details).toMatchObject({
      actor_id: 'agent-support-7',
      correlation_id: 'corr-9f12',
      causation_id: 'act-481',
      event_type: 'policy.evaluated',
    });
    expect(payload.dedup_key).toBe('inc-12345');
  });

  it('embeds a console deep link when baseConsoleUrl is provided', () => {
    const payload = formatPagerDutyEvent(sampleEvent, {
      routingKey: 'rk-abc',
      baseConsoleUrl: 'https://console.veritrail.dev',
    });
    expect(payload.links?.[0]?.href).toBe('https://console.veritrail.dev/incidents/inc-12345');
  });
});

describe('deliverPagerDuty', () => {
  it('POSTs to events.pagerduty.com/v2/enqueue with the routing key embedded in the body', async () => {
    const { fetchImpl, calls } = captureFetch();
    const payload = formatPagerDutyEvent(sampleEvent, { routingKey: 'rk-abc' });
    await deliverPagerDuty({ payload, fetchImpl });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(PAGERDUTY_EVENTS_ENDPOINT);
    expect(call?.url).toBe('https://events.pagerduty.com/v2/enqueue');
    const body = JSON.parse(String(call?.init.body));
    expect(body.routing_key).toBe('rk-abc');
    expect(body.event_action).toBe('trigger');
  });
});

describe('formatResendEmail + deliverResend', () => {
  it('formats input with snake_cased fields and array `to`', () => {
    const payload = formatResendEmail({
      to: 'alice@example.com',
      subject: 'hi',
      html: '<p>hi</p>',
      text: 'hi',
      replyTo: 'support@veritrail.dev',
    });
    expect(payload.to).toEqual(['alice@example.com']);
    expect(payload.reply_to).toBe('support@veritrail.dev');
    expect((payload as unknown as Record<string, unknown>)['replyTo']).toBeUndefined();
  });

  it('uses Bearer auth and POSTs to /emails', async () => {
    const { fetchImpl, calls } = captureFetch();
    const payload = formatResendEmail({
      to: 'alice@example.com',
      subject: 'Welcome',
      html: '<p>hi</p>',
      text: 'hi',
    });
    await deliverResend({
      apiKey: 'rs_test_123',
      from: 'no-reply@veritrail.dev',
      payload,
      fetchImpl,
    });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(RESEND_EMAIL_ENDPOINT);
    expect(call?.url.endsWith('/emails')).toBe(true);
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer rs_test_123');
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse(String(call?.init.body));
    expect(body.from).toBe('no-reply@veritrail.dev');
    expect(body.to).toEqual(['alice@example.com']);
    expect(body.subject).toBe('Welcome');
  });
});

describe('email templates', () => {
  it('magicLinkEmail interpolates the link into both HTML and text bodies', () => {
    const link = 'https://app.veritrail.dev/auth/magic?t=abc.def.ghi';
    const rendered = magicLinkEmail({ link, expiresInMinutes: 15 });
    expect(rendered.html).toContain(link);
    expect(rendered.html).toContain('15 minutes');
    expect(rendered.subject.toLowerCase()).toContain('sign-in');
  });

  it('magicLinkEmail text version contains the URL verbatim for non-HTML clients', () => {
    const link = 'https://app.veritrail.dev/auth/magic?t=abc&user=u_1';
    const rendered = magicLinkEmail({ link, expiresInMinutes: 10 });
    expect(rendered.text).toContain(link);
    expect(rendered.text).not.toContain('&amp;');
  });

  it('quotaWarningEmail includes the percent number and tier', () => {
    const rendered = quotaWarningEmail({ percent: 87, tier: 'Pro', upgradeUrl: 'https://app/upg' });
    expect(rendered.subject).toContain('87');
    expect(rendered.html).toContain('87%');
    expect(rendered.html).toContain('Pro');
    expect(rendered.text).toContain('87');
  });

  it('welcomeEmail uses the supplied name and falls back to "there" when missing', () => {
    const named = welcomeEmail({ name: 'Ada', consoleUrl: 'https://app.veritrail.dev' });
    expect(named.html).toContain('Ada');
    expect(named.text).toContain('Ada');
    const anon = welcomeEmail({ consoleUrl: 'https://app.veritrail.dev' });
    expect(anon.html).toContain('there');
    expect(anon.text).toContain('there');
  });

  it('vendorRiskAlertEmail and billingReceiptEmail surface the headline numbers', () => {
    const vra = vendorRiskAlertEmail({
      vendorName: 'Acme AI',
      score: 78,
      band: 'high',
      consoleUrl: 'https://app/v',
    });
    expect(vra.subject).toContain('Acme AI');
    expect(vra.html).toContain('high');
    expect(vra.text).toContain('78');

    const br = billingReceiptEmail({
      amount: '$249.00',
      periodEnd: '2026-07-31',
      invoiceUrl: 'https://app/i/abc',
    });
    expect(br.subject).toContain('$249.00');
    expect(br.html).toContain('2026-07-31');
    expect(br.text).toContain('https://app/i/abc');
  });
});
