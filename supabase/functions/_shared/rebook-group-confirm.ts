// Group-confirmation send/stamp tally + result semantics, isolated from the edge handler so the
// "what counts as a clean run" rule is unit-testable (the index.ts handler calls serve() and has no
// harness). Codex round-5 #3: a provider send failure OR an un-stamped send is NOT clean success.

/** The outcome of one member's send-then-stamp step. */
export type MemberConfirmStep =
  | "skipped" // no verified email → nothing was sent (a legitimate no-op, not a failure)
  | "send_failed" // the provider rejected the send
  | "unresolved" // the email WENT OUT but its confirmation_sent_at stamp did NOT land → a retry re-sends
  | "sent"; // sent AND stamped

export interface GroupConfirmTally {
  sent: number;
  skipped: number;
  failed: number;
  unresolved: number;
}

/**
 * Drive one send-then-stamp `step` per member and tally the outcomes. `sent` counts every email that
 * left the building (including the ones whose stamp then failed — those ALSO bump `unresolved`).
 */
export async function runGroupConfirmations<M>(
  members: Iterable<M>,
  step: (m: M) => Promise<MemberConfirmStep>,
): Promise<GroupConfirmTally> {
  let sent = 0, skipped = 0, failed = 0, unresolved = 0;
  for (const m of members) {
    switch (await step(m)) {
      case "skipped":
        skipped++;
        break;
      case "send_failed":
        failed++;
        break;
      case "unresolved":
        sent++;
        unresolved++;
        break;
      case "sent":
        sent++;
        break;
    }
  }
  return { sent, skipped, failed, unresolved };
}

/**
 * A run is `ok` ONLY when nothing failed to send AND every send was stamped. `skipped` (no email)
 * does NOT make it un-ok — there was nothing to deliver. A provider failure (`failed`) or an
 * un-stamped send (`unresolved`) degrades the result to a partial the fire-and-forget caller / cron
 * must not treat as clean success. Durable recovery of unresolved sends is a PR 10c acceptance item.
 */
export function groupConfirmOk(t: GroupConfirmTally): boolean {
  return t.failed === 0 && t.unresolved === 0;
}
