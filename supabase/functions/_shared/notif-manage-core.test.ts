import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  handleManageApply,
  handleManageContext,
  handleOneClickPost,
  oneClickGetRedirect,
  type ManageContextRow,
  type ManageEndpointDeps,
} from "./notif-manage-core.ts";
import { buildManageToken } from "./manage-token.ts";
import { MANAGE_EMAIL_PAGE_URL } from "./marketing-email.ts";

/**
 * N2 S5 — the endpoint fail-direction table.
 *
 * The property that must never regress: AN OPERATIONAL FAILURE IS NEVER A SUCCESS. RFC 8058
 * senders do not retry a 2xx, so a 200 produced by a database outage is a silently lost opt-out
 * — the exact defect S1's review killed twice in design. Every operational row here asserts 503;
 * every dead-link row asserts 410 (permanent, truthful); only applied/already_applied are 200.
 */

const KEY_V1 = "b".repeat(64);
const CAP_ID = "01234567-89ab-4cde-8f01-23456789abcd";
const STATE = { currentVersion: 1, minMintableVersion: 1 };
const lookup = (v: number) => (v === 1 ? KEY_V1 : undefined);

async function goodToken(): Promise<string> {
  return await buildManageToken(CAP_ID, 1, STATE, lookup);
}

const LIVE_CTX: ManageContextRow = {
  status: "live",
  kind: "marketing_unsubscribe",
  scope_kind: "academy",
  scope_name: "Padel Academy Zuid",
  destination_redacted: "p•••@e•••.com",
  key_version: 1,
};

function deps(overrides: Partial<ManageEndpointDeps> = {}): ManageEndpointDeps {
  return {
    loadKeyState: () => Promise.resolve(STATE),
    getContext: () => Promise.resolve(LIVE_CTX),
    applyAction: () => Promise.resolve("applied"),
    keyLookup: lookup,
    ...overrides,
  };
}

// ── one-click POST ──────────────────────────────────────────────────────────────────────────────

Deno.test("one-click: a valid token applies and answers 200", async () => {
  const calls: string[] = [];
  const d = deps({
    applyAction: (id, source) => {
      calls.push(`${id}:${source}`);
      return Promise.resolve("applied");
    },
  });
  const r = await handleOneClickPost(d, await goodToken());
  assertEquals(r.status, 200);
  assertEquals(r.body.result, "applied");
  assertEquals(calls, [`${CAP_ID}:one_click`]);
});

Deno.test("one-click: already_applied is ALSO 200 — replay is harmless by design", async () => {
  const r = await handleOneClickPost(deps({ applyAction: () => Promise.resolve("already_applied") }), await goodToken());
  assertEquals(r.status, 200);
});

Deno.test("one-click: an apply RPC failure is 503, NEVER a success — a 200 here loses the opt-out", async () => {
  const r = await handleOneClickPost(deps({ applyAction: () => Promise.reject(new Error("db down")) }), await goodToken());
  assertEquals(r.status, 503);
  assertEquals(r.body.retryable, true);
});

Deno.test("one-click: unreadable key state is 503 (operational), not 400 (which discards the opt-out)", async () => {
  const r = await handleOneClickPost(deps({ loadKeyState: () => Promise.resolve(null) }), await goodToken());
  assertEquals(r.status, 503);
});

Deno.test("one-click: missing key material inside the live window is 503", async () => {
  const r = await handleOneClickPost(deps({ keyLookup: () => undefined }), await goodToken());
  assertEquals(r.status, 503);
});

Deno.test("one-click: garbage / bad signature is 400 — retrying a probe manufactures load", async () => {
  for (const bad of [null, "", "not-a-token", `v1.${CAP_ID}.${"A".repeat(43)}`]) {
    const r = await handleOneClickPost(deps(), bad);
    assertEquals(r.status, 400, `token=${String(bad)}`);
  }
});

Deno.test("one-click: a burned generation is 410 — permanent for this link, truthfully", async () => {
  const token = await goodToken();
  const r = await handleOneClickPost(
    deps({ loadKeyState: () => Promise.resolve({ currentVersion: 2, minMintableVersion: 2 }) }),
    token,
  );
  assertEquals(r.status, 410);
});

Deno.test("one-click: row-side rejections map 410 (revoked/expired/missing/retired), 500 on our own bug", async () => {
  for (const [verdict, want] of [
    ["rejected_revoked", 410],
    ["rejected_expired", 410],
    ["rejected_missing", 410],
    ["rejected_retired_key", 410],
    ["rejected_unknown_action", 500],
  ] as const) {
    const r = await handleOneClickPost(deps({ applyAction: () => Promise.resolve(verdict) }), await goodToken());
    assertEquals(r.status, want, verdict);
  }
});

Deno.test("one-click GET redirects to the manage page and applies NOTHING — scanners prefetch GETs", () => {
  const r = oneClickGetRedirect("v1.a.b");
  assertEquals(r.status, 303);
  assert(r.location.startsWith(MANAGE_EMAIL_PAGE_URL));
  assert(r.location.includes("token=v1.a.b"));
});

// ── manage page: context ────────────────────────────────────────────────────────────────────────

Deno.test("context: live capability returns the page's rendering payload, redacted", async () => {
  const r = await handleManageContext(deps(), await goodToken());
  assertEquals(r.status, 200);
  assertEquals(r.body.status, "live");
  assertEquals(r.body.scopeName, "Padel Academy Zuid");
  assertEquals(r.body.destinationRedacted, "p•••@e•••.com");
  assert(!("address" in r.body), "raw address must never reach the page");
});

Deno.test("context: statuses are CONTENT (200) — revoked/expired/missing render as copy, not errors", async () => {
  for (const status of ["revoked", "expired", "missing"]) {
    const r = await handleManageContext(
      deps({ getContext: () => Promise.resolve({ ...LIVE_CTX, status, key_version: null }) }),
      await goodToken(),
    );
    assertEquals(r.status, 200, status);
    assertEquals(r.body.status, status);
  }
});

Deno.test("context: an invalid token is 200 {status: invalid} — the page needs content, not a transport error", async () => {
  const r = await handleManageContext(deps(), "junk");
  assertEquals(r.status, 200);
  assertEquals(r.body.status, "invalid");
});

Deno.test("context: a context-RPC failure is 503, and NULL context is 'missing' — never conflated", async () => {
  const err = await handleManageContext(deps({ getContext: () => Promise.reject(new Error("db")) }), await goodToken());
  assertEquals(err.status, 503);
  const missing = await handleManageContext(deps({ getContext: () => Promise.resolve(null) }), await goodToken());
  assertEquals(missing.status, 200);
  assertEquals(missing.body.status, "missing");
});

Deno.test("context: a live row whose stored generation mismatches the signed one reads as invalid (bind)", async () => {
  const r = await handleManageContext(
    deps({ getContext: () => Promise.resolve({ ...LIVE_CTX, key_version: 7 }) }),
    await goodToken(),
  );
  assertEquals(r.status, 200);
  assertEquals(r.body.status, "invalid");
});

// ── manage page: apply ──────────────────────────────────────────────────────────────────────────

Deno.test("apply: the human path uses source 'manage_page' and mirrors the one-click table", async () => {
  const calls: string[] = [];
  const d = deps({
    applyAction: (_id, source) => {
      calls.push(source);
      return Promise.resolve("applied");
    },
  });
  const ok = await handleManageApply(d, await goodToken());
  assertEquals(ok.status, 200);
  assertEquals(calls, ["manage_page"]);
  const op = await handleManageApply(deps({ applyAction: () => Promise.reject(new Error("db")) }), await goodToken());
  assertEquals(op.status, 503);
  const bad = await handleManageApply(deps(), "junk");
  assertEquals(bad.status, 400);
});
