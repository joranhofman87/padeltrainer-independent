import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendPlayerBookingConfirmation } from "./booking-confirmation-email.ts";
import { renderStaffBookingEmail } from "./staff-booking-email.ts";
import { writePaymentAuditLog, PaymentAuditStatus } from "./payment-audit.ts";
import { redactDetail } from "./redact-detail.ts";
import { occurrenceForBookingEvent } from "./notification-occurrence.ts";
import { personDisplayName } from "./person-identity.ts";

type LogStep = (step: string, details?: Record<string, unknown>) => void;
type NotifySlackError = (
  functionName: string,
  errorMessage: string,
  context?: Record<string, unknown>,
) => Promise<void>;

/**
 * Side effects for the FIRST transition of a set of bookings to paid:
 * invoice auto-creation, the player confirmation email and the Slack
 * payment-received ping.
 *
 * Shared by mollie-webhook and verify-mollie-payment (M-26) so whichever path
 * flips the bookings to paid first runs the exact same side effects — before
 * this existed, verify-mollie-payment marked bookings paid WITHOUT them and
 * the late webhook then skipped them forever.
 *
 * Callers MUST gate this behind an atomic claim (UPDATE ... .neq
 * payment_status 'paid' ... .select() returning >0 rows, E-15) so duplicate
 * concurrent deliveries cannot double-send. Failures in here are non-fatal by
 * design: the paid claim is already consumed, so failing the request would
 * not make a retry re-enter — we alert instead.
 */
export async function runBookingPaidSideEffects(opts: {
  supabase: SupabaseClient;
  bookingIds: string[];
  /** payment.amount.value as reported by Mollie — display only, never used for math. */
  paymentAmountValue?: string;
  /** Mollie payment id — threaded to the resolver as the confirmation's idempotency subject. */
  molliePaymentId?: string;
  /** Calling function name, used in log + Slack context. */
  source: string;
  logStep: LogStep;
  notifySlackError: NotifySlackError;
}): Promise<void> {
  const { supabase, bookingIds, paymentAmountValue, molliePaymentId, source, logStep, notifySlackError } = opts;

  // P2-12: settle the slot_priority_claims row for a paid strict-hold booking on
  // WHICHEVER path (webhook OR verify-mollie-payment) first flips it paid. If only
  // the webhook did this, a webhook-loss left the claim 'pending' → the expiry cron
  // (expire_lapsed_priority_claims) expired it and computeReleasedSlotIds — which
  // inspects claim state, not whether a PAID booking occupies the seat — released
  // the PAID seat to the public tier (overbook). Non-fatal by design.
  await finalizePriorityClaims(supabase, bookingIds, logStep);

  // Auto-create invoice (auto-create-invoice dedupes internally). Capture the minted
  // invoice id — the guest confirmation below emails the INVOICE (send-invoice-email),
  // because a guest has no profile email for the player template.
  let invoiceId: string | null = null;
  try {
    const { data: invoiceRes, error: invoiceError } = await supabase.functions.invoke("auto-create-invoice", {
      body: { bookingIds },
    });
    if (invoiceError) {
      logStep("Auto-create invoice failed (non-fatal)", { error: String(invoiceError) });
      // The paid claim is consumed, so no webhook retry will recreate this
      // invoice — alert so it can be created manually.
      await notifySlackError(source, "auto-create-invoice failed after paid transition", {
        bookingIds,
        error: redactDetail(String(invoiceError)),
      });
    } else {
      logStep("Auto-create invoice triggered");
      invoiceId = (invoiceRes as { invoiceId?: string } | null)?.invoiceId ?? null;
    }
  } catch (invoiceErr) {
    logStep("Auto-create invoice error (non-fatal)", { error: String(invoiceErr) });
    await notifySlackError(source, "auto-create-invoice failed after paid transition", {
      bookingIds,
      error: redactDetail(String(invoiceErr)),
    });
  }

  /**
   * From here on, each notification LANE runs inside its OWN boundary.
   *
   * These are independent messages to different people. Before, one `try` wrapped the
   * booking fetch, the player confirmation, the Slack ping AND the staff fan-out, and its
   * `catch` only logged — so a single throw anywhere silently lost ALL of them at once,
   * with no alert, no outbox row and nothing to find afterwards. That is exactly what
   * happened to the 2026-07-20 paid guest booking (tr_NSYo…): the invoice was created and
   * mailed to the bookkeeper, and the paying guest plus every staff recipient got nothing.
   *
   * So: the display-name fetch cannot gate the fan-out, the player lane cannot take out
   * the staff lane, and every lane that fails ALERTS rather than whispering into a log.
   */
  // Every count below is a count of ROWS enqueue_notification actually returned. `ok` is not
  // enough: an idempotent no-op ('already_enqueued') is ok=true and produced NOTHING this run,
  // and a 'skipped' row is a real row but NOT a delivery. An audit that blurred those would
  // report a healthy send for the exact situation it exists to expose.
  let playerRows = 0;
  let playerNoop = 0;
  let staffRows = 0;
  let staffSkipped = 0;
  let staffNoop = 0;
  let skippedRows = 0;
  let laneErrors = 0;
  // Reported SEPARATELY from laneErrors. Folding staff faults into one total makes the audit
  // ambiguous ("something failed") and makes any test asserting on it satisfiable by the other
  // lane — which is exactly how three pins for this passed while the staff code was reverted.
  let staffErrors = 0;
  let playerStatus = "none";
  let playerDetail: string | null = null;   // sanitized, length-bounded failure detail for the durable audit + alert

  // Booking context — display names for the Slack ping and the staff email only. Its
  // failure must NOT skip the fan-out: sendStaffBookingNotifications re-reads the
  // bookings itself and needs this purely for a name, so degrade to "Guest" instead.
  type BookingCtx = {
    player_id?: string | null;
    guest_player_id?: string | null;
    profiles?: { full_name?: string | null } | null;
    guest_players?: { full_name?: string | null } | null;
    availability_slots?: { trainer_id?: string | null } | null;
  };
  let booking: BookingCtx | null = null;
  let trainerName = "Unknown";
  try {
    const { data, error } = await supabase
      .from("bookings")
      .select(`
        *,
        availability_slots!inner(
          start_time,
          end_time,
          trainer_id,
          academy_profile_id,
          cyclus_name,
          locations(name, city)
        ),
        profiles!bookings_player_id_fkey(
          full_name,
          email
        ),
        guest_players(
          full_name
        )
      `)
      .eq("id", bookingIds[0])
      .single();
    // Inspect the error: supabase-js RESOLVES on a failed query, so the old
    // `const { data: booking }` turned a broken embed into a silent null.
    if (error) {
      logStep("Booking context fetch failed (names degrade, fan-out continues)", { error: error.message });
    } else {
      booking = data as unknown as BookingCtx;
    }

    if (booking?.availability_slots?.trainer_id) {
      const { data: tp } = await supabase
        .from("trainer_profiles")
        .select("user_id")
        .eq("id", booking.availability_slots.trainer_id)
        .single();
      if (tp?.user_id) {
        const { data: prof } = await supabase
          .from("profiles")
          .select("full_name")
          .eq("user_id", tp.user_id)
          .single();
        trainerName = prof?.full_name || "Unknown";
      }
    }
  } catch (nameErr) {
    logStep("Booking context fetch threw (names degrade, fan-out continues)", { error: String(nameErr) });
  }

  // GUEST-FIRST canonical identity, keyed on the row's IDs (person-identity twin): staff must
  // see the guest/child name on a guest booking, never the linked parent/profile name.
  const playerName = personDisplayName(
    booking ?? {},
    { profileName: booking?.profiles?.full_name, guestName: booking?.guest_players?.full_name },
    "Guest",
  );

  // LANE 1 — the payer's confirmation. Required delivery: a failure here is a paying
  // customer with no proof of purchase, so it alerts.
  try {
    const confirmation = await sendPlayerBookingConfirmation({ supabase, bookingIds, invoiceId, molliePaymentId, logStep });
    if (confirmation.ok) {
      playerStatus = confirmation.status ?? "unknown";
      // 'already_enqueued' = the idempotency key existed (duplicate webhook/verify delivery).
      // Correct behaviour, but no row was produced by THIS run — count it separately.
      if (playerStatus === "already_enqueued") playerNoop++;
      else playerRows++;
    } else {
      const { reason, skipReason } = confirmation;
      // A 'skipped' outcome already left a VISIBLE required-but-undeliverable row in the
      // outbox, and the email worker raises its own dedup'd ops alert for those — so only
      // log it here (double-alerting would be noise). no_payer / enqueue_failed enqueue
      // NOTHING, so nothing downstream surfaces them — alert LOUDLY.
      playerStatus = reason ?? "unknown";
      // Preserve the helper's detail. Production logs were unavailable during the original
      // incident, so a short sanitized code/detail must survive to the DURABLE audit row and
      // the alert — not just the terminal 'reason'.
      playerDetail = confirmation.detail ? redactDetail(confirmation.detail) : null;
      if (reason === "skipped") {
        skippedRows++;
        logStep("Paid booking confirmation is a visible skipped row (worker will alert)", { bookingIds, skipReason });
      } else {
        laneErrors++;
        await notifySlackError(source, "paid booking confirmation could not be enqueued", { bookingIds, reason, detail: playerDetail });
      }
    }
  } catch (playerErr) {
    // A THROW used to be indistinguishable from success. It is the loudest case of all:
    // the payer is owed a required email and nothing downstream will ever surface it.
    laneErrors++;
    playerStatus = "threw";
    playerDetail = redactDetail(String(playerErr));
    logStep("Player confirmation threw", { error: String(playerErr) });
    // Parity with the enqueue_failed branch: the alert carries the SAME sanitized,
    // length-bounded detail that goes to the durable audit, not a differently-shaped raw slice.
    await notifySlackError(source, "paid booking confirmation THREW — payer has no confirmation", {
      bookingIds,
      detail: playerDetail,
    });
  }

  // LANE 2 — Slack payment_received. Cosmetic ops noise, and deliberately still gated on a
  // readable booking: with no booking there is genuinely nothing to report ("Guest"/"Unknown"
  // /€? helps nobody). This gate is SAFE because it guards only the ping — unlike before,
  // it no longer also decides whether staff hear about the payment.
  try {
    if (booking) await supabase.functions.invoke("slack-notify", {
      body: {
        event: "payment_received",
        data: {
          player: playerName,
          trainer: trainerName,
          amount: `€${paymentAmountValue || "?"}`,
          bookings: bookingIds.length,
        },
      },
    });
  } catch (slackErr) {
    logStep("Slack notification failed (non-fatal)", { error: String(slackErr) });
  }

  // LANE 3 — staff fan-out. Runs unconditionally now: it was gated on `if (booking)`, so a
  // failed display-name fetch silently cancelled every trainer and manager notification.
  try {
    const staff = await sendStaffBookingNotifications({
      supabase,
      bookingIds,
      playerName,
      paymentAmountValue,
      molliePaymentId,
      invoiceId,
      source,
      logStep,
      notifySlackError,
    });
    staffRows += staff?.enqueued ?? 0;
    staffSkipped += staff?.skipped ?? 0;
    staffNoop += staff?.noop ?? 0;
    staffErrors += staff?.errors ?? 0;
  } catch (staffErr) {
    staffErrors++;
    logStep("Staff fan-out threw", { error: String(staffErr) });
    await notifySlackError(source, "staff booking fan-out THREW — no staff were notified", {
      bookingIds,
      error: redactDetail(String(staffErr)),
    });
  }

  // Observability: one durable row per paid booking saying what the notification side
  // effects actually produced. Zero-everything is now VISIBLE in the same table that
  // already proves the payment transitioned, instead of requiring log forensics.
  await writePaymentAuditLog(supabase, {
    function_name: source,
    booking_id: bookingIds[0] ?? null,
    mollie_payment_id: molliePaymentId ?? null,
    invoice_id: invoiceId ?? null,
    status: PaymentAuditStatus.bookingPaidNotifications,
    metadata: {
      playerRows, playerNoop, playerStatus, playerDetail,
      staffRows, staffSkipped, staffNoop, staffErrors,
      skippedRows, laneErrors,
      bookingCount: bookingIds.length,
    },
  });
  logStep("Paid-booking notifications complete", {
    playerRows, playerNoop, playerStatus, staffRows, staffSkipped, staffNoop, staffErrors, skippedRows, laneErrors,
  });
}

/** Format a timestamptz for staff/player emails in the platform's home timezone. */
function formatAmsterdam(iso: string, kind: "date" | "time"): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return kind === "date"
    ? new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(d)
    : new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit" }).format(d);
}

type StaffSession = { date: string; time: string; location: string; name: string };

/**
 * Notify the slot owners about a paid public booking — now via the notification OUTBOX
 * (booking_confirmed_staff, PR 6b) instead of a direct send-email: one row per TRAINER
 * (their sessions only, NO amount) and one per ACADEMY MANAGER (all sessions + the paid
 * amount). A trainer who is ALSO an academy manager (same account) gets only the academy
 * version. Each row is TENANT-SCOPED — a manager's row to their ACADEMY, a trainer's to
 * their TRAINER — so PR-7 timelines show it only inside that scope, never cross-tenant.
 * Delivery is the resolver's persons.email ACCOUNT fallback (staff are account holders);
 * booking_confirmed_staff is required-delivery, so an account with no reachable email
 * yields a VISIBLE skipped row (the email worker raises the dedup'd ops alert).
 *
 * Idempotency is per recipient (<event>:<payment-subject>:<person>), so a duplicate
 * webhook/verify delivery re-enqueues to a no-op. Non-fatal by design; a failure alerts
 * Slack (the paid claim is consumed, so nothing retries this).
 */
export async function sendStaffBookingNotifications(opts: {
  supabase: SupabaseClient;
  bookingIds: string[];
  playerName: string;
  paymentAmountValue?: string;
  /** Mollie payment id — the confirmation's idempotency subject (shared with the player row). */
  molliePaymentId?: string;
  /** Invoice minted for these bookings — recorded as a relation so the INVOICE timeline (PR 7) shows these staff rows. */
  invoiceId?: string | null;
  source: string;
  logStep: LogStep;
  notifySlackError: NotifySlackError;
}): Promise<{ enqueued: number; skipped: number; noop: number; errors: number }> {
  const { supabase, bookingIds, playerName, paymentAmountValue, molliePaymentId, invoiceId, source, logStep, notifySlackError } = opts;
  try {
    // RECIPIENT-DISCOVERY read. supabase-js RESOLVES on a failed query, so `data: null` +
    // error used to collapse into `rows ?? []` → "no bookings" → a clean {enqueued:0,errors:0}.
    // That is a silent zero-row SUCCESS for the staff lane: indistinguishable, in the audit,
    // from a booking that genuinely has no staff. Discovery failures must be loud; only
    // display-NAME reads may degrade.
    const { data: rows, error: rowsErr } = await supabase
      .from("bookings")
      .select(`
        id,
        availability_slots!inner(
          start_time,
          end_time,
          trainer_id,
          academy_profile_id,
          cyclus_name,
          locations(name)
        )
      `)
      .in("id", bookingIds);
    if (rowsErr) {
      logStep("Staff fan-out: booking read FAILED — recipients unknown", { error: rowsErr.message });
      await notifySlackError(source, "staff fan-out could not read bookings — no staff notified", {
        bookingIds,
        error: redactDetail(rowsErr.message),
      });
      return { enqueued: 0, skipped: 0, noop: 0, errors: 1 };
    }
    const bookings = (rows ?? []) as unknown as Array<{
      id: string;
      availability_slots: {
        start_time: string;
        end_time: string;
        trainer_id: string | null;
        academy_profile_id: string | null;
        cyclus_name: string | null;
        locations: { name: string | null } | null;
      };
    }>;
    if (bookings.length === 0) return { enqueued: 0, skipped: 0, noop: 0, errors: 0 };

    const toSession = (b: (typeof bookings)[number]): StaffSession => ({
      date: formatAmsterdam(b.availability_slots.start_time, "date"),
      time: `${formatAmsterdam(b.availability_slots.start_time, "time")}–${formatAmsterdam(b.availability_slots.end_time, "time")}`,
      location: b.availability_slots.locations?.name ?? "",
      name: b.availability_slots.cyclus_name ?? "",
    });

    // Academy recipients first (they win the person-dedupe): each manager of each academy
    // involved, all sessions, amount included. Keyed by user_id (the account the resolver's
    // persons.email fallback delivers to), carrying the academy for the row's tenant scope.
    const academyIds = [...new Set(bookings.map((b) => b.availability_slots.academy_profile_id).filter(Boolean))] as string[];
    const academyUserIds = new Set<string>();
    const academyRecipients: Array<{ userId: string; name: string; academyId: string }> = [];
    let discoveryErrors = 0;
    if (academyIds.length > 0) {
      // Another RECIPIENT-DISCOVERY read: its failure means managers are UNKNOWN, not absent.
      // Counted + alerted, but it does not abort — trainers are discovered independently and
      // should still hear about the payment.
      const { data: managers, error: mgrErr } = await supabase
        .from("academy_managers")
        .select("user_id, academy_profile_id")
        .in("academy_profile_id", academyIds);
      if (mgrErr) {
        discoveryErrors++;
        logStep("Staff fan-out: academy manager read FAILED", { error: mgrErr.message });
        await notifySlackError(source, "academy managers could not be resolved — they were NOT notified", {
          bookingIds,
          error: redactDetail(mgrErr.message),
        });
      }
      const mgrRows = (managers ?? []) as Array<{ user_id: string; academy_profile_id: string }>;
      const managerUserIds = [...new Set(mgrRows.map((m) => m.user_id))];
      const nameByUser = new Map<string, string | null>();
      if (managerUserIds.length > 0) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("user_id, full_name")
          .in("user_id", managerUserIds);
        for (const p of (profs ?? []) as Array<{ user_id: string; full_name: string | null }>) nameByUser.set(p.user_id, p.full_name);
      }
      for (const m of mgrRows) {
        if (academyUserIds.has(m.user_id)) continue; // one row per manager (first academy wins)
        academyUserIds.add(m.user_id);
        academyRecipients.push({ userId: m.user_id, name: nameByUser.get(m.user_id) ?? "", academyId: m.academy_profile_id });
      }
    }

    // Trainer recipients: per trainer, their own sessions, NO amount. A trainer who is also
    // an academy manager (same account) already has the academy row → skip.
    const trainerIds = [...new Set(bookings.map((b) => b.availability_slots.trainer_id).filter(Boolean))] as string[];
    const trainerRecipients: Array<{ userId: string; name: string; trainerId: string; sessions: StaffSession[] }> = [];
    if (trainerIds.length > 0) {
      const { data: tps, error: tpsErr } = await supabase
        .from("trainer_profiles")
        .select("id, user_id")
        .in("id", trainerIds);
      if (tpsErr) {
        discoveryErrors++;
        logStep("Staff fan-out: trainer profile read FAILED", { error: tpsErr.message });
        await notifySlackError(source, "trainers could not be resolved — they were NOT notified", {
          bookingIds,
          error: redactDetail(tpsErr.message),
        });
      }
      const tpList = (tps ?? []) as Array<{ id: string; user_id: string | null }>;
      const userIds = [...new Set(tpList.map((t) => t.user_id).filter(Boolean))] as string[];
      const nameByUser = new Map<string, string | null>();
      if (userIds.length > 0) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("user_id, full_name")
          .in("user_id", userIds);
        for (const p of (profs ?? []) as Array<{ user_id: string; full_name: string | null }>) nameByUser.set(p.user_id, p.full_name);
      }
      for (const tp of tpList) {
        if (!tp.user_id || academyUserIds.has(tp.user_id)) continue; // no account, or gets the academy version instead
        trainerRecipients.push({
          userId: tp.user_id,
          name: nameByUser.get(tp.user_id) ?? "",
          trainerId: tp.id,
          sessions: bookings.filter((b) => b.availability_slots.trainer_id === tp.id).map(toSession),
        });
      }
    }

    const allSessions = bookings.map(toSession);
    // WHEN IT HAPPENED, from the bookings this payment paid for. A Mollie webhook can be
    // redelivered long after the fact and the verify path re-runs on demand, so the enqueue
    // instant is not the event instant — and the activation boundary measures the event.
    const occurredAt = await occurrenceForBookingEvent(supabase, bookingIds, "paid");
    let enqueueErrors = 0;
    // Counted from the ROWS enqueue_notification returns, never from the recipient list:
    // the resolver can legitimately answer [] (idempotent no-op) or a 'skipped' row with NO
    // error, and an audit that counted attempts would claim a notification that never exists.
    let enqueuedRows = 0;
    let skippedStaffRows = 0;
    let noopStaffRows = 0;

    // One booking_confirmed_staff row per recipient. supabase.rpc returns { error } (never
    // throws on a DB error), so inspect it — a swallowed enqueue error is a silent lost notice.
    const enqueueStaff = async (
      userId: string,
      scope: { academy?: string; trainer?: string },
      sessions: StaffSession[],
      amount: string | undefined,
      name: string,
    ) => {
      if (!occurredAt) {
        // Fail closed: a notification we cannot date is one we do not send. Falling back to now()
        // here would re-open the exact hole the occurrence boundary exists to close.
        enqueueErrors++;
        logStep("Staff notification enqueue refused: the booking's occurrence time could not be established", { userId });
        return;
      }
      const { subject, html } = renderStaffBookingEmail({ recipientName: name, playerName, sessions, amount });
      const { data: emitted, error } = await supabase.rpc("enqueue_notification", {
        p_event_key: "booking_confirmed_staff",
        p_occurred_at: occurredAt,
        p_recipient_user_id: userId,
        p_tenant_academy_profile_id: scope.academy ?? null,
        p_tenant_trainer_id: scope.trainer ?? null,
        p_related_booking_ids: bookingIds,
        p_related_invoice_id: invoiceId ?? null,
        p_related_payment_id: molliePaymentId ?? null,
        p_payload: { subject, html },
        p_public_summary: { event_type: "booking_confirmed_staff", sessions: sessions.length },
      });
      if (error) {
        enqueueErrors++;
        logStep("Staff notification enqueue failed", { error: error.message, userId });
        return;
      }
      const rows = (emitted ?? []) as Array<{ channel: string; status: string; skip_reason: string | null }>;
      const emailRow = rows.find((r) => r.channel === "email");
      if (!emailRow) {
        // No row emitted and no error = the idempotency key already existed (a duplicate
        // webhook/verify delivery). Designed no-op — but it is NOT a row this run produced.
        noopStaffRows++;
      } else if (emailRow.status === "skipped") {
        skippedStaffRows++;
        logStep("Staff notification skipped (visible row)", { userId, skipReason: emailRow.skip_reason });
      } else {
        enqueuedRows++;
      }
    };

    const enqueues: Array<Promise<void>> = [];
    for (const r of academyRecipients) {
      enqueues.push(enqueueStaff(r.userId, { academy: r.academyId }, allSessions, paymentAmountValue ? `€${paymentAmountValue}` : undefined, r.name));
    }
    for (const r of trainerRecipients) {
      enqueues.push(enqueueStaff(r.userId, { trainer: r.trainerId }, r.sessions, undefined, r.name));
    }
    await Promise.all(enqueues);

    const total = academyRecipients.length + trainerRecipients.length;
    if (total > 0) {
      logStep("Staff booking notifications enqueued", {
        trainers: trainerRecipients.length,
        academyManagers: academyRecipients.length,
        enqueueErrors,
      });
    }
    if (enqueueErrors > 0) {
      await notifySlackError(source, "some staff booking notifications could not be enqueued", {
        bookingIds,
        enqueueErrors,
      });
    }
    // Counts flow back to the caller's audit row: "0 staff rows" must be visible in the
    // database, not merely absent from a log nobody reads. These are ROW counts — a
    // recipient we tried but the resolver dropped is reported as skipped/noop, not enqueued.
    // discoveryErrors ride in `errors` so an unresolved recipient group can never present as
    // a healthy zero — the audit row shows a non-zero error beside the zero rows.
    return {
      enqueued: enqueuedRows,
      skipped: skippedStaffRows,
      noop: noopStaffRows,
      errors: enqueueErrors + discoveryErrors,
    };
  } catch (staffErr) {
    logStep("Staff booking notification failed (non-fatal)", { error: String(staffErr) });
    await notifySlackError(source, "staff booking notification failed after paid transition", {
      bookingIds,
      error: redactDetail(String(staffErr)),
    });
    return { enqueued: 0, skipped: 0, noop: 0, errors: 1 };
  }
}

/**
 * Mark the slot_priority_claims row for each just-paid booking as 'claimed' (P2-12).
 *
 * Moved here (out of mollie-webhook) so BOTH the webhook and verify-mollie-payment
 * settle the claim the moment they confirm a strict-hold paid booking — independent
 * of webhook delivery. Without this on the verify path, a lost webhook left the
 * claim 'pending', the expiry cron later expired it, and the seat — though PAID —
 * was released to the public tier.
 *
 * Idempotent: only rows still status='pending' are transitioned, so re-running
 * (duplicate delivery, or verify + a late webhook) is a no-op. A claim already
 * 'claimed'/'expired'/'released'/'declined' is left untouched. Each booking is
 * matched by its player_id and/or guest_player_id via separate .eq() updates —
 * behaviour-equivalent to the previous .or() while staying pglite-testable.
 * Non-fatal: failures are logged, not thrown (the paid claim is already consumed).
 */
export async function finalizePriorityClaims(
  supabase: SupabaseClient,
  bookingIds: string[],
  logStep: LogStep,
): Promise<void> {
  if (bookingIds.length === 0) return;
  try {
    const { data: paidBookings } = await supabase
      .from("bookings")
      .select("id, slot_id, player_id, guest_player_id")
      .in("id", bookingIds);
    for (const b of (paidBookings ?? []) as Array<{
      id: string;
      slot_id: string;
      player_id: string | null;
      guest_player_id: string | null;
    }>) {
      const responded_at = new Date().toISOString();
      if (b.player_id) {
        await supabase
          .from("slot_priority_claims")
          .update({ status: "claimed", responded_at, booking_id: b.id })
          .eq("slot_id", b.slot_id)
          .eq("status", "pending")
          .eq("player_id", b.player_id);
      }
      if (b.guest_player_id) {
        await supabase
          .from("slot_priority_claims")
          .update({ status: "claimed", responded_at, booking_id: b.id })
          .eq("slot_id", b.slot_id)
          .eq("status", "pending")
          .eq("guest_player_id", b.guest_player_id);
      }
    }
  } catch (e) {
    logStep("Failed to mark priority claim claimed (non-fatal)", { error: String(e) });
  }
}
