// N4 M2 — the instant workers' PRE-PROVIDER kill re-check, shared and directly testable.
//
// The claim-time gate (claim_notification_outbox_batch refuses a killed channel before any
// ledger mutation) is necessary but not sufficient: rows CLAIMED before the kill landed are
// already in this worker's hands, and the whole point of a kill switch is that mail stops NOW,
// not after the in-flight batch drains. So the worker calls this at the top of every row
// iteration — before the send gate, before the provider.
//
// FAIL-CLOSED: a read error, a null, anything but an explicit `false` counts as killed. On
// kill the worker RELEASES everything it still holds (release_notification_claims_on_kill:
// token-guarded, status back to pending, the claim's attempt increment undone, short backoff)
// and stops the loop — a kill defers, it never terminal-fails and never burns retry budget.
// The release itself is best-effort: if IT also fails, the rows ride out the stale-reclaim
// window instead, which is slower but equally send-free.

export type KillCheckRpc = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

export type KillCheckResult =
  | { killed: false }
  | { killed: true; released: number; reason: "killed" | "check_failed" };

export async function checkChannelKillOrRelease(
  rpc: KillCheckRpc,
  channel: string,
  workerToken: string,
): Promise<KillCheckResult> {
  let reason: "killed" | "check_failed";
  try {
    const r = await rpc("is_notification_channel_killed", { p_channel: channel });
    if (!r.error && r.data === false) return { killed: false };
    reason = r.error || r.data === null || r.data === undefined ? "check_failed" : "killed";
  } catch {
    reason = "check_failed";
  }
  let released = 0;
  try {
    const rel = await rpc("release_notification_claims_on_kill", {
      p_channel: channel,
      p_worker: workerToken,
    });
    if (!rel.error && typeof rel.data === "number") released = rel.data;
  } catch {
    // best-effort — the stale-reclaim window covers rows a failed release leaves behind
  }
  return { killed: true, released, reason };
}
