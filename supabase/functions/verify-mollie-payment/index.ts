import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[VERIFY-MOLLIE-PAYMENT] ${step}`, details ? JSON.stringify(details) : "");
};

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
      const errorData = await tokenResponse.json();
      logStep("Token refresh failed", errorData);
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
  trainerId: string
): Promise<string | null> {
  // First check if trainer is part of an active academy
  const { data: academyTrainer } = await supabase
    .from("academy_trainers")
    .select("academy_profile_id, status")
    .eq("trainer_profile_id", trainerId)
    .eq("status", "active")
    .maybeSingle();

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

  // Check trainer's own Mollie account
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

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { bookingId, paymentId } = await req.json();
    logStep("Verifying payment", { bookingId, paymentId });

    if (!bookingId && !paymentId) {
      throw new Error("Either bookingId or paymentId is required");
    }

    let molliePaymentId = paymentId;
    let trainerId: string | null = null;

    // If we have a booking ID, fetch booking details including trainer
    if (bookingId) {
      const { data: booking, error: bookingError } = await supabase
        .from("bookings")
        .select("mollie_payment_id, payment_status, slot_id, availability_slots!inner(trainer_id)")
        .eq("id", bookingId)
        .single();

      if (bookingError) {
        throw new Error(`Booking not found: ${bookingError.message}`);
      }

      // If already paid, return success immediately
      if (booking.payment_status === "paid") {
        logStep("Booking already marked as paid");
        return new Response(
          JSON.stringify({ paid: true, status: "paid" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (!paymentId) {
        molliePaymentId = booking.mollie_payment_id;
      }
      const slotsData = booking.availability_slots as unknown as { trainer_id: string } | null;
      trainerId = slotsData?.trainer_id;
    }

    if (!molliePaymentId) {
      throw new Error("No payment ID found for booking");
    }

    // Resolve the correct access token for this trainer
    let recipientAccessToken: string | null = null;
    if (trainerId) {
      recipientAccessToken = await resolveAccessToken(supabase, trainerId);
    }

    const isTestMode = mollieApiKey.startsWith("test_");
    const authToken = recipientAccessToken || mollieApiKey;
    let fetchUrl = `https://api.mollie.com/v2/payments/${molliePaymentId}`;
    if (isTestMode && recipientAccessToken) {
      fetchUrl += "?testmode=true";
    }

    logStep("Fetching payment from Mollie", { useConnectedToken: !!recipientAccessToken, isTestMode });

    // Fetch payment status from Mollie
    const mollieResponse = await fetch(fetchUrl, {
      headers: {
        "Authorization": `Bearer ${authToken}`,
      },
    });

    if (!mollieResponse.ok) {
      const errorText = await mollieResponse.text();
      throw new Error(`Mollie API error: ${errorText}`);
    }

    const payment = await mollieResponse.json();
    logStep("Mollie payment status", { 
      paymentId: molliePaymentId, 
      status: payment.status 
    });

    const isPaid = payment.status === "paid";

    // Update booking if paid and we have a booking ID
    if (isPaid && bookingId) {
      const { error: updateError } = await supabase
        .from("bookings")
        .update({
          payment_status: "paid",
          status: "confirmed",
          mollie_transaction_id: payment.id,
          paid_at: new Date().toISOString(),
        })
        .eq("id", bookingId);

      if (updateError) {
        logStep("Warning: Failed to update booking", { error: updateError.message });
      } else {
        logStep("Booking updated to paid");
      }
    }

    return new Response(
      JSON.stringify({
        paid: isPaid,
        status: payment.status,
        amount: payment.amount,
        paidAt: payment.paidAt,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    return new Response(
      JSON.stringify({ error: message, paid: false }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
