// Deno tests for the PRODUCTION missing-template ownership primitive.
//
// These import the real module the edge function imports — not a hand-copied
// approximation — so deleting `.eq("status", "pending")` from
// onboarding-missing-template.ts breaks this suite. That is the whole point:
// the previous version of this proof re-implemented the SQL in the test and could
// therefore stay green while production regressed.
//
// The alert count is OBSERVED, not inferred. `invocation()` below drives the same
// production primitives the handler drives — recordMissingTemplateOutcome (the
// outcome → failCount link) and emitOnboardingRunAlert (the call that reaches
// notifySlackEdgeError) — and counts the notifier calls that actually happen. An
// earlier version of this suite computed `alerts = failCount > 0 ? 1 : 0` itself,
// which stayed green whether or not production still alerted at all. It does not
// any more: the MUTANT tests at the bottom pin that severing countsAsFailure from
// the tally, or deleting the notify call, drops the observed count to zero.
import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { notifySlackEdgeError } from "./edge-slack.ts";
import {
  claimMissingTemplateFailure,
  countsAsFailure,
  DEFAULT_RUN_ALERT_NOTIFIER,
  emitOnboardingRunAlert,
  newOnboardingRunTally,
  recordMissingTemplateOutcome,
  type MissingTemplateClient,
  type MissingTemplateOutcome,
  type OnboardingRunTally,
} from "./onboarding-missing-template.ts";

/**
 * A minimal but FAITHFUL stand-in for the queue table: one shared row, and an
 * update that honours every `.eq()` filter it is given. It does not know which
 * filters the production code will apply — it simply applies them — so if the
 * status guard disappears from production, this fake stops constraining anything
 * and the row is matched twice.
 */
function fakeDb(initialStatus = "pending") {
  const row = { id: "q1", status: initialStatus, error_message: null as string | null };
  let failNextWith: string | null = null;
  const client: MissingTemplateClient = {
    from: () => ({
      update: (values: Record<string, unknown>) => {
        const filters: Array<[string, unknown]> = [];
        const chain = {
          eq(col: string, val: unknown) { filters.push([col, val]); return chain as never; },
          select: async (_cols: string) => {
            if (failNextWith) return { data: null, error: { message: failNextWith } };
            const matches = filters.every(([col, val]) => (row as Record<string, unknown>)[col] === val);
            if (!matches) return { data: [], error: null };
            Object.assign(row, values);
            return { data: [{ id: row.id }], error: null };
          },
        };
        return chain as never;
      },
    }),
  };
  return { client, row, setError: (m: string | null) => { failNextWith = m; } };
}

/** Records every alert production actually emitted, so `alerts` is a measurement. */
function spyNotifier() {
  const calls: Array<{ fn: string; message: string; context?: Record<string, unknown> }> = [];
  return {
    calls,
    notify: (fn: string, message: string, context?: Record<string, unknown>) => {
      calls.push({ fn, message, context });
      return Promise.resolve();
    },
  };
}

/**
 * One invocation of the worker's missing-template path, driven through the SAME
 * production primitives as process-onboarding-emails: claim → recordMissingTemplate-
 * Outcome → emitOnboardingRunAlert. Nothing here re-derives the alerting rule.
 */
async function invocation(client: MissingTemplateClient) {
  const tally = newOnboardingRunTally(1);
  const spy = spyNotifier();
  const outcome = await claimMissingTemplateFailure(client, "q1");
  recordMissingTemplateOutcome(tally, outcome);
  await emitOnboardingRunAlert(tally, spy.notify);
  return { outcome, tally, alerts: spy.calls.length, alertCalls: spy.calls };
}

Deno.test("two concurrent invocations: exactly one owner and exactly ONE Slack alert", async () => {
  const db = fakeDb();
  const [a, b] = await Promise.all([invocation(db.client), invocation(db.client)]);
  const owners = [a, b].filter((r) => r.outcome.kind === "owned").length;
  assertEquals(owners, 1, "exactly one invocation may own the failure");
  assertEquals(a.alerts + b.alerts, 1, "exactly one Slack alert across both invocations");
  assertEquals(db.row.status, "failed");
  assertEquals(db.row.error_message, "Template not found");
});

Deno.test("eight concurrent invocations still produce exactly one alert", async () => {
  const db = fakeDb();
  const runs = await Promise.all(Array.from({ length: 8 }, () => invocation(db.client)));
  assertEquals(runs.filter((r) => r.outcome.kind === "owned").length, 1);
  assertEquals(runs.reduce((s, r) => s + r.alerts, 0), 1);
});

Deno.test("a later tick finds the row already handled and stays silent", async () => {
  const db = fakeDb();
  const first = await invocation(db.client);
  assertEquals(first.outcome.kind, "owned");
  assertEquals(first.alerts, 1);
  const second = await invocation(db.client);
  assertEquals(second.outcome.kind, "already_handled");
  assertEquals(second.alerts, 0, "a later tick must not re-alert for a handled row");
});

Deno.test("a row another run legitimately claimed (status moved on) is never rewritten", async () => {
  const db = fakeDb("sent");            // claim_onboarding_email_queue_item moved it pending -> sent
  const run = await invocation(db.client);
  assertEquals(run.outcome.kind, "already_handled");
  assertEquals(run.alerts, 0);
  assertEquals(db.row.status, "sent");  // a sent row is never downgraded to failed
});

Deno.test("a genuine write error stays VISIBLE and is not mistaken for another owner", async () => {
  const db = fakeDb();
  db.setError("connection reset");
  const run = await invocation(db.client);
  assertEquals(run.outcome.kind, "error");
  assertEquals(countsAsFailure(run.outcome), true, "a real fault must still be counted and alerted");
  assertEquals(run.alerts, 1);
});

Deno.test("the emitted alert carries the production function name and counts", async () => {
  const db = fakeDb();
  const run = await invocation(db.client);
  assertEquals(run.alerts, 1);
  assertEquals(run.alertCalls[0].fn, "process-onboarding-emails");
  assertEquals(run.alertCalls[0].message, "1 onboarding email(s) failed to send");
  assertEquals(run.alertCalls[0].context, { failCount: 1, successCount: 0, processed: 1 });
});

Deno.test("a clean run emits NO alert at all", async () => {
  const spy = spyNotifier();
  const emitted = await emitOnboardingRunAlert(newOnboardingRunTally(3), spy.notify);
  assertEquals(emitted, false);
  assertEquals(spy.calls.length, 0, "a run with no failures must stay silent");
});

// The injected spy above proves the call HAPPENS, but not that the un-injected
// default still reaches Slack — swapping the default for a no-op would leave every
// test above green. Pin the identity of the default transport too.
Deno.test("the default notifier IS notifySlackEdgeError", () => {
  assertEquals(DEFAULT_RUN_ALERT_NOTIFIER, notifySlackEdgeError);
});

// ---------------------------------------------------------------------------
// MUTATION PINS. Each reproduces one deletion the suite above must not survive,
// and asserts the mutant's behaviour DIFFERS from the production baseline.

// (1) The ownership guard. Reproduces the pre-fix production statement — no status
// guard — and asserts it exhibits the exact double-alert defect the suite forbids.
// If someone deletes `.eq("status", "pending")` from the production primitive, the
// tests above start behaving like this one and fail.
Deno.test("MUTANT: without the status guard both invocations own it and BOTH alert", async () => {
  const db = fakeDb();
  const unguarded = async () => {
    const { data } = await db.client
      .from("onboarding_email_queue")
      .update({ status: "failed", error_message: "Template not found" })
      .eq("id", "q1")
      .eq("id", "q1")          // same arity, but no status predicate
      .select("id");
    const owned = !!data && data.length > 0;
    return owned ? 1 : 0;
  };
  const [x, y] = await Promise.all([unguarded(), unguarded()]);
  assertEquals(x + y, 2, "the unguarded statement double-counts — this is the defect being pinned");
});

// (2) The outcome → failCount link. A tally that ignores countsAsFailure never arms
// the alert, so a broken row goes out silently. Baseline: 1 alert. Mutant: 0.
Deno.test("MUTANT: severing countsAsFailure from the tally silences the alert", async () => {
  const db = fakeDb();
  const outcome = await claimMissingTemplateFailure(db.client, "q1");
  assertEquals(outcome.kind, "owned");

  const baselineTally = newOnboardingRunTally(1);
  const baselineSpy = spyNotifier();
  recordMissingTemplateOutcome(baselineTally, outcome);
  await emitOnboardingRunAlert(baselineTally, baselineSpy.notify);
  assertEquals(baselineSpy.calls.length, 1, "production baseline alerts on an owned failure");

  const mutantRecord = (_tally: OnboardingRunTally, _outcome: MissingTemplateOutcome) => {
    /* countsAsFailure disconnected — failCount never rises */
  };
  const mutantTally = newOnboardingRunTally(1);
  const mutantSpy = spyNotifier();
  mutantRecord(mutantTally, outcome);
  await emitOnboardingRunAlert(mutantTally, mutantSpy.notify);
  assertEquals(mutantTally.failCount, 0);
  assertEquals(mutantSpy.calls.length, 0, "the mutant is silent — this is the defect being pinned");

  assertEquals(
    baselineSpy.calls.length === mutantSpy.calls.length,
    false,
    "baseline and mutant must differ, or the test proves nothing",
  );
});

// (3) The notify call itself. An emitter that tallies but never notifies produces no
// operator signal. Baseline: 1 call. Mutant: 0.
Deno.test("MUTANT: an emitter without the notify call raises no alert", async () => {
  const tally = newOnboardingRunTally(1);
  tally.failCount = 1;

  const baselineSpy = spyNotifier();
  assertEquals(await emitOnboardingRunAlert(tally, baselineSpy.notify), true);
  assertEquals(baselineSpy.calls.length, 1);

  const mutantSpy = spyNotifier();
  const mutantEmit = (t: OnboardingRunTally) => Promise.resolve(t.failCount > 0);
  assertEquals(await mutantEmit(tally), true, "the mutant still REPORTS an alert…");
  assertEquals(mutantSpy.calls.length, 0, "…but never made one — this is the defect being pinned");

  assertEquals(
    baselineSpy.calls.length === mutantSpy.calls.length,
    false,
    "baseline and mutant must differ, or the test proves nothing",
  );
});

// countsAsFailure stays directly covered: it is the predicate production folds in.
Deno.test("countsAsFailure: owned and error count; already_handled does not", () => {
  assertEquals(countsAsFailure({ kind: "owned" }), true);
  assertEquals(countsAsFailure({ kind: "error", message: "boom" }), true);
  assertEquals(countsAsFailure({ kind: "already_handled" }), false);
});
