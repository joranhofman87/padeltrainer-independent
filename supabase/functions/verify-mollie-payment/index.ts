import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { corsHeaders, requireUser } from "../_shared/auth.ts";
import {
  canPlayerVerifyMolliePayment,
  metadataReferencesBooking,
} from "../_shared/booking-access.ts";
import { amountsMatch, parseMollieAmountValue } from "../_shared/booking-pricing.ts";
import { runBookingPaidSideEffects } from "../_shared/mollie-booking-paid-side-effects.ts";
import { applyBookingPaymentWriteback, findCancelledPaidBookings } from "../_shared/mollie-webhook-payment.ts";

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[VERIFY-MOLLIE-PAYMENT] ${step}`, details ? JSON.stringify(details) : "");
};

async function notifySlackError(functionName: string, errorMessage: string, context?: Record<string, unknown>) {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseKey) return;
    const supabase = createClient(supabaseUrl, supabaseKey);
    await supabase.functions.invoke("slack-notify", {
      body: {
        event: "edge_function_error",
        data: {
          function: functionName,
          error: errorMessage.slice(0, 500),
          ...context,
        },
      },
    });
  } catch (_) {
    // Silent
  }
}

async function refreshTokenIfNeeded(
  supabaseClient: any,
  accountData: any,
  entityType: 'trainer' | 'academy',
  entityId: string
): Promise<string | null> {
  const mollieClientId = Deno.env.get("MOLLIE_CLIENT_ID");
  const mollieClientSecret = Deno.env.get("MOLLIE_CLIENT_SECRET");

  if (!mollieClientId || !mollieClientSecret) {
    return accountData.access_token;
  }

  const tokenExpiresAt = new Date(accountData.token_expires_at);
  const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);

  if (tokenExpiresAt > fiveMinutesFromNow) {
    return accountData.access_token;
  }

  logStep("Token expired or expiring soon, refreshing", { expiresAt: tokenExpiresAt.toISOString() });

  if (!accountData.refresh_token) {
    return accountData.access_token;
  }

  try {
    const tokenResponse = await fetch('https://api.mollie.com/oauth2/tokens', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${btoa(`${mollieClientId}:${mollieClientSecret}`)}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: accountData.refresh_token,
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.json().catch(() => ({}));
      logStep("Token refresh failed", errorData);
      // Mollie rejected the refresh token — the connection is broken; payment
      // verification (and online payments) will fail until the account reconnects.
      // Alert ops; this was previously silent (logStep only).
      await notifySlackError(
        "verify-mollie-payment",
        "Mollie token refresh failed — payment verification will fail until the account reconnects",
        { entityType, entityId, mollieStatus: tokenResponse.status, mollieError: (errorData as { error?: string })?.error ?? null },
      );
      return accountData.access_token;
    }

    const tokens = await tokenResponse.json();
    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    const tableName = entityType === 'trainer' ? 'trainer_mollie_accounts' : 'academy_mollie_accounts';
    const idColumn = entityType === 'trainer' ? 'trainer_id' : 'academy_profile_id';

    await supabaseClient
      .from(tableName)
      .update({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: newExpiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq(idColumn, entityId);

    logStep("Token refreshed successfully");
    return tokens.access_token;
  } catch (error) {
    logStep("Error refreshing token", { error: String(error) });
    return accountData.access_token;
  }
}

async function resolveAccessToken(
  supabase: any,
  trainerId: string,
  slotAcademyProfileId?: string | null,
): Promise<string | null> {
  // When the slot names an academy, filter by it so a trainer in 2+ academies resolves to the
  // RIGHT one (else .maybeSingle() collapses on the multiple active rows). This is a CONFIRM path
  // too — it must resolve the same org the charge side used, off the same slot.academy_profile_id
  // (Codex F3). Null (or single-academy trainer) → no-op, unchanged.
  let academyTrainerQuery = supabase
    .from("academy_trainers")
    .select("academy_profile_id, status")
    .eq("trainer_profile_id", trainerId)
    .eq("status", "active");
  if (slotAcademyProfileId) {
    academyTrainerQuery = academyTrainerQuery.eq("academy_profile_id", slotAcademyProfileId);
  }
  const { data: academyTrainer } = await academyTrainerQuery.maybeSingle();

  if (academyTrainer?.academy_profile_id) {
    const { data: academyMollie } = await supabase
      .from("academy_mollie_accounts")
      .select("access_token, refresh_token, token_expires_at, charges_enabled")
      .eq("academy_profile_id", academyTrainer.academy_profile_id)
      .eq("onboarding_complete", true)
      .single();

    if (academyMollie?.access_token && academyMollie?.charges_enabled) {
      const token = await refreshTokenIfNeeded(supabase, academyMollie, 'academy', academyTrainer.academy_profile_id);
      if (token) {
        logStep("Using academy access token", { academyId: academyTrainer.academy_profile_id });
        return token;
      }
    }
  }

  // OWNER INTENT (P1-9): for an academy slot (slotAcademyProfileId set) the recipient is
  // ALWAYS the academy — mirror the charge side (resolveSlotRecipient) and the webhook,
  // which refuse rather than falling back to the trainer. If the academy branch above did
  // not resolve a token, return null so the caller returns a graceful 400 instead of
  // confirming against the trainer's personal Mollie. Keeps charge-org == confirm-org.
  if (slotAcademyProfileId) {
    return null;
  }

  const { data: trainerMollie } = await supabase
    .from("trainer_mollie_accounts")
    .select("access_token, refresh_token, token_expires_at")
    .eq("trainer_id", trainerId)
    .eq("onboarding_complete", true)
    .single();

  if (trainerMollie?.access_token) {
    const token = await refreshTokenIfNeeded(supabase, trainerMollie, 'trainer', trainerId);
    if (token) {
      logStep("Using trainer access token", { trainerId });
      return token;
    }
  }

  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const mollieApiKey = Deno.env.get("MOLLIE_API_KEY");
    if (!mollieApiKey) throw new Error("MOLLIE_API_KEY is not set");

    const authResult = await requireUser(req);
    if (authResult instanceof Response) return authResult;
    if (authResult.isServiceRole) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { supabase, user } = authResult;
    const { bookingId } = await req.json();

    if (!bookingId || typeof bookingId !== "string") {
      return new Response(JSON.stringify({ error: "bookingId is required", paid: false }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logStep("Verifying payment", { bookingId, userId: user.id });

    const { data: booking, error: bookingError } = await supabase
      .from("bookings")
      .select("id, mollie_payment_id, payment_status, payment_amount, player_id, slot_id, availability_slots!inner(trainer_id, academy_profile_id)")
      .eq("id", bookingId)
      .single();

    if (bookingError || !booking) {
      return new Response(JSON.stringify({ error: "Booking not found", paid: false }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const allowed = await canPlayerVerifyMolliePayment(supabase, user.id, booking);
    if (!allowed) {
      return new Response(JSON.stringify({ error: "Forbidden", paid: false }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (booking.payment_status === "paid") {
      logStep("Booking already marked as paid");
      return new Response(
        JSON.stringify({ paid: true, status: "paid" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const molliePaymentId = booking.mollie_payment_id;
    if (!molliePaymentId) {
      return new Response(JSON.stringify({ error: "No payment ID found for booking", paid: false }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const slotsData = booking.availability_slots as unknown as
      { trainer_id: string; academy_profile_id: string | null } | null;
    const trainerId = slotsData?.trainer_id ?? null;
    if (!trainerId) {
      return new Response(JSON.stringify({ error: "Trainer not found for booking", paid: false }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Same slot.academy_profile_id disambiguation as the charge side, so a multi-academy trainer's
    // sync verify hits the SAME connected org the payment was created on (Codex F3).
    const recipientAccessToken = await resolveAccessToken(supabase, trainerId, slotsData?.academy_profile_id ?? null);
    if (!recipientAccessToken) {
      logStep("No connected account token for verification", { trainerId, molliePaymentId });
      return new Response(JSON.stringify({ error: "Payment account unavailable", paid: false }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const isTestMode = mollieApiKey.startsWith("test_");
    let fetchUrl = `https://api.mollie.com/v2/payments/${molliePaymentId}`;
    if (isTestMode) {
      fetchUrl += "?testmode=true";
    }

    logStep("Fetching payment from Mollie", { isTestMode });

    const mollieResponse = await fetch(fetchUrl, {
      headers: {
        "Authorization": `Bearer ${recipientAccessToken}`,
      },
    });

    if (!mollieResponse.ok) {
      const errorText = await mollieResponse.text();
      throw new Error(`Mollie API error: ${errorText}`);
    }

    const payment = await mollieResponse.json();
    logStep("Mollie payment status", {
      paymentId: molliePaymentId,
      status: payment.status,
    });

    if (!metadataReferencesBooking(payment.metadata, bookingId)) {
      logStep("Metadata does not reference booking", { metadata: payment.metadata });
      return new Response(JSON.stringify({ error: "Payment does not match booking", paid: false }), {
        status: 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const metadataIds: string[] = payment.metadata?.booking_ids?.length
      ? payment.metadata.booking_ids
      : payment.metadata?.booking_id
        ? [payment.metadata.booking_id]
        : [bookingId];

    const { data: relatedBookings } = await supabase
      .from("bookings")
      .select("id, payment_amount, status, payment_status")
      .in("id", metadataIds);

    const expectedSum = (relatedBookings || []).reduce(
      (sum, b) => sum + (Number(b.payment_amount) || 0),
      0,
    );
    const paidValue = parseMollieAmountValue(payment.amount?.value);

    const isPaid = payment.status === "paid";

    // Tolerance scales with booking count (per-booking amounts are cent-rounded),
    // mirroring the webhook — a flat 1ct tolerance wrongly rejected legitimate
    // multi-session payments on the success-page fallback.
    const sumTolerance = Math.max(0.01, (relatedBookings?.length ?? 1) * 0.01);
    if (isPaid && !amountsMatch(expectedSum, paidValue, sumTolerance)) {
      logStep("Amount mismatch — refusing to mark paid", { expectedSum, paidValue, metadataIds, sumTolerance });
      await notifySlackError("verify-mollie-payment", "Payment amount mismatch", {
        bookingId,
        expectedSum,
        paidValue,
      });
      return new Response(
        JSON.stringify({ error: "Payment amount mismatch", paid: false, status: payment.status }),
        { status: 422,
          headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (isPaid) {
      // A paid payment landing on a CANCELLED booking (rolled back after a
      // payment-creation hiccup, then completed out of band). The
      // status!='cancelled' guard on the UPDATE below refuses to resurrect it —
      // but the money WAS received, so surface it for a manual refund / review
      // instead of letting a real payment vanish silently.
      const cancelledPaid = findCancelledPaidBookings(relatedBookings || []);
      if (cancelledPaid.length > 0) {
        logStep("Paid payment on CANCELLED booking(s) — manual refund needed", { cancelledPaid, paymentId: payment.id });
        await notifySlackError("verify-mollie-payment", "Paid Mollie payment landed on CANCELLED booking(s) — money received, no active booking. Manual refund / review needed.", {
          bookingIds: cancelledPaid,
          paymentId: payment.id,
        });
      }

      // M-26: mark EVERY booking covered by this payment paid (the amount
      // check above already verified the sum across all of them), mirroring
      // the webhook. The `.neq` + `.select` make this UPDATE an atomic
      // idempotency claim shared with the webhook (E-15): whichever request
      // transitions the rows first runs the paid side effects (invoice
      // creation + confirmation email) exactly once; the other sees zero
      // transitioned rows and skips them. The status!='cancelled' guard mirrors
      // applyBookingPaymentWriteback so a late payment can't resurrect a
      // cancelled booking on this path either.
      // P1-4: route through the shared, 23505-tolerant writeback so a
      // payment_pending HOLD flipped paid here can't collide with the M-17
      // (slot, guest|player) index and 500 the verify. Returns the SURVIVOR/
      // transitioned id set (colliding hold cancelled, survivor stamped paid).
      let transitionedRows: { id: string }[] = [];
      let writebackFailed = false;
      try {
        transitionedRows = await applyBookingPaymentWriteback(supabase, metadataIds, {
          payment_status: "paid",
          status: "confirmed",
          mollie_transaction_id: payment.id,
          paid_at: new Date().toISOString(),
        });
      } catch (writebackErr) {
        writebackFailed = true;
        logStep("Warning: Failed to update bookings", {
          error: writebackErr instanceof Error ? writebackErr.message : String(writebackErr),
        });
      }

      if (!writebackFailed) {
        const paidIds = transitionedRows.map((r) => r.id);
        logStep("Bookings updated to paid", {
          metadataIds,
          transitioned: paidIds.length,
        });

        if (paidIds.length > 0) {
          // Before this, bookings verified here got no invoice and no
          // confirmation email — and the late webhook skipped them forever
          // because they were already paid (M-26). Key side-effects off the
          // SURVIVOR/paid ids, not the raw metadata list (P1-4).
          await runBookingPaidSideEffects({
            supabase,
            bookingIds: paidIds,
            paymentAmountValue: payment.amount?.value,
            molliePaymentId: payment.id,
            source: "verify-mollie-payment",
            logStep,
            notifySlackError,
          });
        }
      }
    }

    return new Response(
      JSON.stringify({
        paid: isPaid,
        status: payment.status,
        amount: payment.amount,
        paidAt: payment.paidAt,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    await notifySlackError("verify-mollie-payment", message);
    return new Response(
      JSON.stringify({ error: message, paid: false }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
