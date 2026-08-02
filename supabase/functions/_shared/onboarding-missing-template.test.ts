// Deno tests for the PRODUCTION missing-template ownership primitive.
//
// These import the real module the edge function imports — not a hand-copied
// approximation — so deleting `.eq("status", "pending")` from
// onboarding-missing-template.ts breaks this suite. That is the whole point:
// the previous version of this proof re-implemented the SQL in the test and could
// therefore stay green while production regressed.
//
// The alert count is MEASURED, not inferred. process-onboarding-emails fires ONE
// end-of-run Slack alert per invocation when its failure tally is non-zero, so two
// concurrent invocations over a single broken row must produce exactly one alert
// in total. The `invocation()` helper below reproduces exactly that rule using the
// production `countsAsFailure`.
import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  claimMissingTemplateFailure,
  countsAsFailure,
  type MissingTemplateClient,
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

/** One invocation of the worker's missing-template path: claim, tally, then alert once if the tally is non-zero. */
async function invocation(client: MissingTemplateClient) {
  let failCount = 0;
  const outcome = await claimMissingTemplateFailure(client, "q1");
  if (countsAsFailure(outcome)) failCount++;
  return { outcome, failCount, alerts: failCount > 0 ? 1 : 0 };
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

// ---------------------------------------------------------------------------
// MUTATION PIN. This reproduces the pre-fix production statement — no status
// guard — and asserts it exhibits the exact double-alert defect the suite above
// forbids. If someone deletes `.eq("status", "pending")` from the production
// primitive, the tests above start behaving like this one and fail.
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
