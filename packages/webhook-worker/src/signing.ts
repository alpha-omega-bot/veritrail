import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Sign a webhook payload with HMAC-SHA256. The resulting header looks like
 * `v1=<hex-sig>,t=<unix-seconds>`. Subscribers verify by recomputing the
 * HMAC over `${t}.${body}` and comparing in constant time.
 */
export function signPayload(
  secret: string,
  body: string,
  now: number = Date.now(),
): { header: string; signature: string; timestamp: number } {
  const ts = Math.floor(now / 1000);
  const signature = createHmac('sha256', secret).update(`${ts}.${body}`, 'utf8').digest('hex');
  return { header: `v1=${signature},t=${ts}`, signature, timestamp: ts };
}

/**
 * Counterpart to {@link signPayload}. Returns `true` only when the header is
 * well-formed, within `toleranceSeconds` of `nowMs`, and the signature
 * recomputes to the same value as the one in the header.
 */
export function verifySignature(
  secret: string,
  body: string,
  header: string,
  options: { toleranceSeconds?: number; nowMs?: number } = {},
): boolean {
  const tolerance = options.toleranceSeconds ?? 300;
  const nowMs = options.nowMs ?? Date.now();
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const idx = kv.indexOf('=');
      return idx > 0 ? [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()] : ['', ''];
    }),
  );
  const ts = Number(parts['t']);
  const v1 = parts['v1'];
  if (!Number.isFinite(ts) || !v1) return false;
  if (Math.abs(nowMs / 1000 - ts) > tolerance) return false;
  const expected = createHmac('sha256', secret).update(`${ts}.${body}`, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
