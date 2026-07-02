// P2-11 — atomic per-row claim for send-schedule-notifications.
//
// THE BUG THIS CLOSES. send-schedule-notifications SELECTed every intake_request with
// status='booked' for a cycle, emailed each in a loop, and only flipped the successful ones to
// 'notified' AFTER the whole loop. Two overlapping invocations (a double-click, a Vercel retry, a
// manual re-run mid-run) both SELECT the same 'booked' set before either flips it → every booked
// player is emailed twice. There was no per-row atomic claim and (unlike process-onboarding-emails)
// no cron single-flight.
//
// THE FIX. Claim each intake row BEFORE sending:
//     UPDATE intake_requests SET status='notified' WHERE id=? AND status='booked' RETURNING id
// Under READ COMMITTED the row lock makes concurrent claims disjoint: the first invocation flips the
// row and the second's WHERE status='booked' matches nothing → it does not send. Only when the claim
// affected a row do we send the email. If the send FAILS, we release the row back to 'booked' so a
// later run (or the retrying invocation) can pick it up — no player is silently left un-notified.
//
// GRACEFUL DEGRADATION. This is pure edge-function logic over the existing intake_requests table and
// its existing status values ('booked' / 'notified') — no migration, no new RPC, nothing to deploy
// besides the function itself. It cannot be "un-deployed" into a broken state.

// Narrow shape — avoids depending on the full SupabaseClient type (and `any`).
export type ClaimSupabase = {
  from: (table: string) => {
    update: (patch: Record<string, unknown>) => {
      eq: (col: string, val: unknown) => {
        eq: (col2: string, val2: unknown) => {
          select: (cols: string) => PromiseLike<{ data: unknown; error: unknown }>;
        };
      };
    };
  };
};

/**
 * Atomically claim ONE booked intake row for notification.
 * Returns true iff THIS call transitioned the row 'booked' → 'notified' (i.e. it is the winner and
 * must send). Returns false if the row was already claimed by a concurrent run (nothing to send) OR
 * if the claim errored (fail-closed: do not send on an uncertain claim — the row stays whatever it
 * was and a later run retries).
 */
export async function claimIntakeForNotification(
  supabase: ClaimSupabase,
  intakeId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("intake_requests")
    .update({ status: "notified" })
    .eq("id", intakeId)
    .eq("status", "booked")
    .select("id");
  if (error) return false;
  return Array.isArray(data) && data.length > 0;
}

/**
 * Release a previously-claimed intake row back to 'booked' after a failed send, so a later run can
 * retry it. Only flips rows still in 'notified' (guards against clobbering a concurrent legitimate
 * transition). Best-effort: never throws — a failed release just leaves the row 'notified' (the
 * milder outcome: a missed retry, not a double-send), and the Slack alert already surfaces the send
 * failure to ops.
 */
export async function releaseIntakeAfterFailedSend(
  supabase: ClaimSupabase,
  intakeId: string,
): Promise<void> {
  try {
    await supabase
      .from("intake_requests")
      .update({ status: "booked" })
      .eq("id", intakeId)
      .eq("status", "notified")
      .select("id");
  } catch {
    // swallow — see doc comment.
  }
}
