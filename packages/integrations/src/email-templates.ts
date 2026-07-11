/**
 * Pre-built transactional email templates for product flows.
 *
 * Each template returns the trio Resend's API accepts: `subject`, `html`, and
 * a plain-text fallback. The plain-text version always renders any URL
 * verbatim so non-HTML mail clients (and security scanners) can extract it.
 */

import { formatResendEmail, type ResendEmailPayload } from './resend.js';

/** Rendered template ready to feed into `formatResendEmail`. */
export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

const escapeHtml = (raw: string): string =>
  raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const escapeAttr = (raw: string): string => escapeHtml(raw);

const wrap = (title: string, body: string): string =>
  `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:24px">` +
  `<h1 style="font-size:18px;margin:0 0 16px">${escapeHtml(title)}</h1>` +
  body +
  `<p style="font-size:12px;color:#666;margin-top:32px">Sent by Veritrail</p>` +
  `</body></html>`;

/** Convenience: render a template and pack it into a Resend payload. */
export function toResendPayload(
  to: string | readonly string[],
  template: RenderedEmail,
): ResendEmailPayload {
  return formatResendEmail({
    to,
    subject: template.subject,
    html: template.html,
    text: template.text,
  });
}

/** Options for `welcomeEmail`. */
export interface WelcomeEmailOptions {
  readonly name?: string;
  readonly consoleUrl: string;
}

/**
 * Welcome message sent after signup. Falls back to a generic greeting when no
 * name is supplied.
 */
export function welcomeEmail(opts: WelcomeEmailOptions): RenderedEmail {
  const display = opts.name !== undefined && opts.name.length > 0 ? opts.name : 'there';
  const subject = 'Welcome to Veritrail';
  const html = wrap(
    `Welcome, ${display}`,
    `<p>Thanks for joining Veritrail. Your control plane is ready.</p>` +
      `<p><a href="${escapeAttr(opts.consoleUrl)}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;text-decoration:none;border-radius:6px">Open console</a></p>` +
      `<p>Or paste this link into your browser:<br/><span style="color:#444">${escapeHtml(opts.consoleUrl)}</span></p>`,
  );
  const text =
    `Welcome, ${display}.\n\n` +
    `Thanks for joining Veritrail. Your control plane is ready.\n\n` +
    `Open the console: ${opts.consoleUrl}\n`;
  return { subject, html, text };
}

/** Options for `magicLinkEmail`. */
export interface MagicLinkEmailOptions {
  readonly link: string;
  readonly expiresInMinutes: number;
}

/** Single-use sign-in link with an explicit expiration window. */
export function magicLinkEmail(opts: MagicLinkEmailOptions): RenderedEmail {
  const subject = 'Your Veritrail sign-in link';
  const html = wrap(
    `Sign in to Veritrail`,
    `<p>Use the button below to sign in. This link expires in ${opts.expiresInMinutes} minutes and works once.</p>` +
      `<p><a href="${escapeAttr(opts.link)}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;text-decoration:none;border-radius:6px">Sign in</a></p>` +
      `<p>If the button doesn't work, paste this URL into your browser:<br/><span style="color:#444">${escapeHtml(opts.link)}</span></p>` +
      `<p style="font-size:12px;color:#666">Didn't request this? You can ignore the email.</p>`,
  );
  const text =
    `Sign in to Veritrail.\n\n` +
    `Use this link (expires in ${opts.expiresInMinutes} minutes, single use):\n${opts.link}\n\n` +
    `Didn't request this? You can ignore the email.\n`;
  return { subject, html, text };
}

/** Options for `quotaWarningEmail`. */
export interface QuotaWarningEmailOptions {
  readonly percent: number;
  readonly tier: string;
  readonly upgradeUrl: string;
}

/** Heads-up that the account is approaching a plan limit. */
export function quotaWarningEmail(opts: QuotaWarningEmailOptions): RenderedEmail {
  const subject = `You've used ${opts.percent}% of your ${opts.tier} quota`;
  const html = wrap(
    `Approaching your ${escapeHtml(opts.tier)} limit`,
    `<p>Your workspace has used <strong>${opts.percent}%</strong> of the events included in the <strong>${escapeHtml(opts.tier)}</strong> plan this month.</p>` +
      `<p>To avoid throttling, consider upgrading:</p>` +
      `<p><a href="${escapeAttr(opts.upgradeUrl)}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;text-decoration:none;border-radius:6px">Upgrade plan</a></p>` +
      `<p>Or view options at <span style="color:#444">${escapeHtml(opts.upgradeUrl)}</span>.</p>`,
  );
  const text =
    `You've used ${opts.percent}% of your ${opts.tier} quota this month.\n\n` +
    `Upgrade to avoid throttling: ${opts.upgradeUrl}\n`;
  return { subject, html, text };
}

/** Options for `vendorRiskAlertEmail`. */
export interface VendorRiskAlertEmailOptions {
  readonly vendorName: string;
  readonly score: number;
  readonly band: string;
  readonly consoleUrl: string;
}

/** Alert that a tracked vendor crossed into a higher risk band. */
export function vendorRiskAlertEmail(opts: VendorRiskAlertEmailOptions): RenderedEmail {
  const subject = `Vendor risk: ${opts.vendorName} is now ${opts.band}`;
  const html = wrap(
    `Vendor risk alert`,
    `<p><strong>${escapeHtml(opts.vendorName)}</strong> moved to the <strong>${escapeHtml(opts.band)}</strong> risk band (score ${opts.score}).</p>` +
      `<p>Review evidence and recent signals in the console:</p>` +
      `<p><a href="${escapeAttr(opts.consoleUrl)}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;text-decoration:none;border-radius:6px">Open vendor risk</a></p>` +
      `<p><span style="color:#444">${escapeHtml(opts.consoleUrl)}</span></p>`,
  );
  const text =
    `Vendor risk alert: ${opts.vendorName} is now ${opts.band} (score ${opts.score}).\n\n` +
    `Review in the console: ${opts.consoleUrl}\n`;
  return { subject, html, text };
}

/** Options for `billingReceiptEmail`. */
export interface BillingReceiptEmailOptions {
  readonly amount: string;
  readonly periodEnd: string;
  readonly invoiceUrl: string;
}

/** Receipt confirming a successful subscription charge. */
export function billingReceiptEmail(opts: BillingReceiptEmailOptions): RenderedEmail {
  const subject = `Your Veritrail receipt: ${opts.amount}`;
  const html = wrap(
    `Payment received`,
    `<p>We charged <strong>${escapeHtml(opts.amount)}</strong> for the period ending <strong>${escapeHtml(opts.periodEnd)}</strong>. Thanks for using Veritrail.</p>` +
      `<p><a href="${escapeAttr(opts.invoiceUrl)}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;text-decoration:none;border-radius:6px">View invoice</a></p>` +
      `<p><span style="color:#444">${escapeHtml(opts.invoiceUrl)}</span></p>`,
  );
  const text =
    `Payment received: ${opts.amount} for period ending ${opts.periodEnd}.\n\n` +
    `View invoice: ${opts.invoiceUrl}\n`;
  return { subject, html, text };
}
