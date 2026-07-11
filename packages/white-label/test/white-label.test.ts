import { describe, expect, it } from 'vitest';

import {
  applyBrandCss,
  defaultBrand,
  EXAMPLE_BRANDS,
  loadBrandFromHostname,
  type PartnerBrand,
} from '../src/index.js';

describe('defaultBrand', () => {
  it('returns the canonical Veritrail brand', () => {
    const brand = defaultBrand();
    expect(brand.partnerId).toBe('veritrail');
    expect(brand.displayName).toBe('Veritrail');
    expect(brand.poweredByVeritrail).toBe(false);
    expect(brand.primaryColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(brand.secondaryColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
});

describe('loadBrandFromHostname', () => {
  it('matches a registered partner by subdomain', () => {
    const brand = loadBrandFromHostname('langchain.veritrail.io', EXAMPLE_BRANDS);
    expect(brand).not.toBeNull();
    expect(brand?.partnerId).toBe('langchain');
    expect(brand?.displayName).toBe('LangChain Trust');
  });

  it('returns null when no subdomain matches', () => {
    const brand = loadBrandFromHostname('unknown.example.com', EXAMPLE_BRANDS);
    expect(brand).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(loadBrandFromHostname('', EXAMPLE_BRANDS)).toBeNull();
    expect(loadBrandFromHostname('   ', EXAMPLE_BRANDS)).toBeNull();
  });

  it('handles hostnames with a port', () => {
    const brand = loadBrandFromHostname('autogen.veritrail.io:8080', EXAMPLE_BRANDS);
    expect(brand).not.toBeNull();
    expect(brand?.partnerId).toBe('autogen');
  });

  it('is case-insensitive when matching the subdomain', () => {
    const brand = loadBrandFromHostname('N8N.Veritrail.IO', EXAMPLE_BRANDS);
    expect(brand?.partnerId).toBe('n8n');
  });

  it('returns null when the brand list is empty', () => {
    expect(loadBrandFromHostname('langchain.veritrail.io', [])).toBeNull();
  });
});

describe('applyBrandCss', () => {
  it('emits a :root block containing every brand variable', () => {
    const css = applyBrandCss(defaultBrand());
    expect(css.startsWith(':root {')).toBe(true);
    expect(css.trimEnd().endsWith('}')).toBe(true);
    expect(css).toContain('--brand-id: "veritrail"');
    expect(css).toContain('--brand-name: "Veritrail"');
    expect(css).toContain('--brand-primary: #0B5FFF');
    expect(css).toContain('--brand-secondary: #0A2540');
    expect(css).toContain('--brand-support-url: "https://veritrail.io/support"');
    expect(css).toContain('--brand-logo: url("https://veritrail.io/assets/veritrail-logo.svg")');
    expect(css).toContain('--brand-powered-by: 0');
  });

  it('encodes poweredByVeritrail=true as 1', () => {
    const partner: PartnerBrand = {
      partnerId: 'demo',
      displayName: 'Demo Co',
      logoUrl: 'https://demo.example.com/logo.svg',
      primaryColor: '#112233',
      secondaryColor: '#445566',
      supportUrl: 'https://demo.example.com/help',
      poweredByVeritrail: true,
    };
    expect(applyBrandCss(partner)).toContain('--brand-powered-by: 1');
  });
});

describe('EXAMPLE_BRANDS', () => {
  it('ships exactly the three documented partners', () => {
    expect(EXAMPLE_BRANDS).toHaveLength(3);
    const ids = EXAMPLE_BRANDS.map((b) => b.partnerId);
    expect(ids).toEqual(['langchain', 'autogen', 'n8n']);
  });

  it('every example brand has a 7-character hex primary and secondary colour', () => {
    for (const brand of EXAMPLE_BRANDS) {
      expect(brand.primaryColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(brand.secondaryColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(brand.logoUrl.startsWith('https://')).toBe(true);
      expect(brand.supportUrl.startsWith('https://')).toBe(true);
    }
  });
});
