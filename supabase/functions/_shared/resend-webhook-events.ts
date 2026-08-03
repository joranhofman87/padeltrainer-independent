/**
 * 10c-b E — the Resend callback, as PRODUCTION-OWNED logic.
 *
 * WHY A SHARED MODULE. `resend-webhook/index.ts` ends in `serve(...)` at module scope, so a test
 * can never import it. Everything that decides what a callback MEANS — which provider events are
 * recognised, how the digest group is correlated, and whether a failure may be acknowledged or
 * must be retried — therefore lives here, where the suite exercises the real thing.
 *
 * WHAT E ADDS. The webhook already recorded deliverability events through `record_email_event`.
 * It did not touch the digest state machine at all: the SQL for that (10c-a3 PR-1,
 * `20261006110000_reconcile_orphan_provider_events.sql`) shipped INERT and says so —
 * "Deploy BEFORE any webhook may ack an `orphan` (PR-2)". This is PR-2. Two gaps close:
 *
 *   * `email.suppressed` / `suppression.removed` were UNMAPPED, so the callback was acknowledged
 *     and thrown away. The database has understood both since `20261006100000` (the provider
 *     suppression axis, `provider_suppressed_active`), so the only thing missing was the
 *     webhook's own map — meaning a Resend suppression never reached `is_email_suppressed`.
 *   * a digest send's callbacks never reached `apply_notification_provider_event`, so a digest
 *     group stayed in `sending` / `awaiting_evidence` until the stale sweep aged it out, and the
 *     orphan queue that exists to correlate an early callback had no producer.
 */

/** Resend event type → the `record_email_event` status this repo stores. */
export const RESEND_EVENT_MAP: Record<string, string> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.delivery_delayed": "delivery_delayed",
  "email.failed": "failed",
  // The two suppression-axis events. `20261006100000` added both to the status CHECK and to
  // record_email_event's provider-suppression branch; only this map was missing, so a Resend
  // suppression list add/remove was acknowledged and discarded.
  "email.suppressed": "suppressed",
  "suppression.removed": "suppression_removed",
};

/**
 * The seven callbacks ADR 0008 §PV gives a digest transition. `suppression.removed` is
 * deliberately absent: it is an address-level recovery, not evidence about any one send, and the
 * transition table has no row for it.
 */
export const DIGEST_TRANSITION_EVENTS = new Set([
  "sent",
  "delivery_delayed",
  "delivered",
  "complained",
  "bounced",
  "failed",
  "suppressed",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The `digest_group_id` tag the adapter puts on every digest send (§PV/§P5).
 *
 * Resend has shipped tags in more than one shape, so BOTH are read: the array-of-pairs form
 * (`[{name,value}]`, which is what the send API takes) and the flat object form some payloads
 * carry. Anything that is not a well-formed uuid is treated as ABSENT rather than passed on —
 * `apply_notification_provider_event` RAISES on a tag it cannot resolve, and inventing a tag
 * from a malformed value would turn a foreign email into a loud, unfixable webhook failure.
 * A genuinely missing tag is fine: the SQL then correlates by provider_message_id.
 */
export function extractDigestGroupId(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const tags = (data as Record<string, unknown>).tags;
  if (Array.isArray(tags)) {
    for (const t of tags) {
      if (!t || typeof t !== "object") continue;
      const pair = t as Record<string, unknown>;
      if (pair.name === "digest_group_id" && typeof pair.value === "string" && UUID_RE.test(pair.value)) {
        return pair.value;
      }
    }
    return null;
  }
  if (tags && typeof tags === "object") {
    const v = (tags as Record<string, unknown>).digest_group_id;
    return typeof v === "string" && UUID_RE.test(v) ? v : null;
  }
  return null;
}

export type ParsedResendEvent = {
  /** The stored status (`record_email_event`'s p_event_type). */
  eventType: string;
  recipient: string;
  resendEmailId: string | null;
  occurredAt: string | null;
  digestGroupId: string | null;
  bounceType: string | null;
  reason: string | null;
  /** Does ADR 0008 §PV give this callback a digest transition? */
  drivesDigest: boolean;
};

/**
 * Normalise a verified Resend payload, or return null for anything this route does not act on
 * (engagement events, unmapped types, a payload with no recipient).
 */
export function parseResendEvent(raw: unknown): ParsedResendEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const evt = raw as Record<string, unknown>;
  const data = (evt.data && typeof evt.data === "object" ? evt.data : {}) as Record<string, unknown>;

  const eventType = RESEND_EVENT_MAP[typeof evt.type === "string" ? evt.type : ""];
  // The address arrives under DIFFERENT keys depending on the event family: a delivery event
  // carries `to` (array or string), while the suppression-list events are about an address rather
  // than a message and carry `email`. Reading only `to` silently discarded every
  // suppression.removed — the callback was acknowledged, record_email_event was never called, and
  // the address stayed provider_suppressed_active for ever. Accepting both is not guesswork: an
  // event with neither is refused below exactly as before.
  const to = data.to;
  const recipient = Array.isArray(to)
    ? to[0]
    : typeof to === "string" && to !== ""
      ? to
      : data.email;
  if (!eventType || typeof recipient !== "string" || recipient === "") return null;

  let bounceType: string | null = null;
  let reason: string | null = null;
  if (eventType === "bounced") {
    const b = (data.bounce && typeof data.bounce === "object" ? data.bounce : {}) as Record<string, unknown>;
    // Conservative: only a clear Permanent bounce suppresses.
    bounceType = b.type === "Permanent" ? "hard" : "soft";
    reason = [b.message, b.subType, b.type].find((v) => typeof v === "string") as string ?? null;
  } else if (eventType === "complained") {
    reason = "spam complaint";
  } else if (eventType === "suppressed") {
    reason = "provider suppression list";
  } else if (eventType === "suppression_removed") {
    reason = "provider suppression removed";
  }

  return {
    eventType,
    recipient,
    resendEmailId: typeof data.email_id === "string" ? data.email_id : null,
    occurredAt: typeof evt.created_at === "string"
      ? evt.created_at
      : typeof data.created_at === "string" ? data.created_at : null,
    digestGroupId: extractDigestGroupId(data),
    bounceType,
    reason,
    drivesDigest: DIGEST_TRANSITION_EVENTS.has(eventType),
  };
}

/**
 * Permanent failures from `apply_notification_provider_event`, by the exception it RAISES.
 *
 * These describe an immutable disagreement between the callback and the stored world — a tag that
 * does not resolve, a group on the wrong channel, an event id re-used with a different payload.
 * Retrying cannot change any of them, so the webhook acknowledges and ALERTS instead of asking
 * Resend to send the same thing again until it gives up. Everything else — a dropped connection,
 * a lock timeout, a deadlock — is transient and must be retried, which is why the classifier
 * matches an explicit list and defaults to TRANSIENT: an unrecognised failure is one we have not
 * reasoned about, and a needless retry is far safer than a silent acknowledgement.
 */
const PERMANENT_APPLY_ERRORS = [
  "unknown/stale digest_group_id",
  "is channel",
  "collision",
];

export function isPermanentApplyError(message: string | null | undefined): boolean {
  if (!message) return false;
  return PERMANENT_APPLY_ERRORS.some((fragment) => message.includes(fragment));
}

/**
 * What `apply_notification_provider_event` returned, and whether an operator should see it.
 *
 * `orphan` is NORMAL — a callback that arrived before the group bound its provider message id is
 * enrolled for reconciliation, which is exactly what the queue is for. `mismatch` is not: the
 * group holds a DIFFERENT provider message id, so something correlated wrongly, and it is
 * enrolled but worth looking at.
 */
export function applyOutcomeNeedsAlert(outcome: string | null | undefined): boolean {
  return outcome === "mismatch";
}

/**
 * The ORDER in which a callback is applied, and what the webhook answers.
 *
 * This is the load-bearing part, so it lives here rather than inline in the handler: a mutation
 * that returned 200 after recording without applying, or that swapped the two calls, would have
 * left every other test in this suite green.
 *
 * RECORD FIRST, deliberately. The deliverability record gates future sends through
 * `is_email_suppressed`, so it is the one that must never be lost; it lands before anything can
 * decide to acknowledge. Both RPCs are idempotent on the same svix id, so a retry after a partial
 * failure re-runs the pair safely — the recorded event is a no-op the second time and the digest
 * transition still gets its chance.
 *
 * ACKNOWLEDGE only what is settled: a permanent digest-side disagreement cannot be fixed by
 * asking Resend to send the same thing again, so it alerts and returns 200. Anything else — a
 * failed record, a transient apply — returns 5xx so the provider retries.
 */
export type CallbackDeps = {
  /** Must REJECT on failure. */
  recordEvent: () => Promise<void>;
  /** Must REJECT on failure. Resolves with `apply_notification_provider_event`'s outcome. */
  applyDigest: () => Promise<string | null>;
  /** Best-effort operator alert; never throws, never blocks the response. */
  alert: (message: string) => Promise<void>;
};

export type CallbackResult = {
  status: number;
  digestOutcome: string | null;
  /** For the log line — which step decided the status. */
  step: "recorded" | "record_failed" | "digest_apply_failed" | "digest_apply_permanent";
};

export async function handleResendCallback(
  parsed: ParsedResendEvent,
  deps: CallbackDeps,
): Promise<CallbackResult> {
  try {
    await deps.recordEvent();
  } catch (e) {
    await deps.alert(`record_email_event failed: ${errText(e)}`);
    return { status: 500, digestOutcome: null, step: "record_failed" };   // 5xx → Resend retries
  }

  if (!parsed.drivesDigest) {
    return { status: 200, digestOutcome: null, step: "recorded" };
  }

  let digestOutcome: string | null = null;
  try {
    digestOutcome = await deps.applyDigest();
  } catch (e) {
    const message = errText(e);
    if (isPermanentApplyError(message)) {
      await deps.alert(`digest provider event permanently rejected: ${message}`);
      return { status: 200, digestOutcome: null, step: "digest_apply_permanent" };
    }
    await deps.alert(`apply_notification_provider_event failed: ${message}`);
    return { status: 500, digestOutcome: null, step: "digest_apply_failed" };
  }

  if (applyOutcomeNeedsAlert(digestOutcome)) {
    await deps.alert("digest provider event did not match its group's provider message id");
  }
  return { status: 200, digestOutcome, step: "recorded" };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
