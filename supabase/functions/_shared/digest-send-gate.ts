/**
 * N2 S2b — the SEND-TIME gate for the legacy v1 digest flush (`send-digest-emails`).
 *
 * The gap this closes: an item is queued when the recipient's preference said `daily`/`weekly`,
 * and flushed hours or days later — but the flush re-checked NOTHING. Someone who opted out in
 * the meantime still got the digest, and a hard-bounced address was retried forever. The v2
 * pipeline re-checks at send time by design (its resolver re-validates preference, suppression
 * and destination before freezing); this brings the legacy path up to the same contract until
 * 10c-d retires it.
 *
 * THE RULE IS THE J RULE: only an explicit `off` refuses. A missing preferences row, an unknown
 * column, or a cadence that has since changed (daily↔weekly↔instant) all still send — the item
 * was queued by an affirmative choice, and inferring intent from anything but an explicit opt-out
 * is the model slice J deleted for cause. Do not "improve" this by comparing cadences.
 *
 * Pure and dependency-free so the decision table is unit-tested in Deno; the handler owns the
 * I/O (batch reads BEFORE claiming, so a failed read aborts the run with nothing consumed).
 */

export type GateItem = { id: string; notification_type: string };

export type GateDecision<T extends GateItem> = {
  /** Items whose CURRENT preference still permits the digest — render and send these. */
  send: T[];
  /** Items whose CURRENT preference is 'off' — consume WITHOUT sending. An opt-out is a decision
   *  already taken, not a queue awaiting drainage; releasing these would re-send next run. */
  droppedOff: T[];
};

/**
 * Split a user's claimed items by their CURRENT v1 preference row. `notification_type` is the
 * preference COLUMN name (send-email enqueues it that way), so the lookup is direct.
 */
export function gateDigestItems<T extends GateItem>(
  items: T[],
  prefsRow: Record<string, unknown> | null,
): GateDecision<T> {
  const send: T[] = [];
  const droppedOff: T[] = [];
  for (const item of items) {
    const current = prefsRow?.[item.notification_type];
    if (current === "off") droppedOff.push(item);
    else send.push(item);
  }
  return { send, droppedOff };
}

/**
 * The exact normalization `is_email_suppressed` applies (`lower(btrim(p_email))`), so a batch
 * lookup against `email_address_state.email` (stored normalized) matches what the canonical
 * checker would say per address. Diverging here would let a suppressed address through on a
 * case or whitespace difference.
 */
export function normalizeEmailForSuppression(email: string): string {
  return email.trim().toLowerCase();
}
