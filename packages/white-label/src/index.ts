/**
 * @veritrail/white-label
 *
 * White-label / reseller mode for the Veritrail console.
 *
 * Agent framework vendors (LangChain, n8n, Autogen, and others) can ship
 * Veritrail under their own brand by registering a `PartnerBrand` keyed by
 * subdomain. The console resolves the active brand from `window.location`
 * at boot, swaps in the partner's logo, palette, and support URL via CSS
 * custom properties, and optionally renders a "Powered by Veritrail"
 * footer for partners that want to keep attribution.
 *
 * The module is pure data and pure functions: no I/O, no global state,
 * no runtime dependencies. It can be imported by both the browser console
 * and the server (e.g. for SSR or hostname-based config endpoints) without
 * pulling in @veritrail/core.
 */

/**
 * Visual identity and metadata for a single reseller / white-label partner.
 *
 * All fields are required so the console never has to fall back to a
 * partial brand mid-render. Use {@link defaultBrand} to start from the
 * canonical Veritrail palette when authoring a new partner.
 */
export interface PartnerBrand {
  /** Lowercase subdomain slug, e.g. `"langchain"` for `langchain.veritrail.io`. */
  readonly partnerId: string;
  /** Public-facing product name shown in the header and document title. */
  readonly displayName: string;
  /** Absolute URL of the partner's logo (PNG or SVG). Used in the top navigation. */
  readonly logoUrl: string;
  /** Primary brand colour as a 7-character hex string (e.g. `#1F6FEB`). */
  readonly primaryColor: string;
  /** Secondary / accent brand colour as a 7-character hex string. */
  readonly secondaryColor: string;
  /** URL the "Support" link in the console footer points to. */
  readonly supportUrl: string;
  /** When `true` the console renders a "Powered by Veritrail" footer below the partner brand. */
  readonly poweredByVeritrail: boolean;
}

/** The canonical Veritrail brand. Used when no partner subdomain matches. */
const VERITRAIL_BRAND: PartnerBrand = {
  partnerId: 'veritrail',
  displayName: 'Veritrail',
  logoUrl: 'https://veritrail.io/assets/veritrail-logo.svg',
  primaryColor: '#0B5FFF',
  secondaryColor: '#0A2540',
  supportUrl: 'https://veritrail.io/support',
  poweredByVeritrail: false,
};

/**
 * Three sample partners shipped with the package to demonstrate the
 * white-label surface and to back the console's preview / docs pages.
 *
 * Real deployments load partners from configuration rather than this list.
 */
export const EXAMPLE_BRANDS: ReadonlyArray<PartnerBrand> = [
  {
    partnerId: 'langchain',
    displayName: 'LangChain Trust',
    logoUrl: 'https://langchain.com/assets/logo.svg',
    primaryColor: '#1C3D5A',
    secondaryColor: '#2EBFA5',
    supportUrl: 'https://langchain.com/support',
    poweredByVeritrail: true,
  },
  {
    partnerId: 'autogen',
    displayName: 'AutoGen Audit',
    logoUrl: 'https://microsoft.github.io/autogen/assets/logo.svg',
    primaryColor: '#243A5A',
    secondaryColor: '#F2C811',
    supportUrl: 'https://microsoft.github.io/autogen/support',
    poweredByVeritrail: true,
  },
  {
    partnerId: 'n8n',
    displayName: 'n8n Guard',
    logoUrl: 'https://n8n.io/assets/logo.svg',
    primaryColor: '#EA4B71',
    secondaryColor: '#1A1A2E',
    supportUrl: 'https://n8n.io/support',
    poweredByVeritrail: false,
  },
];

/** Returns the canonical Veritrail brand. Stable identity; safe to compare by reference. */
export function defaultBrand(): PartnerBrand {
  return VERITRAIL_BRAND;
}

/**
 * Resolves the active {@link PartnerBrand} from an HTTP `Host` header value
 * or `window.location.hostname` by matching the leading subdomain against
 * each registered `partnerId`.
 *
 * The hostname may include a port (`langchain.veritrail.io:8080`) — the
 * port is stripped before matching. Matching is case-insensitive.
 *
 * Returns `null` when no partner matches; callers typically fall back to
 * {@link defaultBrand}. A separate `null` result lets the console
 * distinguish "unknown host" (log a warning) from "matched Veritrail".
 */
export function loadBrandFromHostname(
  hostname: string,
  brands: ReadonlyArray<PartnerBrand>,
): PartnerBrand | null {
  const normalized = hostname.trim().toLowerCase();
  if (normalized.length === 0) return null;

  const withoutPort = normalized.split(':', 1)[0] ?? '';
  const firstLabel = withoutPort.split('.', 1)[0] ?? '';
  if (firstLabel.length === 0) return null;

  for (const brand of brands) {
    if (brand.partnerId.toLowerCase() === firstLabel) return brand;
  }
  return null;
}

/**
 * Builds a `:root { --brand-*: ...; }` CSS block that the console injects
 * into a `<style>` tag at boot. Consumers reference the variables from
 * their stylesheets (`color: var(--brand-primary)`), which lets a brand
 * swap take effect without re-rendering React components.
 *
 * The output is deterministic and safe to embed directly — every value is
 * sourced from {@link PartnerBrand} fields, which are typed as strings and
 * are expected to be authored, never user-supplied. Callers that accept
 * partner config from untrusted input must validate fields before passing
 * the brand here.
 */
export function applyBrandCss(brand: PartnerBrand): string {
  return [
    ':root {',
    `  --brand-id: "${brand.partnerId}";`,
    `  --brand-name: "${brand.displayName}";`,
    `  --brand-logo: url("${brand.logoUrl}");`,
    `  --brand-primary: ${brand.primaryColor};`,
    `  --brand-secondary: ${brand.secondaryColor};`,
    `  --brand-support-url: "${brand.supportUrl}";`,
    `  --brand-powered-by: ${brand.poweredByVeritrail ? '1' : '0'};`,
    '}',
  ].join('\n');
}
