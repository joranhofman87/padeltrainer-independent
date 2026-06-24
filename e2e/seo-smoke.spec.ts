import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * Production SEO smoke test — guards the post-Lovable crawl/indexing contract against the
 * bot-prerender regressions the migration introduced.
 *
 * Read-only: it only issues GETs to the live site as Googlebot (the render-page + sitemap
 * edge functions are read-only — no side-effecting function is invoked).
 *
 * Opt-in: set SEO_SMOKE_BASE_URL (e.g. https://padeltrainer.ai) to run it. Unset → skipped,
 * so unrelated PR CI never hits production. Run on demand or from a scheduled SEO job:
 *   SEO_SMOKE_BASE_URL=https://padeltrainer.ai npx playwright test e2e/seo-smoke.spec.ts
 */
const BASE = process.env.SEO_SMOKE_BASE_URL?.replace(/\/$/, '');
const GOOGLEBOT =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const FALLBACK_MARKERS = ['padeltrainer-static-fallback', 'padeltrainer-unavailable'];

// The Cloudflare worker rate-limits bot prerenders to ~2 requests / 10s per IP. Pace each
// page fetch so the smoke test measures real prerender behaviour, not the rate-limit fallback.
const PACE_MS = 6000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const asBot = async (request: APIRequestContext, path: string, paced = true) => {
  if (paced) await sleep(PACE_MS);
  return request.get(`${BASE}${path}`, {
    headers: { 'User-Agent': GOOGLEBOT },
    maxRedirects: 0,
    failOnStatusCode: false,
  });
};

const locs = (xml: string) =>
  [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
const titleOf = (html: string) => html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() ?? '';
const canonicalOf = (html: string) =>
  html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i)?.[0]?.match(/href=["']([^"']+)["']/i)?.[1] ?? '';

test.describe('Production SEO crawl/indexing contract', () => {
  // Serial: the worker's per-IP bot rate limit is shared across parallel workers, so running
  // these concurrently would trip it and yield fallbacks.
  test.describe.configure({ mode: 'serial', timeout: 90_000 });
  test.skip(!BASE, 'Set SEO_SMOKE_BASE_URL (e.g. https://padeltrainer.ai) to run the SEO smoke test.');

  test('the homepage is prerendered with a self-canonical and hreflang', async ({ request }) => {
    const res = await asBot(request, '/en/');
    expect(res.status()).toBe(200);
    expect(FALLBACK_MARKERS).not.toContain(res.headers()['x-rendered-by']);
    const html = await res.text();
    expect(titleOf(html).length).toBeGreaterThan(0);
    expect(canonicalOf(html)).toMatch(/^https?:\/\/[^/]+\/en\/?$/);
    expect(html).toMatch(/rel=["']alternate["'][^>]+hreflang=/i);
  });

  test('sampled live sitemap URLs are indexable prerenders (status/title/canonical/hreflang)', async ({ request }) => {
    // Walk the sitemap index → one content sub-sitemap → sample a few real URLs.
    const index = await request.get(`${BASE}/sitemap.xml`, { headers: { 'User-Agent': GOOGLEBOT } });
    expect(index.status(), 'sitemap index must serve 200').toBe(200);
    const subSitemaps = locs(await index.text());
    expect(subSitemaps.length, 'sitemap index must list sub-sitemaps').toBeGreaterThan(0);

    const contentMap =
      subSitemaps.find((u) => /sitemap-(content|static)/.test(u)) ?? subSitemaps[0];
    const sub = await request.get(contentMap, { headers: { 'User-Agent': GOOGLEBOT } });
    expect(sub.status()).toBe(200);
    const urls = locs(await sub.text());
    expect(urls.length, 'sub-sitemap must contain URLs').toBeGreaterThan(0);

    // Deterministic sample (first few) so the test never flakes on randomness; small + paced
    // to stay under the worker's bot rate limit.
    const sample = urls.slice(0, 3);
    for (const url of sample) {
      const path = new URL(url).pathname;
      const res = await asBot(request, path);
      expect(res.status(), `${path} should be 200`).toBe(200);
      expect(
        FALLBACK_MARKERS,
        `${path} must be a real prerender, not the static/unavailable fallback`,
      ).not.toContain(res.headers()['x-rendered-by']);

      const html = await res.text();
      expect(titleOf(html).length, `${path} must have a non-empty <title>`).toBeGreaterThan(0);

      // Canonical must point at THIS page (its host + path), not a generic homepage canonical.
      const canonical = canonicalOf(html);
      expect(canonical, `${path} must have a canonical`).not.toBe('');
      const canonicalPath = new URL(canonical).pathname.replace(/\/$/, '');
      expect(canonicalPath, `${path} canonical should match the requested page`).toBe(path.replace(/\/$/, ''));

      // hreflang alternates expected on public localized pages.
      expect(html, `${path} should expose hreflang alternates`).toMatch(/rel=["']alternate["'][^>]+hreflang=/i);
    }
  });

  // Runs last: this is the regression that needs the Cloudflare worker fix DEPLOYED to pass.
  // Until then it (correctly) fails, documenting the pending deploy without blocking the
  // valid-page checks above.
  test('a nonexistent public URL returns 404 to Googlebot (never a 200 soft-404)', async ({ request }) => {
    const path = '/en/this-page-should-not-exist-seo-smoke-deterministic';
    const res = await asBot(request, path);
    expect(res.status(), `${path} must be a hard 404, not a 200/302 fallback`).toBe(404);
    // Must NOT be served by the generic static fallback / unavailable page.
    expect(FALLBACK_MARKERS).not.toContain(res.headers()['x-rendered-by']);
  });
});
