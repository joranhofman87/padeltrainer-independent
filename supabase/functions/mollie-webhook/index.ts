import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[MOLLIE-WEBHOOK] ${step}`, details ? JSON.stringify(details) : "");
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

  logStep("Token expired or expiring soon, refreshing");

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

    // Mollie sends payment ID in the body
    const formData = await req.formData();
    const paymentId = formData.get("id") as string;

    if (!paymentId) {
      logStep("No payment ID in webhook");
      return new Response("OK", { status: 200 });
    }

    logStep("Webhook received", { paymentId });

    // Look up booking to find trainer for token resolution
    const { data: bookingForToken } = await supabase
      .from("bookings")
      .select("slot_id, availability_slots!inner(trainer_id)")
      .eq("mollie_payment_id", paymentId)
      .limit(1)
      .maybeSingle();

    const slotsData = bookingForToken?.availability_slots as unknown as { trainer_id: string } | null;
    const trainerId = slotsData?.trainer_id;
    let recipientAccessToken: string | null = null;

    if (trainerId) {
      recipientAccessToken = await resolveAccessToken(supabase, trainerId);
    }

    // Build fetch URL with testmode if needed
    const isTestMode = mollieApiKey.startsWith("test_");
    const authToken = recipientAccessToken || mollieApiKey;
    let fetchUrl = `https://api.mollie.com/v2/payments/${paymentId}`;
    if (isTestMode && recipientAccessToken) {
      fetchUrl += "?testmode=true";
    }

    logStep("Fetching payment from Mollie", { useConnectedToken: !!recipientAccessToken, isTestMode });

    // Fetch payment details from Mollie
    const mollieResponse = await fetch(fetchUrl, {
      headers: {
        "Authorization": `Bearer ${authToken}`,
      },
    });

    if (!mollieResponse.ok) {
      const errorText = await mollieResponse.text();
      throw new Error(`Failed to fetch payment: ${errorText}`);
    }

    const payment = await mollieResponse.json();
    logStep("Payment fetched", { 
      status: payment.status, 
      metadata: payment.metadata 
    });

    // Support both single booking_id and multiple booking_ids
    const bookingIds: string[] = payment.metadata?.booking_ids || 
      (payment.metadata?.booking_id ? [payment.metadata.booking_id] : []);
    
    if (bookingIds.length === 0) {
      logStep("No booking IDs in payment metadata");
      return new Response("OK", { status: 200 });
    }

    // Map Mollie status to our payment status
    let paymentStatus: string;
    let bookingStatus: string;

    switch (payment.status) {
      case "paid":
        paymentStatus = "paid";
        bookingStatus = "confirmed";
        break;
      case "failed":
      case "canceled":
      case "expired":
        paymentStatus = "failed";
        bookingStatus = "cancelled";
        break;
      case "pending":
      case "open":
        paymentStatus = "pending";
        bookingStatus = "pending";
        break;
      default:
        paymentStatus = "pending";
        bookingStatus = "pending";
    }

    logStep("Updating bookings", { bookingIds, paymentStatus, bookingStatus });

    // Update all bookings
    const updateData: Record<string, unknown> = {
      payment_status: paymentStatus,
      status: bookingStatus,
      mollie_transaction_id: payment.id,
    };

    if (payment.status === "paid") {
      updateData.paid_at = new Date().toISOString();
    }

    const { error: updateError } = await supabase
      .from("bookings")
      .update(updateData)
      .in("id", bookingIds);

    if (updateError) {
      logStep("Failed to update bookings", { error: updateError.message });
      throw new Error(`Failed to update bookings: ${updateError.message}`);
    }

    logStep("Bookings updated successfully", { count: bookingIds.length });

    // If payment is successful, auto-create invoice and send confirmation email
    if (payment.status === "paid") {
      // Auto-create invoice
      try {
        const { error: invoiceError } = await supabase.functions.invoke("auto-create-invoice", {
          body: { bookingIds },
        });
        if (invoiceError) {
          logStep("Auto-create invoice failed (non-fatal)", { error: String(invoiceError) });
        } else {
          logStep("Auto-create invoice triggered");
        }
      } catch (invoiceErr) {
        logStep("Auto-create invoice error (non-fatal)", { error: String(invoiceErr) });
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
        }
      } catch (emailError) {
        logStep("Failed to send confirmation email", { 
          error: emailError instanceof Error ? emailError.message : String(emailError) 
        });
        // Don't throw - email failure shouldn't fail the webhook
      }
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    // Return 200 to prevent Mollie from retrying (we've logged the error)
    return new Response("OK", { status: 200 });
  }
});
