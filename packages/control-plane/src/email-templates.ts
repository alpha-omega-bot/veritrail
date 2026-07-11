/**
 * Transactional email templates rendered by the control plane.
 *
 * Each builder returns the body of an `EmailMessage` — subject, html, and a
 * plain-text fallback. The caller supplies the recipient address; this keeps
 * templates pure and trivially testable.
 *
 * Style mirrors `@veritrail/integrations/email-templates`: a compact inline
 * stylesheet, a single primary call-to-action button, and the destination URL
 * rendered verbatim in both html and text so non-HTML clients (and link
 * scanners) can still reach it.
 */

import type { EmailMessage } from './email.js';

/** Output of a template builder: `EmailMessage` minus the recipient. */
export type RenderedEmail = Omit<EmailMessage, 'to'>;

const escapeHtml = (raw: string): string =>
  raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const wrap = (brand: string, title: string, body: string): string =>
  `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:24px">` +
  `<h1 style="font-size:18px;margin:0 0 16px">${escapeHtml(title)}</h1>` +
  body +
  `<p style="font-size:12px;color:#666;margin-top:32px">Sent by ${escapeHtml(brand)}</p>` +
  `</body></html>`;

/** Options for `buildMagicLinkEmail`. */
export interface MagicLinkEmailOptions {
  /** Fully-qualified single-use sign-in URL. */
  readonly link: string;
  /** Window during which the link remains valid. */
  readonly expiresMinutes: number;
  /** Product name surfaced in the subject and signature. Defaults to `Veritrail`. */
  readonly brandName?: string;
}

/** Single-use sign-in link with an explicit expiration window. */
export function buildMagicLinkEmail(opts: MagicLinkEmailOptions): RenderedEmail {
  const brand = opts.brandName ?? 'Veritrail';
  const subject = `Your ${brand} sign-in link`;
  const html = wrap(
    brand,
    `Sign in to ${brand}`,
    `<p>Use the button below to sign in. This link expires in ${opts.expiresMinutes} minutes and works once.</p>` +
      `<p><a href="${escapeHtml(opts.link)}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;text-decoration:none;border-radius:6px">Sign in</a></p>` +
      `<p>If the button doesn't work, paste this URL into your browser:<br/><span style="color:#444">${escapeHtml(opts.link)}</span></p>` +
      `<p style="font-size:12px;color:#666">Didn't request this? You can ignore the email.</p>`,
  );
  const text =
    `Sign in to ${brand}.\n\n` +
    `Use this link (expires in ${opts.expiresMinutes} minutes, single use):\n${opts.link}\n\n` +
    `Didn't request this? You can ignore the email.\n`;
  return { subject, html, text };
}

/** Options for `buildWelcomeEmail`. */
export interface WelcomeEmailOptions {
  /** Console landing URL the recipient should open after signing in. */
  readonly consoleUrl: string;
  /** Recipient's display name. Falls back to a generic greeting when omitted. */
  readonly displayName?: string;
}

/**
 * Welcome message sent after signup. Greets `Welcome aboard` when no display
 * name is supplied.
 */
export function buildWelcomeEmail(opts: WelcomeEmailOptions): RenderedEmail {
  const named = opts.displayName !== undefined && opts.displayName.length > 0;
  const greeting = named ? `Welcome, ${opts.displayName}` : 'Welcome aboard';
  const subject = 'Welcome to Veritrail';
  const html = wrap(
    'Veritrail',
    greeting,
    `<p>Thanks for joining Veritrail. Your control plane is ready.</p>` +
      `<p><a href="${escapeHtml(opts.consoleUrl)}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;text-decoration:none;border-radius:6px">Open console</a></p>` +
      `<p>Or paste this link into your browser:<br/><span style="color:#444">${escapeHtml(opts.consoleUrl)}</span></p>`,
  );
  const text =
    `${greeting}.\n\n` +
    `Thanks for joining Veritrail. Your control plane is ready.\n\n` +
    `Open the console: ${opts.consoleUrl}\n`;
  return { subject, html, text };
}

/** Options for `buildQuotaWarningEmail`. */
export interface QuotaWarningEmailOptions {
  /** Percent of the monthly allotment consumed (0-100). */
  readonly percent: number;
  /** Plan tier label shown to the recipient (e.g. `free`, `starter`). */
  readonly tier: string;
  /** Deep link to the upgrade flow. */
  readonly upgradeUrl: string;
}

/** Heads-up that the workspace is approaching its plan limit. */
export function buildQuotaWarningEmail(opts: QuotaWarningEmailOptions): RenderedEmail {
  const subject = `You've used ${opts.percent}% of your ${opts.tier} quota`;
  const html = wrap(
    'Veritrail',
    `Approaching your ${opts.tier} limit`,
    `<p>Your workspace has used <strong>${opts.percent}%</strong> of the events included in the <strong>${escapeHtml(opts.tier)}</strong> plan this month.</p>` +
      `<p>To avoid throttling, consider upgrading:</p>` +
      `<p><a href="${escapeHtml(opts.upgradeUrl)}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;text-decoration:none;border-radius:6px">Upgrade plan</a></p>` +
      `<p>Or view options at <span style="color:#444">${escapeHtml(opts.upgradeUrl)}</span>.</p>`,
  );
  const text =
    `You've used ${opts.percent}% of your ${opts.tier} quota this month.\n\n` +
    `Upgrade to avoid throttling: ${opts.upgradeUrl}\n`;
  return { subject, html, text };
}

/** Options for `buildBillingReceiptEmail`. */
export interface BillingReceiptEmailOptions {
  /** Amount charged, in USD minor units (cents). */
  readonly amountUsdMinor: number;
  /** End of the billing period the charge covers (ISO-8601 date or label). */
  readonly periodEnd: string;
  /** Link to the hosted invoice / receipt PDF. */
  readonly invoiceUrl: string;
}

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

/** Format minor units (cents) as a USD currency string like `$12.34`. */
export function formatUsdMinor(amountUsdMinor: number): string {
  return usdFormatter.format(amountUsdMinor / 100);
}

/** Receipt confirming a successful subscription charge. */
export function buildBillingReceiptEmail(opts: BillingReceiptEmailOptions): RenderedEmail {
  const amount = formatUsdMinor(opts.amountUsdMinor);
  const subject = `Your Veritrail receipt: ${amount}`;
  const html = wrap(
    'Veritrail',
    'Payment received',
    `<p>We charged <strong>${escapeHtml(amount)}</strong> for the period ending <strong>${escapeHtml(opts.periodEnd)}</strong>. Thanks for using Veritrail.</p>` +
      `<p><a href="${escapeHtml(opts.invoiceUrl)}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;text-decoration:none;border-radius:6px">View invoice</a></p>` +
      `<p><span style="color:#444">${escapeHtml(opts.invoiceUrl)}</span></p>`,
  );
  const text =
    `Payment received: ${amount} for period ending ${opts.periodEnd}.\n\n` +
    `View invoice: ${opts.invoiceUrl}\n`;
  return { subject, html, text };
}
