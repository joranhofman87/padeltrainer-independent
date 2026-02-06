import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[CREATE-MOLLIE-PAYMENT] ${step}`, details ? JSON.stringify(details) : "");
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

    const { slotId, amount, description, trainerId, redirectUrl, bookingIds } = await req.json();
    logStep("Request payload", { slotId, amount, trainerId, bookingIds });

    if (!slotId || !amount || !trainerId) {
      throw new Error("Missing required fields: slotId, amount, trainerId");
    }

    // Get trainer profile ID from user ID
    const { data: trainerProfile } = await supabase
      .from("trainer_profiles")
      .select("id")
      .eq("id", trainerId)
      .single();

    const trainerProfileId = trainerProfile?.id;
    logStep("Trainer profile lookup", { trainerId, trainerProfileId });

    // Check if trainer is part of an active academy
    let recipientAccessToken: string | null = null;
    let recipientType: 'trainer' | 'academy' | null = null;
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

    // Use existing booking IDs (cyclus flow) or create a new booking
    let bookingId: string;
    const allBookingIds: string[] = bookingIds || [];

    if (allBookingIds.length > 0) {
      // Cyclus flow: bookings already created by frontend
      bookingId = allBookingIds[0];
      logStep("Using existing bookings", { bookingIds: allBookingIds });
    } else {
      // Single slot flow: create booking record
      const { data: booking, error: bookingError } = await supabase
        .from("bookings")
        .insert({
          slot_id: slotId,
          player_id: playerProfile.id,
          payment_status: "pending",
          status: "pending",
          payment_amount: amount,
        })
        .select()
        .single();

      if (bookingError) throw new Error(`Failed to create booking: ${bookingError.message}`);
      bookingId = booking.id;
      allBookingIds.push(bookingId);
      logStep("Booking created", { bookingId });
    }

    const origin = redirectUrl || req.headers.get("origin") || "https://padeltrainer.ai";

    // Build payment request
    const paymentData: Record<string, unknown> = {
      amount: {
        currency: "EUR",
        value: amount.toFixed(2),
      },
      description: description || `Padel lesson booking`,
      redirectUrl: `${origin}/booking-success?booking_id=${bookingId}`,
      webhookUrl: `${supabaseUrl}/functions/v1/mollie-webhook`,
      metadata: {
        booking_id: bookingId,
        booking_ids: allBookingIds,
        player_id: playerProfile.id,
        trainer_id: trainerId,
        recipient_type: recipientType,
      },
    };

    if (recipientAccessToken) {
      // Fetch the connected account's profile ID (required by Mollie for OAuth payments)
      // Note: /v2/profiles/me only works with API keys, so we use /v2/profiles (list) instead
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
          const profileError = await profileResp.text();
          logStep("Could not fetch Mollie profiles", { status: profileResp.status, error: profileError });
        }
      } catch (err) {
        logStep("Error fetching Mollie profiles", { error: String(err) });
      }

      if (mollieProfileId) {
        // Cap fee: must be strictly less than amount minus Mollie's transaction costs
        const maxFee = Math.max(0, amount - 0.30);
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
        logStep("Application fee configured", { recipientType, effectiveFee, profileId: mollieProfileId });
      } else {
        logStep("No Mollie profile found, falling back to platform");
        recipientAccessToken = null;
      }
    } else {
      logStep("No Mollie account found, payment goes to platform");
    }

    // Detect test mode and add testmode flag for OAuth tokens
    const isTestMode = mollieApiKey.startsWith("test_");
    if (recipientAccessToken && isTestMode) {
      paymentData.testmode = true;
      logStep("Test mode enabled for OAuth payment");
    }

    // Use connected account's access token if available, otherwise platform key
    const authToken = recipientAccessToken || mollieApiKey;

    // Create payment via Mollie API
    const mollieResponse = await fetch("https://api.mollie.com/v2/payments", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(paymentData),
    });

    if (!mollieResponse.ok) {
      const errorText = await mollieResponse.text();
      throw new Error(`Mollie API error: ${errorText}`);
    }

    const payment = await mollieResponse.json();
    logStep("Mollie payment created", { paymentId: payment.id });

    // Update booking(s) with Mollie payment ID
    await supabase
      .from("bookings")
      .update({ mollie_payment_id: payment.id })
      .in("id", allBookingIds);

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
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
