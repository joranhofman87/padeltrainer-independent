import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateIdentitySendGate,
  identityVerificationLink,
  renderIdentityVerificationEmail,
  type IdentitySendTarget,
} from "./identity-send-gate.ts";

const NOW = new Date("2026-08-10T12:00:00.000Z");
const future = "2026-08-10T12:30:00.000Z";
const past = "2026-08-10T11:30:00.000Z";

const target = (over: Partial<IdentitySendTarget> = {}): IdentitySendTarget => ({
  contact_normalized: "visitor@example.com",
  workflow: "slot",
  key_version: 1,
  expires_at: future,
  already_consumed: false,
  key_mintable: true,
  ...over,
});

Deno.test("a healthy challenge sends, to the CHALLENGE's address", () => {
  const v = evaluateIdentitySendGate({ target: target(), now: NOW, suppressed: false });
  assertEquals(v.action, "send");
  if (v.action !== "send") throw new Error("unreachable");
  assertEquals(v.to, "visitor@example.com");
  assertEquals(v.keyVersion, 1);
});

Deno.test("a row that resolves to no challenge is terminal, not retried forever", () => {
  const v = evaluateIdentitySendGate({ target: null, now: NOW, suppressed: false });
  assertEquals(v.action, "stop");
  if (v.action !== "stop") throw new Error("unreachable");
  assertEquals(v.code, "identity_send_no_challenge");
  assertEquals(v.terminal, true);
});

Deno.test("an already-consumed challenge is not mailed — the visitor already chose", () => {
  const v = evaluateIdentitySendGate({
    target: target({ already_consumed: true }), now: NOW, suppressed: false,
  });
  assertEquals(v.action, "stop");
  if (v.action !== "stop") throw new Error("unreachable");
  assertEquals(v.code, "identity_send_already_consumed");
});

Deno.test("an expired challenge is not mailed — a dead link reads as a broken product", () => {
  const v = evaluateIdentitySendGate({
    target: target({ expires_at: past }), now: NOW, suppressed: false,
  });
  assertEquals(v.action, "stop");
  if (v.action !== "stop") throw new Error("unreachable");
  assertEquals(v.code, "identity_send_expired");
});

Deno.test("an unparseable expiry fails CLOSED rather than being treated as far future", () => {
  const v = evaluateIdentitySendGate({
    target: target({ expires_at: "not-a-date" }), now: NOW, suppressed: false,
  });
  assertEquals(v.action, "stop");
});

Deno.test("a retired signing generation refuses with a code instead of throwing at send time", () => {
  const v = evaluateIdentitySendGate({
    target: target({ key_mintable: false }), now: NOW, suppressed: false,
  });
  assertEquals(v.action, "stop");
  if (v.action !== "stop") throw new Error("unreachable");
  assertEquals(v.code, "identity_send_key_retired");
});

Deno.test("an UNKNOWN key state is not the same as mintable — fail closed", () => {
  const v = evaluateIdentitySendGate({
    target: target({ key_mintable: null }), now: NOW, suppressed: false,
  });
  assertEquals(v.action, "stop");
  if (v.action !== "stop") throw new Error("unreachable");
  assertEquals(v.code, "identity_send_key_retired");
});

Deno.test("a hard-bounced address refuses with the stable code — never a silent new Player", () => {
  const v = evaluateIdentitySendGate({ target: target(), now: NOW, suppressed: true });
  assertEquals(v.action, "stop");
  if (v.action !== "stop") throw new Error("unreachable");
  assertEquals(v.code, "identity_send_undeliverable");
  assertEquals(v.terminal, true);
});

Deno.test("an UNREADABLE suppression state also refuses — sending to a bounced address hurts every customer", () => {
  const v = evaluateIdentitySendGate({ target: target(), now: NOW, suppressed: null });
  assertEquals(v.action, "stop");
  if (v.action !== "stop") throw new Error("unreachable");
  assertEquals(v.code, "identity_send_undeliverable");
});

Deno.test("the ORDER holds: a consumed AND undeliverable challenge answers 'consumed' first", () => {
  // Ordering matters for diagnosis: 'undeliverable' would send support chasing an email problem
  // that is not the reason nothing was sent.
  const v = evaluateIdentitySendGate({
    target: target({ already_consumed: true }), now: NOW, suppressed: true,
  });
  if (v.action !== "stop") throw new Error("unreachable");
  assertEquals(v.code, "identity_send_already_consumed");
});

Deno.test("the copy discloses NOTHING about who might match", () => {
  for (const lang of ["nl", "en"] as const) {
    const { subject, html } = renderIdentityVerificationEmail(lang, "https://x.test/verify-identity?t=tok");
    assert(subject.length > 0);
    // no candidate, academy, player or person naming of any kind
    for (const leak of ["Player", "speler", "academy", "academie", "match", "bestaand account"]) {
      assert(!html.includes(leak), `${lang} copy must not mention "${leak}"`);
    }
    // and it must tell an unexpecting recipient they can ignore it
    assert(/ignore|niets te doen/i.test(html), `${lang} copy must say an unexpected mail is safe to ignore`);
  }
});

Deno.test("the link points at /verify-identity and carries the token url-encoded", () => {
  const link = identityVerificationLink("https://padeltrainer.ai/", "v1.abc.def+/=");
  assertStringIncludes(link, "https://padeltrainer.ai/verify-identity?t=");
  assert(!link.includes("+/="), "token must be percent-encoded, not raw");
  assert(!link.includes("//verify-identity"), "trailing slash on the base must not double up");
});
