// G2: deterministic Mollie idempotency key, derived from the request BODY.
//
// Mollie accepts an `Idempotency-Key` header on every POST endpoint. Its contract
// (https://docs.mollie.com/reference/api-idempotency) has TWO edges that jointly
// dictate this design:
//   • Same key + IDENTICAL body, within ~1 hour  → Mollie replays the ORIGINAL
//     response (flagged `Idempotent-Replayed: true`), creating NO duplicate.
//   • Same key + DIFFERENT body                   → Mollie returns 400 Bad Request.
//
// Therefore the key MUST track the body exactly. We derive it as a fingerprint of
// the whole payment body (per function scope):
//   • A legitimate retry re-sends the SAME body → SAME key → Mollie replays →
//     the double-charge-on-timeout vector is closed (existing bookings re-pay,
//     guest single/cyclus, invoice — all have stable bodies across a retry).
//   • A body that genuinely differs (e.g. the pre-booking single path mints a new
//     booking id per call, or a split amount drifts under concurrency) → a
//     DIFFERENT key → a fresh payment. Same as pre-G2 behaviour, and — crucially —
//     never a same-key/different-body 400.
//
// Why fingerprint the body instead of a hand-picked (booking-id, amount) tuple:
// the body carries fields that can drift (the fresh booking id, applicationFee,
// redirectUrl) — omitting any of them risks a same-key/different-body 400. A body
// fingerprint is 400-proof by construction.
//
// CRITICAL: the key must be a FAITHFUL fingerprint of the raw body Mollie receives —
// it must vary iff the raw body varies. So callers are responsible for making the
// raw body itself deterministic across a retry (notably: sort any `booking_ids`
// array before building the body, because Mollie compares the raw array order, and an
// RPC's array_agg order is not stable). We therefore do NOT sort arrays here: sorting
// them would map two different raw bodies to the SAME key, which is exactly the
// same-key/different-body 400 trap. Object-key order IS normalized (semantically
// insignificant to Mollie's parsed params, and our bodies are built deterministically
// anyway) so an incidental key-order change can't spuriously change the fingerprint.
//
// The ~1-hour window covers the retry horizon (seconds/minutes) yet lets a genuinely
// new charge with the same body an hour+ later proceed, so we never permanently
// block a real repeat.

/**
 * Deterministic JSON serialization that is a faithful (injective) function of the
 * value: object keys are sorted recursively (insertion order can't change the
 * fingerprint), but ARRAY ORDER IS PRESERVED (array order is semantically meaningful
 * and is what Mollie diffs in the raw body — see the file header).
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map((x) => canonicalStringify(x)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined) // mirror JSON.stringify: an undefined-valued key is OMITTED, not "null"
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`)
    .join(",")}}`;
}

/**
 * Build a deterministic idempotency key for a Mollie `POST /v2/payments` from the
 * payment body itself.
 *
 * @param scope       short function tag, e.g. "cmp" | "gsp" | "gcp" | "cip"
 * @param paymentBody the exact object serialized as the POST body
 * @returns a 40-char hex key (compact + well within any reasonable server limit)
 */
export async function mollieIdempotencyKey(
  scope: string,
  paymentBody: Record<string, unknown>,
): Promise<string> {
  const basis = `${scope}:${canonicalStringify(paymentBody)}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(basis));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 40);
}
