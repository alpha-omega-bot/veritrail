// Small presentation helpers shared across views.

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const DATE_TIME = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatUsd(value: number): string {
  return USD.format(value);
}

export function formatDateTime(iso: string | null): string {
  if (iso === null) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return DATE_TIME.format(d);
}

/**
 * Format a timestamp with relative time for recent events.
 * Shows relative time (e.g., "2 minutes ago") for events within the last hour,
 * otherwise shows absolute date/time.
 */
export function formatDateTimeRelative(iso: string | null): string {
  if (iso === null) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;

  const now = Date.now();
  const diff = now - d.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  return DATE_TIME.format(d);
}

/** Clamp a value to the inclusive [min, max] range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Shorten a long hex hash for display. */
export function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash;
}

/**
 * Format a large number with thousands separators.
 */
export function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * Format a percentage value.
 */
export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}
