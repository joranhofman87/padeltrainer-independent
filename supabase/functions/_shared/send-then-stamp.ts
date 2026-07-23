// Generic send-then-stamp tally + "clean run" semantics, shared by every rebook sender that sends an
// email and then stamps a DB marker (invited_at / confirmation_sent_at). Sending first, stamping only
// on a confirmed send, structurally removes the permanent-suppression window a claim-before-send has
// (a failed send never leaves a stamp). A post-send stamp failure is UNRESOLVED, not clean success.

/** The outcome of one item's send-then-stamp step. */
export type SendStepOutcome =
  | "skipped" // nothing to send (no email) — a legitimate no-op, not a failure
  | "send_failed" // the provider rejected the send
  | "unresolved" // the email WENT OUT but its stamp did NOT land → a retry re-sends (deduped by the idempotency key)
  | "sent"; // sent AND stamped

export interface SendTally {
  sent: number;
  skipped: number;
  failed: number;
  unresolved: number;
}

/**
 * Drive one send-then-stamp `step` per item and tally the outcomes. `sent` counts every email that
 * left the building (including the ones whose stamp then failed — those ALSO bump `unresolved`).
 */
export async function runSendThenStamp<M>(
  items: Iterable<M>,
  step: (m: M) => Promise<SendStepOutcome>,
): Promise<SendTally> {
  let sent = 0, skipped = 0, failed = 0, unresolved = 0;
  for (const m of items) {
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
 * One item's send-then-stamp control flow, isolated so its safety property is directly testable: the
 * stamp is attempted ONLY after a confirmed send, so a FAILED send never leaves a stamp (structurally
 * removing any permanent-suppression window — Codex round-6). A post-send stamp failure is UNRESOLVED
 * (the email went out; a retry re-sends, deduped by the idempotency key), NOT a clean success and NOT
 * an idempotent skip. `stamp: null` = intentionally don't stamp (test/preview sends).
 */
export async function sendThenStampOne(opts: {
  send: () => Promise<{ ok: boolean; error?: string }>;
  stamp: (() => Promise<{ error: unknown | null }>) | null;
}): Promise<{ outcome: SendStepOutcome; error?: string }> {
  const res = await opts.send();
  if (!res.ok) return { outcome: "send_failed", error: res.error }; // NO stamp on a failed send
  if (!opts.stamp) return { outcome: "sent" };
  const { error: stampErr } = await opts.stamp();
  return { outcome: stampErr ? "unresolved" : "sent" };
}

/**
 * A run is `ok` ONLY when nothing failed to send AND every send was stamped. `skipped` (no email)
 * does NOT make it un-ok — there was nothing to deliver (callers may still surface skipped>0
 * separately). A provider failure (`failed`) or an un-stamped send (`unresolved`) degrades the result
 * to a partial the caller must not treat as clean success.
 */
export function sendTallyOk(t: SendTally): boolean {
  return t.failed === 0 && t.unresolved === 0;
}
