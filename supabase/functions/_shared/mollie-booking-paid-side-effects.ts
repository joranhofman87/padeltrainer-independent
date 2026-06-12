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

  // Auto-create invoice (auto-create-invoice dedupes internally)
  try {
    const { error: invoiceError } = await supabase.functions.invoke("auto-create-invoice", {
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
    }
  } catch (invoiceErr) {
    logStep("Auto-create invoice error (non-fatal)", { error: String(invoiceErr) });
    await notifySlackError(source, "auto-create-invoice failed after paid transition", {
      bookingIds,
      error: String(invoiceErr),
    });
  }

  try {
    // Fetch booking details for email (use first booking)
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
        )
      `)
      .eq("id", bookingId)
      .single();

    if (booking?.profiles?.email) {
      // Trigger confirmation email via send-email function
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

      // Slack notification for payment received
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
              player: booking.profiles.full_name,
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
