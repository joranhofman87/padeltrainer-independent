import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL") || Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY")!;
const BASE = `${SUPABASE_URL}/functions/v1/render-page`;

async function fetchPage(path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${BASE}?path=${encodeURIComponent(path)}`, {
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  const body = await res.text();
  return { status: res.status, body };
}

Deno.test("render-page: homepage returns HTML with meta tags", async () => {
  const { status, body } = await fetchPage("/nl");
  assertEquals(status, 200);
  assertStringIncludes(body, '<title>');
  assertStringIncludes(body, '<meta name="description"');
  assertStringIncludes(body, 'hreflang');
  assertStringIncludes(body, 'padeltrainer.ai');
});

Deno.test("render-page: trainer profile has correct meta", async () => {
  const { status, body } = await fetchPage("/en/trainer/john-doe");
  assertEquals(status, 200);
  assertStringIncludes(body, '<title>');
  assertStringIncludes(body, 'Padel Trainer');
  assertStringIncludes(body, 'canonical');
});

Deno.test("render-page: city trainers page", async () => {
  const { status, body } = await fetchPage("/nl/trainers/amsterdam");
  assertEquals(status, 200);
  assertStringIncludes(body, 'Amsterdam');
  assertStringIncludes(body, '<h1>');
});

Deno.test("render-page: location page", async () => {
  const { status, body } = await fetchPage("/en/padel/test-club");
  assertEquals(status, 200);
  assertStringIncludes(body, '<title>');
  assertStringIncludes(body, 'canonical');
});

Deno.test("render-page: region/province page", async () => {
  const { status, body } = await fetchPage("/nl/trainers/region/noord-holland");
  assertEquals(status, 200);
  assertStringIncludes(body, 'Noord Holland');
});

Deno.test("render-page: tools page", async () => {
  const { status, body } = await fetchPage("/en/tools/padel-level-test");
  assertEquals(status, 200);
  assertStringIncludes(body, '<title>');
});

Deno.test("render-page: unknown route returns fallback", async () => {
  const { status, body } = await fetchPage("/en/nonexistent-page-xyz");
  assertEquals(status, 200);
  assertStringIncludes(body, '<title>');
  assertStringIncludes(body, 'PadelTrainer');
});

Deno.test("render-page: all 5 languages produce valid HTML", async () => {
  for (const lang of ['en', 'nl', 'es', 'de', 'fr']) {
    const { status, body } = await fetchPage(`/${lang}`);
    assertEquals(status, 200);
    assertStringIncludes(body, '<!DOCTYPE html>');
    assertStringIncludes(body, `hreflang="${lang}"`);
  }
});
