import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  MANAGE_EMAIL_PAGE_URL,
  ONE_CLICK_FUNCTION_NAME,
  manageEmailPageUrl,
  marketingFooterHtml,
  oneClickUnsubscribeUrl,
  resolveMarketingAttachment,
  rfc8058Headers,
  type MarketingAttachDeps,
} from "./marketing-email.ts";

/**
 * N2 S3 — the marketing attach layer.
 *
 * The decision table under test IS the cutover rule (N2 §4) plus the send-blocking rule (N2 §3):
 *   capability exists (any path)   → liveness-checked, then attach the SAME token (byte-identity)
 *   absent + attempted             → TERMINAL: a pre-cutover row needs a NEW send — 'attempted'
 *                                    does not prove the provider froze footer-less bytes
 *   absent + fresh                 → mint + attach
 *   non-live capability            → the SEND is blocked, never quietly sent without unsubscribe
 */

// A real 64-hex key (the test vector key from manage-token.test.ts's family — any hex works; the
// assertions here are structural, not known-answer).
const KEY_V1 = "a".repeat(64);
const CAP_ID = "01234567-89ab-4cde-8f01-23456789abcd";
const STATE = { currentVersion: 1, minMintableVersion: 1 };

function deps(overrides: Partial<MarketingAttachDeps> = {}): MarketingAttachDeps {
  return {
    mintCapability: () => Promise.resolve({ capabilityId: CAP_ID, keyVersion: 1 }),
    readCapabilityForSource: () => Promise.resolve(null),
    keyState: STATE,
    keyLookup: (v) => (v === 1 ? KEY_V1 : undefined),
    ...overrides,
  };
}

const INPUT = {
  scopeKind: "academy" as const,
  scopeId: "11111111-2222-4333-8444-555555555555",
  address: "p@example.com",
  sourceKind: "campaign_recipient",
  sourceId: "99999999-8888-4777-8666-555555555555",
  attempted: false,
};

Deno.test("fresh row → mints and attaches a token", async () => {
  let minted = 0;
  const d = deps({
    mintCapability: (args) => {
      minted++;
      assertEquals(args.sourceKind, "campaign_recipient");
      assertEquals(args.scopeKind, "academy");
      return Promise.resolve({ capabilityId: CAP_ID, keyVersion: 1 });
    },
  });
  const out = await resolveMarketingAttachment(d, INPUT);
  assertEquals(out.kind, "attach");
  assertEquals(minted, 1);
  if (out.kind === "attach") assert(out.token.startsWith("v1."));
});

Deno.test("attempted + capability exists → attaches WITHOUT minting (deterministic retry)", async () => {
  let minted = 0;
  const d = deps({
    mintCapability: () => {
      minted++;
      return Promise.resolve({ capabilityId: CAP_ID, keyVersion: 1 });
    },
    readCapabilityForSource: () =>
      Promise.resolve({ capabilityId: CAP_ID, keyVersion: 1, revoked: false, expired: false }),
  });
  const out = await resolveMarketingAttachment(d, { ...INPUT, attempted: true });
  assertEquals(out.kind, "attach");
  assertEquals(minted, 0);
});

Deno.test("retry attaches the IDENTICAL token a fresh send built — the byte-identity contract", async () => {
  const fresh = await resolveMarketingAttachment(deps(), INPUT);
  const retry = await resolveMarketingAttachment(
    deps({
      readCapabilityForSource: () =>
        Promise.resolve({ capabilityId: CAP_ID, keyVersion: 1, revoked: false, expired: false }),
    }),
    { ...INPUT, attempted: true },
  );
  assertEquals(fresh.kind, "attach");
  assertEquals(retry.kind, "attach");
  if (fresh.kind === "attach" && retry.kind === "attach") {
    assertEquals(fresh.token, retry.token);
    assertEquals(marketingFooterHtml(fresh.token), marketingFooterHtml(retry.token));
  }
});

Deno.test("attempted + NO capability → TERMINAL, never a footer-less send (the cutover rule)", async () => {
  // attempt_count counts provider REJECTIONS too, so 'attempted' does not prove the provider
  // froze footer-less bytes — a cleanly-rejected pre-cutover row sent footer-less would be
  // marketing without an unsubscribe. The refusal directs a NEW send instead.
  let minted = 0;
  const d = deps({
    mintCapability: () => {
      minted++;
      return Promise.resolve({ capabilityId: CAP_ID, keyVersion: 1 });
    },
  });
  const out = await resolveMarketingAttachment(d, { ...INPUT, attempted: true });
  assertEquals(out.kind, "terminal");
  if (out.kind === "terminal") assertEquals(out.reason, "pre_cutover_row_requires_new_send");
  // Minting here would CREATE the marker that claims the body has a footer — it must not.
  assertEquals(minted, 0);
});

Deno.test("the FRESH path also refuses a revoked/expired existing capability (read-first)", async () => {
  // The mint RPC returns an existing row regardless of revocation/expiry — only reading catches
  // it. A crash-before-attempt row whose capability was later revoked must not mail a dead link.
  for (const [revoked, expired, reason] of [
    [true, false, "capability_revoked"],
    [false, true, "capability_expired"],
  ] as const) {
    let minted = 0;
    const d = deps({
      mintCapability: () => {
        minted++;
        return Promise.resolve({ capabilityId: CAP_ID, keyVersion: 1 });
      },
      readCapabilityForSource: () =>
        Promise.resolve({ capabilityId: CAP_ID, keyVersion: 1, revoked, expired }),
    });
    const out = await resolveMarketingAttachment(d, { ...INPUT, attempted: false });
    assertEquals(out.kind, "terminal");
    if (out.kind === "terminal") assertEquals(out.reason, reason);
    assertEquals(minted, 0);
  }
});

Deno.test("revoked / expired capability → the SEND is blocked (never sent link-less)", async () => {
  for (const [revoked, expired, reason] of [
    [true, false, "capability_revoked"],
    [false, true, "capability_expired"],
  ] as const) {
    const d = deps({
      readCapabilityForSource: () =>
        Promise.resolve({ capabilityId: CAP_ID, keyVersion: 1, revoked, expired }),
    });
    const out = await resolveMarketingAttachment(d, { ...INPUT, attempted: true });
    assertEquals(out.kind, "terminal");
    if (out.kind === "terminal") assertEquals(out.reason, reason);
  }
});

Deno.test("retired key generation → terminal, not a footer-less send", async () => {
  // The capability's version is below the floor: buildManageToken refuses, and the refusal must
  // surface as terminal — quietly sending without the unsubscribe would defeat the entire layer.
  const d = deps({
    readCapabilityForSource: () =>
      Promise.resolve({ capabilityId: CAP_ID, keyVersion: 1, revoked: false, expired: false }),
    keyState: { currentVersion: 3, minMintableVersion: 2 },
  });
  const out = await resolveMarketingAttachment(d, { ...INPUT, attempted: true });
  assertEquals(out.kind, "terminal");
});

Deno.test("missing key state → terminal (absence retires everything; S1 contract)", async () => {
  const out = await resolveMarketingAttachment(deps({ keyState: null }), INPUT);
  assertEquals(out.kind, "terminal");
});

Deno.test("mint refusal (e.g. NMRET) propagates as a throw — callers classify it", async () => {
  const d = deps({
    mintCapability: () => Promise.reject(new Error("NMRET: retired generation")),
  });
  let threw = false;
  try {
    await resolveMarketingAttachment(d, INPUT);
  } catch (err) {
    threw = true;
    assertStringIncludes((err as Error).message, "NMRET");
  }
  assert(threw, "a mint refusal must not be swallowed into a footer-less send");
});

// ── URLs, headers, footer markup ────────────────────────────────────────────────────────────────

Deno.test("RFC 8058: both headers, exact one-click marker, https function URL", () => {
  const h = rfc8058Headers("https://ref.supabase.co", "v1.abc.def");
  assertEquals(h["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assertEquals(
    h["List-Unsubscribe"],
    `<https://ref.supabase.co/functions/v1/${ONE_CLICK_FUNCTION_NAME}?token=v1.abc.def>`,
  );
});

Deno.test("footer: manage-page link carries the token; locale copy; en fallback", () => {
  const en = marketingFooterHtml("v1.a.b");
  assertStringIncludes(en, `${MANAGE_EMAIL_PAGE_URL}?token=v1.a.b`);
  assertStringIncludes(en, "Unsubscribe from these emails");
  const nl = marketingFooterHtml("v1.a.b", "nl");
  assertStringIncludes(nl, "Afmelden voor deze e-mails");
  assertStringIncludes(marketingFooterHtml("v1.a.b", "fr"), "Unsubscribe from these emails");
});

Deno.test("footer is deterministic and the token needs no HTML escaping by construction", () => {
  assertEquals(marketingFooterHtml("v1.a.b"), marketingFooterHtml("v1.a.b"));
  // base64url + dots + the v-prefix: no &, <, >, ", ' can appear in a well-formed token.
  const url = manageEmailPageUrl("v1.aA0-_b.cC1-_d");
  assert(!/[&<>"']/.test(url.slice(MANAGE_EMAIL_PAGE_URL.length)));
});

Deno.test("one-click URL encodes the token", () => {
  assertEquals(
    oneClickUnsubscribeUrl("https://x.co", "v1.a.b"),
    `https://x.co/functions/v1/${ONE_CLICK_FUNCTION_NAME}?token=v1.a.b`,
  );
});
