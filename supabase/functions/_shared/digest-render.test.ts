import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DIGEST_BYTE_BUDGET,
  isDigestRequestOversize,
  MANAGE_SETTINGS_URL,
  pgJsonbTextByteLength,
  renderDigestEmail,
  safeHttpsUrl,
  utf8Bytes,
} from "./digest-render.ts";

const FROM = "PadelTrainer.ai <noreply@app.padeltrainer.ai>";

Deno.test("single item → singular subject; the `to` passes through", () => {
  const out = renderDigestEmail({ from: FROM, to: "p@example.com", locale: "en", items: [{ title: "Booking confirmed" }] });
  assertEquals(out.to, "p@example.com");
  assertEquals(out.subject, "Your PadelTrainer update");
  assertStringIncludes(out.html, "Booking confirmed");
});

Deno.test("`from` (sender identity) is frozen into the request as one of exactly four keys", () => {
  const out = renderDigestEmail({ from: FROM, to: "p@example.com", items: [{ title: "x" }] });
  assertEquals(out.from, FROM);                                  // passed through verbatim (not HTML-escaped)
  assertEquals(Object.keys(out).sort().join(","), "from,html,subject,to"); // exactly the 4 frozen keys
});

Deno.test("multiple items → count in subject; each item rendered", () => {
  const out = renderDigestEmail({ from: FROM, to: "p@example.com", locale: "en", items: [{ title: "A" }, { title: "B" }, { title: "C" }] });
  assertEquals(out.subject, "Your PadelTrainer update (3 items)");
  for (const t of ["A", "B", "C"]) assertStringIncludes(out.html, t);
});

Deno.test("locale: nl copy, unknown locale falls back to English", () => {
  assertEquals(renderDigestEmail({ from: FROM, to: "p@x.com", locale: "nl", items: [{ title: "x" }] }).subject, "Je PadelTrainer-update");
  assertEquals(renderDigestEmail({ from: FROM, to: "p@x.com", locale: "fr", items: [{ title: "x" }] }).subject, "Your PadelTrainer update");
  assertEquals(renderDigestEmail({ from: FROM, to: "p@x.com", locale: null, items: [{ title: "x" }] }).subject, "Your PadelTrainer update");
});

Deno.test("HTML injection in item fields is escaped (no unescaped markup reaches the output)", () => {
  const out = renderDigestEmail({ from: FROM,
    to: "p@example.com",
    items: [{ title: `<script>alert(1)</script>`, body: `x" onload="y`, url: `javascript:evil()"` }],
  });
  assert(!out.html.includes("<script>"));
  assertStringIncludes(out.html, "&lt;script&gt;");
  assert(!out.html.includes(`onload="y`));
  // the javascript: URL is UNSAFE → the ITEM renders no link. The one href in the document is
  // the footer's own settings link (N2 S2b), which is a constant — so assert exactly one href,
  // and that it is that constant, rather than zero hrefs anywhere.
  const hrefs = out.html.match(/href="([^"]*)"/g) ?? [];
  assertEquals(hrefs, [`href="${MANAGE_SETTINGS_URL}"`], "unsafe scheme must not become a link");
  assert(!out.html.toLowerCase().includes("javascript:"));
});

Deno.test("URL scheme guard: only https: absolute links render; everything else omitted", () => {
  assertEquals(safeHttpsUrl("https://x.com/a"), "https://x.com/a");
  assertEquals(safeHttpsUrl("http://x.com/a"), null);        // plain http omitted
  assertEquals(safeHttpsUrl("javascript:alert(1)"), null);
  assertEquals(safeHttpsUrl("data:text/html,<x>"), null);
  assertEquals(safeHttpsUrl("//evil.com/a"), null);          // protocol-relative
  assertEquals(safeHttpsUrl("/relative"), null);
  assertEquals(safeHttpsUrl("not a url"), null);
  assertEquals(safeHttpsUrl(""), null);
  assertEquals(safeHttpsUrl(null), null);
  // an https URL flows into a real href
  const out = renderDigestEmail({ from: FROM, to: "p@x.com", items: [{ title: "t", url: "https://safe.example/x" }] });
  assertStringIncludes(out.html, `href="https://safe.example/x"`);
});

Deno.test("missing/partial fields degrade gracefully (no throw, placeholder title)", () => {
  const out = renderDigestEmail({ from: FROM, to: "p@example.com", items: [{}, { body: "just a body" }] });
  assertStringIncludes(out.html, "—");            // empty title → em-dash placeholder
  assertStringIncludes(out.html, "just a body");
});

Deno.test("NUL bytes are stripped from item content (jsonb-safe render; store can't choke)", () => {
  const out = renderDigestEmail({ from: FROM, to: "p@example.com", items: [{ title: "a\u0000b", body: "c\u0000d" }] });
  assert(!out.html.includes("\u0000"), "no NUL may reach the rendered html");
  assertStringIncludes(out.html, "ab");
  assertStringIncludes(out.html, "cd");
  // a valid emoji (surrogate PAIR) survives; a LONE high surrogate is dropped.
  const emoji = renderDigestEmail({ from: FROM, to: "p@example.com", items: [{ title: "ok \u{1F3BE} \uD800 lone" }] });
  assertStringIncludes(emoji.html, "\u{1F3BE}");           // the tennis-ball emoji is kept
  assert(!emoji.html.includes("\uD800"), "the lone surrogate is dropped");
});

Deno.test("oversize detection is byte-accurate against the store budget", () => {
  const small = renderDigestEmail({ from: FROM, to: "p@example.com", items: [{ title: "hi" }] });
  assertEquals(isDigestRequestOversize(small), false);
  const huge = renderDigestEmail({ from: FROM, to: "p@example.com", items: [{ title: "x".repeat(DIGEST_BYTE_BUDGET) }] });
  assertEquals(isDigestRequestOversize(huge), true);
  assert(utf8Bytes(JSON.stringify({ to: huge.to, subject: huge.subject, html: huge.html })) > DIGEST_BYTE_BUDGET);
});

Deno.test("pgJsonbTextByteLength adds the jsonb separator bytes over compact JSON (matches octet_length)", () => {
  // jsonb::text = {"key": value, ...} — vs compact {"key":value,...}. For an N-key object that is exactly
  // +(2N-1) bytes (N colon-spaces + (N-1) comma-spaces), which is why a JS compact measure strands a group.
  // The PRODUCTION frozen request is FOUR keys {from,to,subject,html} → +7.
  const req = { from: FROM, to: "p@x.com", subject: "hi", html: "<p>x</p>" };
  assertEquals(pgJsonbTextByteLength(req), utf8Bytes(JSON.stringify(req)) + 7);   // 4 keys → +7
  const three = { to: "p@x.com", subject: "hi", html: "<p>x</p>" };
  assertEquals(pgJsonbTextByteLength(three), utf8Bytes(JSON.stringify(three)) + 5); // 3 keys → +5 (the formula holds)
  // unicode / quotes / backslashes are byte-identical between JS and jsonb escaping — only ordering +
  // separators differ (verified byte-exactly against PostgreSQL in the real-PG parity test).
  const tricky = { from: FROM, to: "π@x.com", subject: `a"b\\c`, html: "ef/g" };
  assertEquals(pgJsonbTextByteLength(tricky), utf8Bytes(JSON.stringify(tricky)) + 7);
});

Deno.test("deterministic: same input → byte-identical output (stable request hash)", () => {
  const input = { from: FROM, to: "p@example.com", locale: "en", items: [{ title: "A", url: "https://x/1" }, { title: "B" }] };
  assertEquals(JSON.stringify(renderDigestEmail(input)), JSON.stringify(renderDigestEmail(input)));
});


// ── N2 S2b: the manage-preferences footer ────────────────────────────────────────────────────────

Deno.test("footer links the ROLE-AGNOSTIC settings entry in every render", () => {
  const out = renderDigestEmail({ from: FROM, to: "p@x.com", items: [{ title: "x" }] });
  assertStringIncludes(out.html, MANAGE_SETTINGS_URL);
  assertStringIncludes(out.html, "Manage email notifications");
  assertStringIncludes(out.html, "You&#39;re receiving this email from PadelTrainer.ai.");
});

Deno.test("footer copy follows the locale (nl), and the URL is locale-independent", () => {
  const out = renderDigestEmail({ from: FROM, to: "p@x.com", locale: "nl", items: [{ title: "x" }] });
  assertStringIncludes(out.html, MANAGE_SETTINGS_URL);
  assertStringIncludes(out.html, "E-mailmeldingen beheren");
  assertStringIncludes(out.html, "Je ontvangt deze e-mail van PadelTrainer.ai.");
});

Deno.test("the settings URL is the neutral route, not a role-guessed one", () => {
  // The role paths bounce anyone the layout does not admit; the footer must never emit them.
  assertEquals(MANAGE_SETTINGS_URL, "https://padeltrainer.ai/app/settings/notifications");
  const out = renderDigestEmail({ from: FROM, to: "p@x.com", items: [{ title: "x" }] });
  assert(!out.html.includes("/app/player/settings"), "player-guessed path leaked into the footer");
  assert(!out.html.includes("/app/trainer/settings"), "trainer-guessed path leaked into the footer");
});

Deno.test("footer bytes are COUNTED by the oversize measurement (it measures the final html)", () => {
  const out = renderDigestEmail({ from: FROM, to: "p@x.com", items: [{ title: "x" }] });
  const measured = pgJsonbTextByteLength({ from: out.from, to: out.to, subject: out.subject, html: out.html });
  const withoutFooter = pgJsonbTextByteLength({ from: out.from, to: out.to, subject: out.subject, html: out.html.replace(MANAGE_SETTINGS_URL, "") });
  assert(measured > withoutFooter, "oversize measurement must include footer bytes");
});
