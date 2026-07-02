import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { sanitizeEmailSubject } from "./email-subject.ts";

Deno.test("strips CR/LF (email header-injection guard)", () => {
  assertEquals(sanitizeEmailSubject("Hello\r\nBcc: evil@x.com"), "Hello Bcc: evil@x.com");
  assertEquals(sanitizeEmailSubject("a\nb\rc"), "a b c");
});

Deno.test("collapses whitespace + trims", () => {
  assertEquals(sanitizeEmailSubject("  Reserveer   je   plek  "), "Reserveer je plek");
});

Deno.test("empty / non-string → '' so callers can fall back to the default", () => {
  assertEquals(sanitizeEmailSubject(""), "");
  assertEquals(sanitizeEmailSubject("   "), "");
  assertEquals(sanitizeEmailSubject(undefined), "");
  assertEquals(sanitizeEmailSubject(null), "");
  assertEquals(sanitizeEmailSubject(42), "");
});

Deno.test("caps length", () => {
  assertEquals(sanitizeEmailSubject("x".repeat(300)).length, 150);
  assertEquals(sanitizeEmailSubject("x".repeat(300), 10).length, 10);
});

Deno.test("normal subject passes through unchanged", () => {
  assertEquals(sanitizeEmailSubject("Factuur 2026-001 - RL Padel"), "Factuur 2026-001 - RL Padel");
});
