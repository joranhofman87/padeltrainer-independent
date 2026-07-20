import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendPlayerBookingConfirmation } from "./booking-confirmation-email.ts";
import { renderStaffBookingEmail } from "./staff-booking-email.ts";

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
        error: String(invoiceError),
      });
    } else {
      logStep("Auto-create invoice triggered");
      invoiceId = (invoiceRes as { invoiceId?: string } | null)?.invoiceId ?? null;
    }
  } catch (invoiceErr) {
    logStep("Auto-create invoice error (non-fatal)", { error: String(invoiceErr) });
    await notifySlackError(source, "auto-create-invoice failed after paid transition", {
      bookingIds,
      error: String(invoiceErr),
    });
  }

  try {
    // Fetch booking details for the confirmation email + Slack (use first booking)
    const bookingId = bookingIds[0];
    const { data: booking } = await supabase
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
      .eq("id", bookingId)
      .single();

    // Trainer display name — used by the player confirmation, the staff
    // notifications and the Slack ping below.
    let trainerName = "Unknown";
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

    // Player-facing PAYMENT CONFIRMATION: ONE friendly email for BOTH a registered
    // player and a guest, single-slot or cyclus — "what you booked" + the invoice PDF
    // (the same artifact the bookkeeper receives) + a "sign in / create an account to
    // see your sessions" link. Replaces the two older divergent emails (a player
    // booking_confirmation with NO pdf; the guest's raw invoice email). Non-fatal; the
    // caller's atomic paid claim already guards against a double-send.
    const confirmation = await sendPlayerBookingConfirmation({ supabase, bookingIds, invoiceId, molliePaymentId, logStep });
    if (!confirmation.ok) {
      const { reason, skipReason } = confirmation;
      // A 'skipped' outcome already left a VISIBLE required-but-undeliverable row in the
      // outbox, and the email worker raises its own dedup'd ops alert for those — so only
      // log it here (double-alerting would be noise). no_payer / enqueue_failed enqueue
      // NOTHING, so nothing downstream surfaces them — alert LOUDLY. This is the same silent
      // gap that once left a guest cyclus payer (Kim de Kort) with no email; the unified
      // enqueue path plus this alert means no payer type can fall through again.
      if (reason === "skipped") {
        logStep("Paid booking confirmation is a visible skipped row (worker will alert)", { bookingIds, skipReason });
      } else {
        await notifySlackError(source, "paid booking confirmation could not be enqueued", {
          bookingIds,
          reason,
        });
      }
    }

    // Slack payment_received — for player AND guest bookings alike. (This used to be
    // nested inside the player-email guard above, so guest payments never pinged.)
    if (booking) {
      try {
        await supabase.functions.invoke("slack-notify", {
          body: {
            event: "payment_received",
            data: {
              player: booking.profiles?.full_name ?? booking.guest_players?.full_name ?? "Guest",
              trainer: trainerName,
              amount: `€${paymentAmountValue || "?"}`,
              bookings: bookingIds.length,
            },
          },
        });
      } catch (slackErr) {
        logStep("Slack notification failed (non-fatal)", { error: String(slackErr) });
      }

      // Staff notifications: the trainer(s) and the academy managers hear about
      // every paid public booking. Trainer emails deliberately carry NO amount
      // (owner decision 2026-07-06: "purely the booking(s) made"); academy
      // manager emails include what was paid. Non-fatal like everything here.
      await sendStaffBookingNotifications({
        supabase,
        bookingIds,
        playerName: booking.profiles?.full_name ?? booking.guest_players?.full_name ?? "Guest",
        paymentAmountValue,
        molliePaymentId,
        invoiceId,
        source,
        logStep,
        notifySlackError,
      });
    }
  } catch (emailError) {
    logStep("Failed to send confirmation email", {
      error: emailError instanceof Error ? emailError.message : String(emailError),
    });
    // Don't throw — email failure must not fail the caller (claim already consumed)
  }
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
}): Promise<void> {
  const { supabase, bookingIds, playerName, paymentAmountValue, molliePaymentId, invoiceId, source, logStep, notifySlackError } = opts;
  try {
    const { data: rows } = await supabase
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
    if (bookings.length === 0) return;

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
    if (academyIds.length > 0) {
      const { data: managers } = await supabase
        .from("academy_managers")
        .select("user_id, academy_profile_id")
        .in("academy_profile_id", academyIds);
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
      const { data: tps } = await supabase
        .from("trainer_profiles")
        .select("id, user_id")
        .in("id", trainerIds);
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
    let enqueueErrors = 0;

    // One booking_confirmed_staff row per recipient. supabase.rpc returns { error } (never
    // throws on a DB error), so inspect it — a swallowed enqueue error is a silent lost notice.
    const enqueueStaff = async (
      userId: string,
      scope: { academy?: string; trainer?: string },
      sessions: StaffSession[],
      amount: string | undefined,
      name: string,
    ) => {
      const { subject, html } = renderStaffBookingEmail({ recipientName: name, playerName, sessions, amount });
      const { error } = await supabase.rpc("enqueue_notification", {
        p_event_key: "booking_confirmed_staff",
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
  } catch (staffErr) {
    logStep("Staff booking notification failed (non-fatal)", { error: String(staffErr) });
    await notifySlackError(source, "staff booking notification failed after paid transition", {
      bookingIds,
      error: String(staffErr),
    });
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
