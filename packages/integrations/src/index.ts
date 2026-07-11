/**
 * @veritrail/integrations
 *
 * Built-in destination adapters consumed by the Veritrail webhook-worker.
 * Each adapter is a pure formatter plus a thin `deliver*` function that
 * POSTs the formatted payload over `fetch`. A test-time `fetchImpl` can be
 * injected so adapter behavior is verifiable without hitting the network.
 *
 * Plus a set of pre-built transactional email templates used by the control
 * plane (welcome, magic link, quota warning, vendor risk alert, billing
 * receipt) so product flows render consistent HTML + plain-text mail.
 */

export type { NotificationEvent, NotificationSeverity, FetchImpl } from './types.js';

export {
  formatSlackMessage,
  deliverSlack,
  type SlackFormatOptions,
  type SlackPayload,
  type SlackBlock,
  type SlackTextObject,
  type SlackButtonElement,
  type DeliverSlackOptions,
} from './slack.js';

export {
  formatPagerDutyEvent,
  deliverPagerDuty,
  mapPagerDutySeverity,
  PAGERDUTY_EVENTS_ENDPOINT,
  type PagerDutyAction,
  type PagerDutySeverity,
  type PagerDutyFormatOptions,
  type PagerDutyPayload,
  type DeliverPagerDutyOptions,
} from './pagerduty.js';

export {
  formatResendEmail,
  deliverResend,
  RESEND_EMAIL_ENDPOINT,
  type ResendEmailInput,
  type ResendEmailPayload,
  type DeliverResendOptions,
} from './resend.js';

export {
  welcomeEmail,
  magicLinkEmail,
  quotaWarningEmail,
  vendorRiskAlertEmail,
  billingReceiptEmail,
  toResendPayload,
  type RenderedEmail,
  type WelcomeEmailOptions,
  type MagicLinkEmailOptions,
  type QuotaWarningEmailOptions,
  type VendorRiskAlertEmailOptions,
  type BillingReceiptEmailOptions,
} from './email-templates.js';
