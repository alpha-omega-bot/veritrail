import type { VendorSignal } from '@veritrail/core';

import { ProviderMonitorError } from './errors.js';

export interface AdvisoryFeedOptions {
  /** Vendor id this monitor tracks. */
  readonly vendorId: string;
  /** RSS or Atom feed URL (e.g., a CVE feed, security advisory feed). */
  readonly url: string;
  /** Optional fetch-compatible client. Defaults to global fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Transform parsed feed entries into vendor signals. Receives an array of
   * entries with `title`, `link`, and `published` fields; must return signals.
   * Throw `ProviderMonitorError` on malformed feeds.
   */
  readonly transform: (entries: AdvisoryFeedEntry[]) => VendorSignal[];
}

export interface AdvisoryFeedEntry {
  readonly title: string;
  readonly link?: string;
  readonly published?: string;
}

/**
 * RSS/Atom advisory feed monitor. Fetches an XML feed (e.g., CVE advisories,
 * security bulletins), parses basic entry metadata (title, link, date), and
 * maps each entry into a vendor signal via a deployment-supplied transform.
 *
 * Example:
 * ```ts
 * const monitor = new AdvisoryFeedMonitor({
 *   vendorId: 'ven_openssl',
 *   url: 'https://www.openssl.org/news/vulnerabilities.rss',
 *   transform: (entries) => entries.map((entry) => ({
 *     id: `sig_openssl_cve_${Date.now()}`,
 *     vendorId: 'ven_openssl',
 *     kind: 'breach',
 *     severity: entry.title.includes('HIGH') ? 'high' : 'medium',
 *     summary: entry.title,
 *     source: entry.link ?? 'https://www.openssl.org',
 *   })),
 * });
 * ```
 */
export class AdvisoryFeedMonitor {
  readonly name: string;
  readonly #url: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #transform: (entries: AdvisoryFeedEntry[]) => VendorSignal[];

  constructor(options: AdvisoryFeedOptions) {
    this.name = `advisory-feed:${options.vendorId}`;
    this.#url = options.url;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#transform = options.transform;
  }

  async poll(): Promise<VendorSignal[]> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url);
    } catch (cause) {
      throw new ProviderMonitorError(
        this.name,
        `fetch failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    if (!response.ok) {
      throw new ProviderMonitorError(this.name, `HTTP ${response.status} ${response.statusText}`);
    }

    let xml: string;
    try {
      xml = await response.text();
    } catch (cause) {
      throw new ProviderMonitorError(
        this.name,
        `response text failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    const entries = this.#parseBasicFeed(xml);

    try {
      return this.#transform(entries);
    } catch (cause) {
      if (cause instanceof ProviderMonitorError) throw cause;
      throw new ProviderMonitorError(
        this.name,
        `transform failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  /**
   * Minimal XML parsing for RSS/Atom feeds without external dependencies.
   * Extracts `<item>` or `<entry>` titles, links, and publish dates using regex.
   * For production deployments with complex feeds, use a real XML parser.
   */
  #parseBasicFeed(xml: string): AdvisoryFeedEntry[] {
    const entries: AdvisoryFeedEntry[] = [];
    const isAtom = xml.includes('<feed') && xml.includes('xmlns="http://www.w3.org/2005/Atom"');
    const itemPattern = isAtom
      ? /<entry[^>]*>([\s\S]*?)<\/entry>/gi
      : /<item[^>]*>([\s\S]*?)<\/item>/gi;

    let match: RegExpExecArray | null;
    while ((match = itemPattern.exec(xml)) !== null) {
      const itemXml = match[1];
      if (!itemXml) continue;

      const title = this.#extractText(itemXml, 'title');
      if (!title) continue;

      const link = isAtom ? this.#extractAtomLink(itemXml) : this.#extractText(itemXml, 'link');
      const published = isAtom
        ? this.#extractText(itemXml, 'updated') || this.#extractText(itemXml, 'published')
        : this.#extractText(itemXml, 'pubDate');

      entries.push({
        title,
        ...(link !== undefined ? { link } : {}),
        ...(published !== undefined ? { published } : {}),
      });
    }

    return entries;
  }

  #extractText(xml: string, tag: string): string | undefined {
    const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const match = pattern.exec(xml);
    return match?.[1]?.trim();
  }

  #extractAtomLink(xml: string): string | undefined {
    const pattern = /<link[^>]*\shref=["']([^"']+)["'][^>]*>/i;
    const match = pattern.exec(xml);
    return match?.[1]?.trim();
  }
}
