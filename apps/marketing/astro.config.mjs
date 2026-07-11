import { defineConfig } from 'astro/config';

// Hybrid output: most pages prerender to static HTML, but individual pages
// (e.g. /agent/[id]) can opt into server-side rendering via
// `export const prerender = false` to fetch live data from the Veritrail API
// on each request.
export default defineConfig({
  output: 'hybrid',
  site: 'https://veritrail.io',
});
