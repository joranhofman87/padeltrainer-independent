import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendPlayerBookingConfirmation } from "./booking-confirmation-email.ts";

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
  /** Calling function name, used in log + Slack context. */
  source: string;
  logStep: LogStep;
  notifySlackError: NotifySlackError;
}): Promise<void> {
  const { supabase, bookingIds, paymentAmountValue, source, logStep, notifySlackError } = opts;

  // P2-12: settle the slot_priority_claims row for a paid strict-hold booking on
  // WHICHEVER path (webhook OR verify-mollie-payment) first flips it paid. If only
  // the webhook did this, a webhook-loss left the claim 'pending' → the expiry cron
  // (expire_lapsed_priority_claims) expired it and computeReleasedSlotIds — which
  // inspects claim state, not whether a PAID booking occupies the seat — released
  // the PAID seat to the public tier (overbook). Non-fatal by design.
  await finalizePriorityClaims(supabase, bookingIds, logStep);

  // Auto-create invoice (auto-create-invoice dedupes internally). Capture the minted
  // invoice id — the guest confirmation below emails the INVOICE (send-invoice-email),
  // addressed via the guest row's email: even when the guest ref belongs to a merged
  // login holder (Phase 3.3e), the money/email chain stays guest-keyed (the
  // guest-exclusive recipient rule), so the player template's profile email is not used.
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
    const confirmation = await sendPlayerBookingConfirmation({ supabase, bookingIds, invoiceId, logStep });
    if (!confirmation.ok) {
      const { reason } = confirmation;
      if (reason === "no_payer" || reason === "no_recipient_email") {
        // Money landed but nobody could be emailed — alert LOUDLY. This is exactly the
        // silent gap that once left a guest cyclus payer (Kim de Kort) with no email; a
        // single unified path plus this alert means no payer type can fall through again.
        await notifySlackError(source, "paid booking had no resolvable recipient for the confirmation email", {
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
 * Email the slot owners about a paid public booking: one email per TRAINER
 * (their sessions only, NO amount) and one per ACADEMY MANAGER (all sessions +
 * the paid amount). A trainer whose address is already among the academy
 * recipients gets only the academy version (solo academies would otherwise see
 * every booking twice). Recipients route through send-email's `new_booking`
 * preference, so staff can mute or digest these per user.
 *
 * Non-fatal by design; a failure alerts Slack (the paid claim is consumed, so
 * nothing retries this).
 */
export async function sendStaffBookingNotifications(opts: {
  supabase: SupabaseClient;
  bookingIds: string[];
  playerName: string;
  paymentAmountValue?: string;
  source: string;
  logStep: LogStep;
  notifySlackError: NotifySlackError;
}): Promise<void> {
  const { supabase, bookingIds, playerName, paymentAmountValue, source, logStep, notifySlackError } = opts;
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

    // Academy recipients first (they win the dedupe): every manager of every
    // academy involved, all sessions, amount included.
    const academyIds = [...new Set(bookings.map((b) => b.availability_slots.academy_profile_id).filter(Boolean))] as string[];
    const academyEmails = new Set<string>();
    const academyRecipients: Array<{ email: string; name: string }> = [];
    if (academyIds.length > 0) {
      const { data: managers } = await supabase
        .from("academy_managers")
        .select("user_id")
        .in("academy_profile_id", academyIds);
      const managerUserIds = [...new Set(((managers ?? []) as Array<{ user_id: string }>).map((m) => m.user_id))];
      if (managerUserIds.length > 0) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("user_id, email, full_name")
          .in("user_id", managerUserIds);
        for (const prof of (profs ?? []) as Array<{ user_id: string; email: string | null; full_name: string | null }>) {
          if (!prof.email || academyEmails.has(prof.email)) continue;
          academyEmails.add(prof.email);
          academyRecipients.push({ email: prof.email, name: prof.full_name ?? "" });
        }
      }
    }

    // Trainer recipients: per trainer, their own sessions, NO amount.
    const trainerIds = [...new Set(bookings.map((b) => b.availability_slots.trainer_id).filter(Boolean))] as string[];
    const trainerRecipients: Array<{ email: string; name: string; sessions: StaffSession[] }> = [];
    if (trainerIds.length > 0) {
      const { data: tps } = await supabase
        .from("trainer_profiles")
        .select("id, user_id")
        .in("id", trainerIds);
      const tpList = (tps ?? []) as Array<{ id: string; user_id: string | null }>;
      const userIds = [...new Set(tpList.map((t) => t.user_id).filter(Boolean))] as string[];
      const emailByUser = new Map<string, { email: string | null; full_name: string | null }>();
      if (userIds.length > 0) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("user_id, email, full_name")
          .in("user_id", userIds);
        for (const prof of (profs ?? []) as Array<{ user_id: string; email: string | null; full_name: string | null }>) {
          emailByUser.set(prof.user_id, prof);
        }
      }
      for (const tp of tpList) {
        const prof = tp.user_id ? emailByUser.get(tp.user_id) : undefined;
        if (!prof?.email) continue;
        if (academyEmails.has(prof.email)) continue; // gets the academy version instead
        trainerRecipients.push({
          email: prof.email,
          name: prof.full_name ?? "",
          sessions: bookings.filter((b) => b.availability_slots.trainer_id === tp.id).map(toSession),
        });
      }
    }

    const allSessions = bookings.map(toSession);
    const sends: Array<Promise<unknown>> = [];
    for (const r of trainerRecipients) {
      sends.push(
        supabase.functions.invoke("send-email", {
          body: {
            to: r.email,
            type: "new_public_booking_admin",
            data: { recipientName: r.name, playerName, sessions: r.sessions },
          },
        }),
      );
    }
    for (const r of academyRecipients) {
      sends.push(
        supabase.functions.invoke("send-email", {
          body: {
            to: r.email,
            type: "new_public_booking_admin",
            data: {
              recipientName: r.name,
              playerName,
              sessions: allSessions,
              ...(paymentAmountValue ? { amount: `€${paymentAmountValue}` } : {}),
            },
          },
        }),
      );
    }
    await Promise.all(sends);
    if (sends.length > 0) {
      logStep("Staff booking notifications sent", {
        trainers: trainerRecipients.length,
        academyManagers: academyRecipients.length,
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
