import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

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

    if (booking?.profiles?.email) {
      // Player booking: the player confirmation email via send-email.
      await supabase.functions.invoke("send-email", {
        body: {
          to: booking.profiles.email,
          subject: "Booking Confirmed",
          template: "booking_confirmation",
          data: {
            playerName: booking.profiles.full_name,
            startTime: booking.availability_slots.start_time,
            location: booking.availability_slots.locations?.name,
          },
        },
      });
      logStep("Confirmation email sent");
    } else if (booking?.guest_player_id) {
      // GUEST booking (player_id NULL → the profiles join above is empty): send the
      // INVOICE email — the attached PDF itemizes every paid session and
      // send-invoice-email resolves the guest's address itself
      // (get_invoice_recipient_identity). Before this branch existed, guests got NO
      // post-payment email at all (public-booking audit P1-5): only the player_id
      // profile was consulted, so the guard silently skipped them. Duplicate
      // deliveries are already double-guarded (the caller's atomic paid claim +
      // send-invoice-email's own recent-send window).
      let targetInvoiceId = invoiceId;
      if (!targetInvoiceId) {
        // Invoke response carried no id (transient, or the invoice pre-existed via
        // dedup) — fall back to the invoice overlapping these bookings.
        const { data: inv } = await supabase
          .from("invoices")
          .select("id")
          .overlaps("booking_ids", bookingIds)
          .neq("status", "cancelled")
          .limit(1)
          .maybeSingle();
        targetInvoiceId = (inv as { id?: string } | null)?.id ?? null;
      }
      if (targetInvoiceId) {
        // send-invoice-email is verify_jwt-gated → pass explicit service auth (the
        // create-rebook-invoice pattern). Deno.env via globalThis so this helper
        // stays importable in the Node test runner.
        const serviceKey = (globalThis as { Deno?: { env?: { get?: (k: string) => string | undefined } } })
          .Deno?.env?.get?.("SUPABASE_SERVICE_ROLE_KEY");
        await supabase.functions.invoke("send-invoice-email", {
          body: { invoiceId: targetInvoiceId },
          ...(serviceKey ? { headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey } } : {}),
        });
        logStep("Guest confirmation email sent (invoice email)", { invoiceId: targetInvoiceId });
      } else {
        // Non-fatal, but alert: money landed and the guest heard nothing.
        logStep("Guest confirmation email skipped — no invoice id resolved");
        await notifySlackError(source, "guest paid but no invoice found for the confirmation email", {
          bookingIds,
        });
      }
    }

    // Slack payment_received — for player AND guest bookings alike. (This used to be
    // nested inside the player-email guard above, so guest payments never pinged.)
    if (booking) {
      const trainerProfileId = booking.availability_slots.trainer_id;
      let trainerName = "Unknown";
      if (trainerProfileId) {
        const { data: tp } = await supabase
          .from("trainer_profiles")
          .select("user_id")
          .eq("id", trainerProfileId)
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
    }
  } catch (emailError) {
    logStep("Failed to send confirmation email", {
      error: emailError instanceof Error ? emailError.message : String(emailError),
    });
    // Don't throw — email failure must not fail the caller (claim already consumed)
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
