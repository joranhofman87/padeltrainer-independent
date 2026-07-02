import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  claimIntakeForNotification,
  releaseIntakeAfterFailedSend,
} from "./schedule-notification-claim.ts";

// A tiny in-memory stand-in for the supabase-js update().eq().eq().select() chain that models the
// atomic claim UPDATE ... WHERE id=? AND status='booked' RETURNING id against a single row's status.
function makeClient(row: { id: string; status: string }, opts: { errorOnUpdate?: boolean } = {}) {
  return {
    from: (_table: string) => ({
      update: (patch: Record<string, unknown>) => ({
        eq: (_c1: string, id: unknown) => ({
          eq: (_c2: string, requiredStatus: unknown) => ({
            select: (_cols: string) => {
              if (opts.errorOnUpdate) {
                return Promise.resolve({ data: null, error: { message: "db down" } });
              }
              // WHERE id=? AND status=? — only transitions (and returns) the row if BOTH match.
              if (id === row.id && row.status === requiredStatus) {
                row.status = String(patch.status);
                return Promise.resolve({ data: [{ id: row.id }], error: null });
              }
              return Promise.resolve({ data: [], error: null });
            },
          }),
        }),
      }),
    }),
  };
}

Deno.test("claim wins exactly once — the second concurrent claim of the same row does NOT send", async () => {
  const row = { id: "ir-1", status: "booked" };
  const sb = makeClient(row);

  const first = await claimIntakeForNotification(sb, "ir-1");
  const second = await claimIntakeForNotification(sb, "ir-1");

  assertEquals(first, true); // winner sends
  assertEquals(second, false); // loser must NOT send → no double email
  assertEquals(row.status, "notified");
});

Deno.test("claim on a non-booked row returns false (nothing to send)", async () => {
  const row = { id: "ir-2", status: "notified" };
  const sb = makeClient(row);
  assertEquals(await claimIntakeForNotification(sb, "ir-2"), false);
});

Deno.test("claim fails CLOSED on a DB error — does not send on an uncertain claim", async () => {
  const row = { id: "ir-3", status: "booked" };
  const sb = makeClient(row, { errorOnUpdate: true });
  assertEquals(await claimIntakeForNotification(sb, "ir-3"), false);
  assertEquals(row.status, "booked"); // untouched → a later run retries
});

Deno.test("release reverts a claimed row to booked so a later run retries", async () => {
  const row = { id: "ir-4", status: "booked" };
  const sb = makeClient(row);

  assertEquals(await claimIntakeForNotification(sb, "ir-4"), true);
  assertEquals(row.status, "notified");

  await releaseIntakeAfterFailedSend(sb, "ir-4");
  assertEquals(row.status, "booked"); // reclaimable

  // And now a fresh claim can win again (the retry).
  assertEquals(await claimIntakeForNotification(sb, "ir-4"), true);
  assertEquals(row.status, "notified");
});

Deno.test("release never throws even when the update errors", async () => {
  const row = { id: "ir-5", status: "notified" };
  const sb = makeClient(row, { errorOnUpdate: true });
  await releaseIntakeAfterFailedSend(sb, "ir-5"); // must not throw
  assertEquals(true, true);
});
