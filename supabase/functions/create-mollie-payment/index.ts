import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import {
  applySplitPayment,
  amountsMatch,
  computeCyclusTotalFromSlots,
  computeSingleSlotPaymentAmount,
  type SlotPricingInput,
} from "../_shared/booking-pricing.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[CREATE-MOLLIE-PAYMENT] ${step}`, details ? JSON.stringify(details) : "");
};

async function notifySlack(supabase: any, event: string, data: Record<string, unknown>) {
  try {
    await supabase.functions.invoke("slack-notify", {
      body: { event, data },
    });
  } catch (_) {
    // Silent
  }
}

async function writeAuditLog(
  supabase: any,
  log: {
    function_name: string;
    booking_id?: string;
    invoice_id?: string;
    recipient_type?: string;
    mollie_org_id?: string;
    amount?: number;
    status: string;
    error_message?: string;
    mollie_payment_id?: string;
    metadata?: Record<string, unknown>;
  }
) {
  try {
    await supabase.from("payment_audit_log").insert(log);
  } catch (_) {
    logStep("Failed to write audit log", { error: String(_) });
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
    logStep("Mollie credentials not configured for refresh");
    return accountData.access_token;
  }

  const tokenExpiresAt = new Date(accountData.token_expires_at);
  const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);

  if (tokenExpiresAt > fiveMinutesFromNow) {
    return accountData.access_token;
  }

  logStep("Token expired or expiring soon, refreshing", { expiresAt: tokenExpiresAt.toISOString() });

  if (!accountData.refresh_token) {
    logStep("No refresh token available");
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

    // Authenticate user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) throw new Error("Authentication failed");
    
    const user = userData.user;
    logStep("User authenticated", { userId: user.id, email: user.email });

    // Look up the player's profile ID (profiles.id != auth user ID)
    const { data: playerProfile, error: profileError } = await supabase
      .from("profiles")
      .select("id")
      .eq("user_id", user.id)
      .single();

    if (profileError || !playerProfile) {
      throw new Error("Player profile not found");
    }
    logStep("Player profile found", { profileId: playerProfile.id });

    const { slotId, amount: clientAmount, description, trainerId, redirectUrl, bookingIds } = await req.json();
    logStep("Request payload", { slotId, trainerId, bookingIds, clientAmountIgnored: clientAmount });

    if (!slotId || !trainerId) {
      throw new Error("Missing required fields: slotId, trainerId");
    }

    const { data: trainerProfile } = await supabase
      .from("trainer_profiles")
      .select("id, hourly_rate")
      .eq("id", trainerId)
      .single();

    if (!trainerProfile?.id) {
      return new Response(
        JSON.stringify({ error: "Trainer not found" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const trainerProfileId = trainerProfile.id;
    const hourlyRate = trainerProfile.hourly_rate != null ? Number(trainerProfile.hourly_rate) : null;
    logStep("Trainer profile lookup", { trainerId, trainerProfileId });

    const requestedBookingIds: string[] = Array.isArray(bookingIds)
      ? bookingIds.filter((id: unknown) => typeof id === "string")
      : [];

    let expectedAmount: number;
    let preExistingBookingIds: string[] = [];

    if (requestedBookingIds.length > 0) {
      const { data: existingBookings, error: bookingsError } = await supabase
        .from("bookings")
        .select(`
          id, player_id, payment_status, status, slot_id,
          availability_slots!inner(
            id, trainer_id, cyclus_id, price_per_session, start_time, end_time,
            max_participants, allow_single_booking
          )
        `)
        .in("id", requestedBookingIds);

      if (bookingsError || !existingBookings?.length) {
        return new Response(
          JSON.stringify({ error: "Bookings not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (existingBookings.length !== requestedBookingIds.length) {
        return new Response(
          JSON.stringify({ error: "Invalid booking IDs" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      for (const b of existingBookings) {
        if (b.player_id !== playerProfile.id) {
          return new Response(
            JSON.stringify({ error: "Forbidden: booking does not belong to player" }),
            { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        if (!["pending"].includes(b.payment_status)) {
          return new Response(
            JSON.stringify({ error: "Booking is not pending payment" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        if (!["pending", "confirmed"].includes(b.status)) {
          return new Response(
            JSON.stringify({ error: "Booking is not eligible for payment" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        const slot = b.availability_slots as SlotPricingInput & {
          id: string;
          trainer_id: string;
          cyclus_id: string | null;
        };
        if (slot.trainer_id !== trainerId) {
          return new Response(
            JSON.stringify({ error: "Trainer does not match booking slot" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      if (!existingBookings.some((row) => row.slot_id === slotId)) {
        return new Response(
          JSON.stringify({ error: "slotId must match a booking in bookingIds" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const slots = existingBookings.map((b) => b.availability_slots as SlotPricingInput & { cyclus_id: string | null });
      const cyclusIds = [...new Set(slots.map((s) => s.cyclus_id).filter(Boolean))];
      let splitPayment = false;

      if (cyclusIds.length === 1 && cyclusIds[0]) {
        const { data: cycle } = await supabase
          .from("cycles")
          .select("settings")
          .eq("id", cyclusIds[0])
          .maybeSingle();
        const settings = (cycle?.settings as Record<string, unknown>) || {};
        splitPayment = settings.split_payment === true;
      }

      const total = computeCyclusTotalFromSlots(slots, hourlyRate);
      if (splitPayment) {
        const slotIds = [...new Set(existingBookings.map((b) => b.slot_id))];
        const { count: existingPlayers } = await supabase
          .from("bookings")
          .select("player_id", { count: "exact", head: true })
          .in("slot_id", slotIds)
          .in("status", ["pending", "confirmed"]);
        expectedAmount = applySplitPayment(total, existingPlayers || 1);
      } else {
        expectedAmount = total;
      }

      preExistingBookingIds = requestedBookingIds;
      logStep("Server-computed cyclus amount", { expectedAmount, splitPayment, total });
    } else {
      const { data: slot, error: slotError } = await supabase
        .from("availability_slots")
        .select("id, trainer_id, price_per_session, start_time, end_time, max_participants, allow_single_booking")
        .eq("id", slotId)
        .single();

      if (slotError || !slot) {
        return new Response(
          JSON.stringify({ error: "Slot not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (slot.trainer_id !== trainerId) {
        return new Response(
          JSON.stringify({ error: "Trainer does not match slot" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      expectedAmount = computeSingleSlotPaymentAmount(slot, hourlyRate, 1);
      logStep("Server-computed single-slot amount", { expectedAmount });
    }

    if (expectedAmount <= 0) {
      return new Response(
        JSON.stringify({ error: "Invalid payment amount" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (clientAmount != null && !amountsMatch(expectedAmount, Number(clientAmount))) {
      logStep("Client amount ignored (mismatch)", { clientAmount, expectedAmount });
    }

    // Check if trainer is part of an active academy
    let recipientAccessToken: string | null = null;
    let recipientType: 'trainer' | 'academy' | null = null;
    let mollieOrgId: string | null = null;
    let platformFee = 1.00; // Default to starter fee (€1.00)

    if (trainerProfileId) {
      // First check if trainer is part of an active academy
      const { data: academyTrainer } = await supabase
        .from("academy_trainers")
        .select(`
          academy_profile_id,
          status,
          academy:academy_profiles(id, platform_fee_override)
        `)
        .eq("trainer_profile_id", trainerProfileId)
        .eq("status", "active")
        .maybeSingle();

      if (academyTrainer?.academy_profile_id) {
        logStep("Trainer is part of academy", { academyId: academyTrainer.academy_profile_id });
        
        // Get academy's Mollie account (need access_token for Platform model)
        const { data: academyMollie } = await supabase
          .from("academy_mollie_accounts")
          .select("mollie_organization_id, charges_enabled, access_token, refresh_token, token_expires_at")
          .eq("academy_profile_id", academyTrainer.academy_profile_id)
          .eq("onboarding_complete", true)
          .single();

        if (academyMollie?.access_token && academyMollie?.charges_enabled) {
          recipientAccessToken = await refreshTokenIfNeeded(supabase, academyMollie, 'academy', academyTrainer.academy_profile_id);
          recipientType = 'academy';
          mollieOrgId = academyMollie.mollie_organization_id;
          logStep("Using academy Mollie account", { organizationId: academyMollie.mollie_organization_id });

          // Check academy's platform fee override
          const academy = academyTrainer.academy as { platform_fee_override?: number | null };
          if (academy?.platform_fee_override !== null && academy?.platform_fee_override !== undefined) {
            platformFee = Number(academy.platform_fee_override);
            logStep("Using academy fee override", { platformFee });
          } else {
            // Use academy tier fee (€0.50 for academies)
            const { data: plan } = await supabase
              .from("subscription_plans")
              .select("platform_fee_flat")
              .eq("tier", "academy")
              .eq("plan_type", "trainer")
              .eq("is_active", true)
              .single();

            if (plan?.platform_fee_flat !== null && plan?.platform_fee_flat !== undefined) {
              platformFee = Number(plan.platform_fee_flat);
            }
            logStep("Using academy tier fee", { platformFee });
          }
        }
      }
    }

    // If not routed to academy, check trainer's own Mollie account
    if (!recipientAccessToken && trainerProfileId) {
      const { data: trainerMollie } = await supabase
        .from("trainer_mollie_accounts")
        .select("mollie_organization_id, access_token, refresh_token, token_expires_at")
        .eq("trainer_id", trainerProfileId)
        .eq("onboarding_complete", true)
        .single();

      if (trainerMollie?.access_token) {
        recipientAccessToken = await refreshTokenIfNeeded(supabase, trainerMollie, 'trainer', trainerProfileId);
        recipientType = 'trainer';
        mollieOrgId = trainerMollie.mollie_organization_id;
        logStep("Using trainer Mollie account", { organizationId: trainerMollie.mollie_organization_id });

        // Get trainer's fee override or tier-based default
        const { data: trainerProfileData } = await supabase
          .from("trainer_profiles")
          .select("platform_fee_override, subscription_status")
          .eq("id", trainerProfileId)
          .single();

        if (trainerProfileData?.platform_fee_override !== null && trainerProfileData?.platform_fee_override !== undefined) {
          platformFee = Number(trainerProfileData.platform_fee_override);
          logStep("Using trainer fee override", { platformFee });
        } else {
          // Look up fee from subscription_plans based on status
          const tier = trainerProfileData?.subscription_status === "active" 
            ? "professional" 
            : "starter";
            
          const { data: plan } = await supabase
            .from("subscription_plans")
            .select("platform_fee_flat")
            .eq("tier", tier)
            .eq("plan_type", "trainer")
            .eq("is_active", true)
            .single();
            
          if (plan?.platform_fee_flat !== null && plan?.platform_fee_flat !== undefined) {
            platformFee = Number(plan.platform_fee_flat);
          }
          logStep("Using tier-based fee", { tier, platformFee });
        }
      }
    }

    // CRITICAL: If no connected Mollie account found, refuse to create payment
    // This prevents funds from accidentally going to the platform account
    if (!recipientAccessToken) {
      const errorMsg = "No connected payment account found for this trainer/academy. Payment cannot be processed.";
      logStep("BLOCKED: No Mollie account", { trainerId, trainerProfileId });
      
      await writeAuditLog(supabase, {
        function_name: "create-mollie-payment",
        recipient_type: null,
        amount: expectedAmount,
        status: "blocked_no_account",
        error_message: errorMsg,
        metadata: { trainerId, trainerProfileId, slotId },
      });

      await notifySlack(supabase, "edge_function_error", {
        function: "create-mollie-payment",
        error: errorMsg,
        trainerId,
      });

      return new Response(
        JSON.stringify({ error: "no_mollie_account", message: "Online betaling is niet beschikbaar. De trainer heeft nog geen betaalaccount gekoppeld." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let bookingId: string;
    const allBookingIds: string[] = [...preExistingBookingIds];

    if (allBookingIds.length > 0) {
      bookingId = allBookingIds[0];
      logStep("Using existing bookings", { bookingIds: allBookingIds });

      const perBookingAmount = Math.round((expectedAmount / allBookingIds.length) * 100) / 100;
      const { error: amountUpdateError } = await supabase
        .from("bookings")
        .update({ payment_amount: perBookingAmount })
        .in("id", allBookingIds);

      if (amountUpdateError) {
        throw new Error(`Failed to set payment amount: ${amountUpdateError.message}`);
      }
      logStep("Payment amounts set on cyclus bookings", { perBookingAmount, count: allBookingIds.length });
    } else {
      const { data: booking, error: bookingError } = await supabase
        .from("bookings")
        .insert({
          slot_id: slotId,
          player_id: playerProfile.id,
          payment_status: "pending",
          status: "pending",
          payment_amount: expectedAmount,
        })
        .select()
        .single();

      if (bookingError) throw new Error(`Failed to create booking: ${bookingError.message}`);
      bookingId = booking.id;
      allBookingIds.push(bookingId);
      logStep("Booking created", { bookingId, payment_amount: expectedAmount });
    }

    const origin = redirectUrl || req.headers.get("origin") || "https://padeltrainer.ai";

    // Build payment request
    const paymentData: Record<string, unknown> = {
      amount: {
        currency: "EUR",
        value: expectedAmount.toFixed(2),
      },
      description: description || `Padel lesson booking`,
      redirectUrl: `${origin}/app/booking-success?booking_id=${bookingId}`,
      cancelUrl: `${origin}/app/booking-cancelled?booking_id=${bookingId}`,
      webhookUrl: `${supabaseUrl}/functions/v1/mollie-webhook`,
      metadata: {
        booking_id: bookingId,
        booking_ids: allBookingIds,
        player_id: playerProfile.id,
        trainer_id: trainerId,
        recipient_type: recipientType,
      },
    };

    // Fetch the connected account's profile ID (required by Mollie for OAuth payments)
    let mollieProfileId: string | null = null;
    try {
      const profileResp = await fetch('https://api.mollie.com/v2/profiles', {
        headers: { 'Authorization': `Bearer ${recipientAccessToken}` },
      });
      if (profileResp.ok) {
        const profileData = await profileResp.json();
        if (profileData._embedded?.profiles?.length > 0) {
          mollieProfileId = profileData._embedded.profiles[0].id;
          logStep("Mollie profile found via list", { profileId: mollieProfileId });
        }
      } else {
        const profileErrorText = await profileResp.text();
        logStep("Could not fetch Mollie profiles", { status: profileResp.status, error: profileErrorText });
      }
    } catch (err) {
      logStep("Error fetching Mollie profiles", { error: String(err) });
    }

    if (!mollieProfileId) {
      const errorMsg = "No Mollie profile found for connected account. Payment cannot be processed.";
      logStep("BLOCKED: No Mollie profile", { recipientType, mollieOrgId });

      await writeAuditLog(supabase, {
        function_name: "create-mollie-payment",
        booking_id: bookingId,
        recipient_type: recipientType,
        mollie_org_id: mollieOrgId,
        amount: expectedAmount,
        status: "blocked_no_profile",
        error_message: errorMsg,
      });

      return new Response(
        JSON.stringify({ error: "missing_mollie_profile", message: "Betaalprofiel niet geconfigureerd." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Cap fee: must be strictly less than amount minus Mollie's transaction costs
    const maxFee = Math.max(0, expectedAmount - 0.30);
    const effectiveFee = Math.min(platformFee, maxFee);

    paymentData.profileId = mollieProfileId;
    if (effectiveFee > 0) {
      paymentData.applicationFee = {
        amount: {
          currency: "EUR",
          value: effectiveFee.toFixed(2),
        },
        description: "Platform fee",
      };
    }
    logStep("Application fee configured", { recipientType, effectiveFee, profileId: mollieProfileId, mollieOrgId });

    // Detect test mode and add testmode flag for OAuth tokens
    const isTestMode = mollieApiKey.startsWith("test_");
    if (isTestMode) {
      paymentData.testmode = true;
      logStep("Test mode enabled for OAuth payment");
    }

    // Create payment via Mollie API using connected account's token
    const mollieResponse = await fetch("https://api.mollie.com/v2/payments", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${recipientAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(paymentData),
    });

    if (!mollieResponse.ok) {
      const errorText = await mollieResponse.text();
      
      await writeAuditLog(supabase, {
        function_name: "create-mollie-payment",
        booking_id: bookingId,
        recipient_type: recipientType,
        mollie_org_id: mollieOrgId,
        amount: expectedAmount,
        status: "error",
        error_message: errorText.slice(0, 500),
      });

      throw new Error(`Mollie API error: ${errorText}`);
    }

    const payment = await mollieResponse.json();
    logStep("Mollie payment created", { paymentId: payment.id, recipientType, mollieOrgId });

    // Update booking(s) with Mollie payment ID
    await supabase
      .from("bookings")
      .update({ mollie_payment_id: payment.id })
      .in("id", allBookingIds);

    // Write success audit log
    await writeAuditLog(supabase, {
      function_name: "create-mollie-payment",
      booking_id: bookingId,
      recipient_type: recipientType,
      mollie_org_id: mollieOrgId,
      amount: expectedAmount,
      status: "success",
      mollie_payment_id: payment.id,
      metadata: { bookingIds: allBookingIds, profileId: mollieProfileId, fee: effectiveFee },
    });

    // Slack notification for successful payment creation
    await notifySlack(supabase, "payment_created", {
      type: "booking",
      recipientType,
      mollieOrgId,
      amount: `€${expectedAmount.toFixed(2)}`,
      fee: `€${effectiveFee.toFixed(2)}`,
      bookings: allBookingIds.length,
      paymentId: payment.id,
    });

    return new Response(
      JSON.stringify({
        paymentId: payment.id,
        bookingId: bookingId,
        checkoutUrl: payment._links.checkout.href,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    await notifySlack(
      createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!),
      "edge_function_error",
      { function: "create-mollie-payment", error: message.slice(0, 500) }
    );
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
