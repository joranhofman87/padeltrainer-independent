import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL") || Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY")!;
const BASE = `${SUPABASE_URL}/functions/v1/sitemap`;

async function fetchSitemap(params: string): Promise<Response> {
  const res = await fetch(`${BASE}?${params}`, {
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  return res;
}

Deno.test("sitemap index returns valid XML with sub-sitemaps", async () => {
  const res = await fetchSitemap("type=index");
  assertEquals(res.status, 200);
  const body = await res.text();
  assertStringIncludes(body, '<?xml version="1.0"');
  assertStringIncludes(body, '<sitemapindex');
  assertStringIncludes(body, 'sitemap-static.xml');
  assertStringIncludes(body, 'sitemap-provinces.xml');
  assertStringIncludes(body, 'sitemap-content.xml');
});

Deno.test("sitemap static contains correct tool paths", async () => {
  const res = await fetchSitemap("type=static");
  assertEquals(res.status, 200);
  const body = await res.text();
  assertStringIncludes(body, '<urlset');
  assertStringIncludes(body, '/tools/padel-level-test');
  // Should NOT have the old wrong path
  const wrongPathCount = (body.match(/\/padel-level-test/g) || []).length;
  const correctPathCount = (body.match(/\/tools\/padel-level-test/g) || []).length;
  assertEquals(wrongPathCount, correctPathCount, "All padel-level-test paths should be under /tools/");
});

Deno.test("sitemap static has hreflang tags", async () => {
  const res = await fetchSitemap("type=static");
  const body = await res.text();
  assertStringIncludes(body, 'xhtml:link rel="alternate" hreflang="nl"');
  assertStringIncludes(body, 'xhtml:link rel="alternate" hreflang="en"');
  assertStringIncludes(body, 'xhtml:link rel="alternate" hreflang="es"');
  assertStringIncludes(body, 'xhtml:link rel="alternate" hreflang="de"');
  assertStringIncludes(body, 'xhtml:link rel="alternate" hreflang="fr"');
  assertStringIncludes(body, 'hreflang="x-default"');
});

Deno.test("sitemap locations page 1 returns valid XML", async () => {
  const res = await fetchSitemap("type=locations&page=1");
  assertEquals(res.status, 200);
  const body = await res.text();
  assertStringIncludes(body, '<urlset');
  assertStringIncludes(body, '<url>');
  assertStringIncludes(body, '/padel/');
});

Deno.test("sitemap provinces returns valid XML", async () => {
  const res = await fetchSitemap("type=provinces");
  assertEquals(res.status, 200);
  const body = await res.text();
  assertStringIncludes(body, '<urlset');
  assertStringIncludes(body, '/trainers/region/');
});

Deno.test("sitemap content returns valid XML", async () => {
  const res = await fetchSitemap("type=content");
  assertEquals(res.status, 200);
  const body = await res.text();
  assertStringIncludes(body, '<?xml version="1.0"');
});
