import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[CREATE-MOLLIE-PAYMENT] ${step}`, details ? JSON.stringify(details) : "");
};

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

    const { slotId, amount, description, trainerId, redirectUrl, bookingIds } = await req.json();
    logStep("Request payload", { slotId, amount, trainerId, bookingIds });

    if (!slotId || !amount || !trainerId) {
      throw new Error("Missing required fields: slotId, amount, trainerId");
    }

    // Get trainer profile ID from user ID
    const { data: trainerProfile } = await supabase
      .from("trainer_profiles")
      .select("id")
      .eq("user_id", trainerId)
      .single();

    const trainerProfileId = trainerProfile?.id;
    logStep("Trainer profile lookup", { trainerId, trainerProfileId });

    // Check if trainer is part of an active academy
    let recipientMollieId: string | null = null;
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
        
        // Get academy's Mollie account
        const { data: academyMollie } = await supabase
          .from("academy_mollie_accounts")
          .select("mollie_organization_id, charges_enabled")
          .eq("academy_profile_id", academyTrainer.academy_profile_id)
          .eq("onboarding_complete", true)
          .single();

        if (academyMollie?.mollie_organization_id && academyMollie?.charges_enabled) {
          recipientMollieId = academyMollie.mollie_organization_id;
          recipientType = 'academy';
          logStep("Using academy Mollie account", { organizationId: recipientMollieId });

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
    if (!recipientMollieId && trainerProfileId) {
      const { data: trainerMollie } = await supabase
        .from("trainer_mollie_accounts")
        .select("mollie_organization_id, access_token")
        .eq("trainer_id", trainerProfileId)
        .eq("onboarding_complete", true)
        .single();

      if (trainerMollie?.mollie_organization_id) {
        recipientMollieId = trainerMollie.mollie_organization_id;
        recipientType = 'trainer';
        logStep("Using trainer Mollie account", { organizationId: recipientMollieId });

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
          player_id: user.id,
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
        player_id: user.id,
        trainer_id: trainerId,
        recipient_type: recipientType,
      },
    };

    // If we have a recipient Mollie account, use routing for split payments
    if (recipientMollieId) {
      // Ensure fee doesn't exceed payment amount
      platformFee = Math.min(platformFee, amount);
      
      paymentData.routing = [
        {
          amount: {
            currency: "EUR",
            value: (amount - platformFee).toFixed(2),
          },
          destination: {
            type: "organization",
            organizationId: recipientMollieId,
          },
        },
      ];
      logStep("Payment routing configured", { 
        recipientType,
        recipientAmount: amount - platformFee, 
        platformFee,
      });
    } else {
      logStep("No Mollie account found, payment goes to platform");
    }

    // Create payment via Mollie API
    const mollieResponse = await fetch("https://api.mollie.com/v2/payments", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${mollieApiKey}`,
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
