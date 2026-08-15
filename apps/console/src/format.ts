// Presentation helpers shared across views.
//
// Two API conventions drive everything here: timestamps are epoch-millisecond
// numbers, and money is integer minor units plus an ISO-4217 currency code.

import type { Money } from './types.ts';

/** Placeholder rendered wherever the API legitimately has no value. */
export const EMPTY = '—';

const currencyFormatters = new Map<string, Intl.NumberFormat>();

function currencyFormatter(currency: string): Intl.NumberFormat | null {
  const cached = currencyFormatters.get(currency);
  if (cached !== undefined) return cached;
  try {
    const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency });
    currencyFormatters.set(currency, formatter);
    return formatter;
  } catch {
    // Unknown or malformed currency code — caller falls back to a plain render.
    return null;
  }
}

/**
 * Number of decimal places a currency's minor units occupy (2 for USD, 0 for
 * JPY). Derived from Intl so we do not hard-code an exponent table.
 */
function minorUnitDigits(formatter: Intl.NumberFormat): number {
  return formatter.resolvedOptions().maximumFractionDigits ?? 2;
}

/**
 * Format an API {@link Money} value. Converts integer minor units to major units
 * using the currency's own exponent, so 164018 USD minor units renders as
 * `$1,640.18` while 5000 JPY renders as `¥5,000`.
 */
export function formatMoney(money: Money | null | undefined): string {
  if (money === null || money === undefined) return EMPTY;
  const formatter = currencyFormatter(money.currency);
  if (formatter === null) {
    return `${money.amountMinor} ${money.currency}`;
  }
  const major = money.amountMinor / 10 ** minorUnitDigits(formatter);
  return formatter.format(major);
}

/** True when a money value is strictly negative. */
export function isNegative(money: Money | null | undefined): boolean {
  return money !== null && money !== undefined && money.amountMinor < 0;
}

/**
 * Percentage of a budget consumed, clamped to [0, 100] for progress rendering.
 * Returns 0 for a zero or negative limit rather than dividing by zero.
 */
export function usagePercent(spent: Money, limit: Money): number {
  if (limit.amountMinor <= 0) return 0;
  return clamp((spent.amountMinor / limit.amountMinor) * 100, 0, 100);
}

/** Format an epoch-millisecond timestamp for display. */
export function formatDateTime(epochMs: number | null | undefined): string {
  if (epochMs === null || epochMs === undefined) return EMPTY;
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return EMPTY;
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Format a duration in milliseconds as a compact human string. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return EMPTY;
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Format an integer with thousands separators. */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/** Clamp a value to the inclusive [min, max] range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Shorten a long hex hash for display, preserving both ends. */
export function shortHash(hash: string | null | undefined): string {
  if (hash === null || hash === undefined || hash.length === 0) return EMPTY;
  return hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash;
}

/** Render a label map as a stable, compact `key=value` list. */
export function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return EMPTY;
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}
