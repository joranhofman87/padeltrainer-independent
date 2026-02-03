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

    const { slotId, amount, description, trainerId, redirectUrl } = await req.json();
    logStep("Request payload", { slotId, amount, trainerId });

    if (!slotId || !amount || !trainerId) {
      throw new Error("Missing required fields: slotId, amount, trainerId");
    }

    // Get trainer's Mollie account for routing
    const { data: mollieAccount } = await supabase
      .from("trainer_mollie_accounts")
      .select("mollie_organization_id, access_token")
      .eq("trainer_id", trainerId)
      .eq("onboarding_complete", true)
      .single();

    // Create booking record first
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
    logStep("Booking created", { bookingId: booking.id });

    const origin = redirectUrl || req.headers.get("origin") || "https://app.padeltrainer.ai";

    // Build payment request
    const paymentData: Record<string, unknown> = {
      amount: {
        currency: "EUR",
        value: amount.toFixed(2),
      },
      description: description || `Padel lesson booking`,
      redirectUrl: `${origin}/booking-success?booking_id=${booking.id}`,
      webhookUrl: `${supabaseUrl}/functions/v1/mollie-webhook`,
      metadata: {
        booking_id: booking.id,
        player_id: user.id,
        trainer_id: trainerId,
      },
    };

    // If trainer has connected Mollie account, use routing for split payments
    if (mollieAccount?.mollie_organization_id) {
      // Get trainer's fee override or tier-based default
      const { data: trainerProfile } = await supabase
        .from("trainer_profiles")
        .select("platform_fee_override, subscription_status")
        .eq("user_id", trainerId)
        .single();

      let platformFee = 1.00; // Default to starter fee (€1.00)

      if (trainerProfile?.platform_fee_override !== null && trainerProfile?.platform_fee_override !== undefined) {
        // Use trainer's custom override
        platformFee = Number(trainerProfile.platform_fee_override);
        logStep("Using trainer fee override", { platformFee });
      } else {
        // Look up fee from subscription_plans based on status
        const tier = trainerProfile?.subscription_status === "active" 
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
            organizationId: mollieAccount.mollie_organization_id,
          },
        },
      ];
      logStep("Payment routing configured", { 
        trainerAmount: amount - platformFee, 
        platformFee,
        hasOverride: trainerProfile?.platform_fee_override !== null
      });
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

    // Update booking with Mollie payment ID
    await supabase
      .from("bookings")
      .update({ mollie_payment_id: payment.id })
      .eq("id", booking.id);

    return new Response(
      JSON.stringify({
        paymentId: payment.id,
        bookingId: booking.id,
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
