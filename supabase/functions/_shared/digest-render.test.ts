import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { DIGEST_BYTE_BUDGET, isDigestRequestOversize, renderDigestEmail, utf8Bytes } from "./digest-render.ts";

Deno.test("single item → singular subject; the `to` passes through", () => {
  const out = renderDigestEmail({ to: "p@example.com", locale: "en", items: [{ title: "Booking confirmed" }] });
  assertEquals(out.to, "p@example.com");
  assertEquals(out.subject, "Your PadelTrainer update");
  assertStringIncludes(out.html, "Booking confirmed");
});

Deno.test("multiple items → count in subject; each item rendered", () => {
  const out = renderDigestEmail({ to: "p@example.com", locale: "en", items: [{ title: "A" }, { title: "B" }, { title: "C" }] });
  assertEquals(out.subject, "Your PadelTrainer update (3 items)");
  for (const t of ["A", "B", "C"]) assertStringIncludes(out.html, t);
});

Deno.test("locale: nl copy, unknown locale falls back to English", () => {
  assertEquals(renderDigestEmail({ to: "p@x.com", locale: "nl", items: [{ title: "x" }] }).subject, "Je PadelTrainer-update");
  assertEquals(renderDigestEmail({ to: "p@x.com", locale: "fr", items: [{ title: "x" }] }).subject, "Your PadelTrainer update");
  assertEquals(renderDigestEmail({ to: "p@x.com", locale: null, items: [{ title: "x" }] }).subject, "Your PadelTrainer update");
});

Deno.test("HTML injection in item fields is escaped (no unescaped markup reaches the output)", () => {
  const out = renderDigestEmail({
    to: "p@example.com",
    items: [{ title: `<script>alert(1)</script>`, body: `x" onload="y`, url: `javascript:evil()"` }],
  });
  assert(!out.html.includes("<script>"));
  assertStringIncludes(out.html, "&lt;script&gt;");
  assert(!out.html.includes(`onload="y`));
});

Deno.test("missing/partial fields degrade gracefully (no throw, placeholder title)", () => {
  const out = renderDigestEmail({ to: "p@example.com", items: [{}, { body: "just a body" }] });
  assertStringIncludes(out.html, "—");            // empty title → em-dash placeholder
  assertStringIncludes(out.html, "just a body");
});

Deno.test("oversize detection is byte-accurate against the store budget", () => {
  const small = renderDigestEmail({ to: "p@example.com", items: [{ title: "hi" }] });
  assertEquals(isDigestRequestOversize(small), false);
  const huge = renderDigestEmail({ to: "p@example.com", items: [{ title: "x".repeat(DIGEST_BYTE_BUDGET) }] });
  assertEquals(isDigestRequestOversize(huge), true);
  assert(utf8Bytes(JSON.stringify({ to: huge.to, subject: huge.subject, html: huge.html })) > DIGEST_BYTE_BUDGET);
});

Deno.test("deterministic: same input → byte-identical output (stable request hash)", () => {
  const input = { to: "p@example.com", locale: "en", items: [{ title: "A", url: "https://x/1" }, { title: "B" }] };
  assertEquals(JSON.stringify(renderDigestEmail(input)), JSON.stringify(renderDigestEmail(input)));
});
