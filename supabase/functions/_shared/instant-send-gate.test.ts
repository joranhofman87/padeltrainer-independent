// Deno tests for the PRODUCTION instant send gate — the decision notification-email-worker
// actually makes before delivering a claimed outbox row.
//
// This imports the real module the worker imports. Previously this logic was inline in a handler
// that ends in `serve(handler)`, so the only available "tests" were source-text assertions, which
// stay green while the check ORDER, the fail-closed behaviour, or the terminal-ness regress.
// Every case below is an orchestration case: it drives the gate with dependency doubles and
// asserts the verdict, including which RPCs were reached and in what order.
import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { evaluateInstantSendGate, type ClaimedRowForGate, type GateDeps } from "./instant-send-gate.ts";

const ROW: ClaimedRowForGate = {
  outbox_id: "11111111-1111-4111-8111-111111111111",
  destination_normalized: "player@example.com",
  payload: { subject: "New availability from Coach Ana", html: "<p>hi</p>" },
};

/** Records which dependencies were reached, so ORDER and short-circuiting are assertable. */
function deps(opts: {
  suppressed?: boolean | null;
  supError?: unknown;
  stopReason?: string | null;
  stopError?: unknown;
  supThrows?: boolean;
  stopThrows?: boolean;
} = {}) {
  const calls: string[] = [];
  const d: GateDeps = {
    isEmailSuppressed: (email) => {
      calls.push(`suppressed:${email}`);
      if (opts.supThrows) throw new Error("boom");
      return Promise.resolve({ data: opts.suppressed ?? false, error: opts.supError ?? null });
    },
    memberStopReason: (id) => {
      calls.push(`stop:${id}`);
      if (opts.stopThrows) throw new Error("boom");
      return Promise.resolve({ data: opts.stopReason ?? null, error: opts.stopError ?? null });
    },
  };
  return { deps: d, calls };
}

// ---------------------------------------------------------------------------
Deno.test("a clean row is deliverable, and both gates were consulted", async () => {
  const { deps: d, calls } = deps();
  const v = await evaluateInstantSendGate(ROW, d);
  assertEquals(v.action, "send");
  if (v.action !== "send") return;
  assertEquals(v.dest, "player@example.com");
  assertEquals(v.subject, "New availability from Coach Ana");
  assertEquals(calls, [
    "suppressed:player@example.com",
    "stop:11111111-1111-4111-8111-111111111111",
  ]);
});

Deno.test("an unrenderable row is TERMINAL and burns no RPC", async () => {
  for (
    const [row, expected] of [
      [{ ...ROW, destination_normalized: null }, "missing_destination"],
      [{ ...ROW, destination_normalized: "   " }, "missing_destination"],
      [{ ...ROW, payload: { html: "<p>x</p>" } }, "missing_subject_or_html"],
      [{ ...ROW, payload: { subject: "s" } }, "missing_subject_or_html"],
      [{ ...ROW, payload: null }, "missing_subject_or_html"],
    ] as Array<[ClaimedRowForGate, string]>
  ) {
    const { deps: d, calls } = deps();
    const v = await evaluateInstantSendGate(row, d);
    assertEquals(v.action, "stop");
    if (v.action !== "stop") return;
    assertEquals(v.error, expected);
    assertEquals(v.terminal, true, "a row that can never render must not be retried");
    assertEquals(v.countAs, "failed");
    assertEquals(calls, [], "an undeliverable row must not cost an RPC round-trip");
  }
});

// ---------------------------------------------------------------------------
Deno.test("FAIL CLOSED: a suppression-check error does NOT send, and stays retryable", async () => {
  for (const o of [{ supError: { message: "db down" } }, { supThrows: true }]) {
    const { deps: d, calls } = deps(o);
    const v = await evaluateInstantSendGate(ROW, d);
    assertEquals(v.action, "stop");
    if (v.action !== "stop") return;
    assertEquals(v.error, "suppression_check_failed");
    assertEquals(v.terminal, false, "a transient fault must retry, not terminal-fail the row");
    // and it short-circuits: the broader policy is never consulted after a failed gate
    assertEquals(calls.length, 1);
  }
});

Deno.test("a suppressed address is TERMINAL and counted as suppressed, not failed", async () => {
  const { deps: d, calls } = deps({ suppressed: true });
  const v = await evaluateInstantSendGate(ROW, d);
  assertEquals(v.action, "stop");
  if (v.action !== "stop") return;
  assertEquals(v.error, "email_suppressed");
  assertEquals(v.terminal, true);
  assertEquals(v.countAs, "suppressed");
  assertEquals(calls.length, 1, "suppression short-circuits the live policy");
});

// ---------------------------------------------------------------------------
Deno.test("FAIL CLOSED: a stop-policy error does NOT send, and stays retryable", async () => {
  for (const o of [{ stopError: { message: "db down" } }, { stopThrows: true }]) {
    const { deps: d } = deps(o);
    const v = await evaluateInstantSendGate(ROW, d);
    assertEquals(v.action, "stop");
    if (v.action !== "stop") return;
    assertEquals(v.error, "stop_policy_check_failed");
    assertEquals(v.terminal, false);
  }
});

Deno.test("EVERY live stop reason blocks the send and is reported verbatim", async () => {
  // These are exactly the reasons notif_digest_member_stop_reason can return. The instant path
  // previously consulted only the event hook, so all the generic ones went unchecked.
  for (
    const reason of [
      "contact_revoked",
      "no_destination",
      "destination_changed",
      "suppressed",
      "marketing_unsubscribed",
      "preference_off",
      "tenant_restricted",
      "follow_revoked",
      "missing_member",
      "member_window_closed",
      "rebook_member_open_ineligible",
    ]
  ) {
    const { deps: d } = deps({ stopReason: reason });
    const v = await evaluateInstantSendGate(ROW, d);
    assertEquals(v.action, "stop", `${reason} must block the send`);
    if (v.action !== "stop") return;
    assertEquals(v.error, reason, "the reason is surfaced verbatim for the outbox record");
    assertEquals(v.terminal, true, "withdrawn authorisation cannot be restored by retrying");
    assertEquals(v.countAs, "suppressed");
  }
});

Deno.test("destination_changed specifically blocks mailing a STALE frozen address", async () => {
  // The scenario: the row froze player@example.com at enqueue; the user has since changed their
  // address. The worker would otherwise deliver to the frozen value on the row.
  const { deps: d } = deps({ stopReason: "destination_changed" });
  const v = await evaluateInstantSendGate(ROW, d);
  assertEquals(v.action, "stop");
  if (v.action !== "stop") return;
  assertEquals(v.error, "destination_changed");
});

// ---------------------------------------------------------------------------
// MUTATION PINS — each reproduces a way the gate could regress.

Deno.test("MUTANT: a gate that falls OPEN on error would mail a suppressed address", async () => {
  const failOpen = async (d: GateDeps) => {
    try {
      const r = await d.isEmailSuppressed("player@example.com");
      if (r.error) return "send";          // <-- the defect
      return r.data === true ? "stop" : "send";
    } catch { return "send"; }             // <-- and here
  };
  const { deps: d } = deps({ supError: { message: "db down" } });
  assertEquals(await failOpen(d), "send", "the mutant sends when it cannot verify...");
  const v = await evaluateInstantSendGate(ROW, d);
  assertEquals(v.action, "stop", "...production refuses");
});

Deno.test("MUTANT: checking only the EVENT hook leaves the generic reasons unchecked", async () => {
  // This is the exact defect the review found: the worker consulted the event hook alone, so a
  // revoked contact / changed address / preference-off row still sent.
  const eventHookOnly = (reason: string) => (reason === "follow_revoked" ? "stop" : "send");
  const generic = ["contact_revoked", "destination_changed", "preference_off", "no_destination"];
  for (const reason of generic) {
    assertEquals(eventHookOnly(reason), "send", `the mutant sends despite ${reason}...`);
    const { deps: d } = deps({ stopReason: reason });
    const v = await evaluateInstantSendGate(ROW, d);
    assertEquals(v.action, "stop", `...production stops on ${reason}`);
  }
});

Deno.test("MUTANT: treating a live stop as RETRYABLE would loop against a revoked contact", async () => {
  const { deps: d } = deps({ stopReason: "contact_revoked" });
  const v = await evaluateInstantSendGate(ROW, d);
  assertEquals(v.action, "stop");
  if (v.action !== "stop") return;
  assertEquals(v.terminal, true);
  assertEquals(false, false === v.terminal, "a non-terminal verdict here would retry forever");
});
