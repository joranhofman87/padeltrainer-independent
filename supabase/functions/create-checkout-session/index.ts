import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: any) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[CREATE-CHECKOUT] ${step}${detailsStr}`);
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    logStep("Function started");

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY is not set");

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? ""
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user?.email) throw new Error("User not authenticated or email not available");
    logStep("User authenticated", { userId: user.id, email: user.email });

    const { bookingId, lessonTitle, trainerName, price, trainerId } = await req.json();
    logStep("Request payload", { bookingId, lessonTitle, price, trainerId });

    if (!bookingId || !price) {
      throw new Error("Missing required fields: bookingId and price");
    }

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

    // Check if user already exists as Stripe customer
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    let customerId: string | undefined;
    if (customers.data.length > 0) {
      customerId = customers.data[0].id;
      logStep("Found existing Stripe customer", { customerId });
    }

    // Check if trainer has a connected Stripe account
    let transferDestination: string | undefined;
    let applicationFee: number | undefined;
    
    if (trainerId) {
      const { data: stripeAccount } = await supabaseClient
        .from('trainer_stripe_accounts')
        .select('stripe_account_id, charges_enabled')
        .eq('trainer_id', trainerId)
        .single();

      if (stripeAccount?.charges_enabled && stripeAccount?.stripe_account_id) {
        transferDestination = stripeAccount.stripe_account_id;
        // Platform takes 10% fee
        applicationFee = Math.round(price * 10);
        logStep("Trainer has connected account", { transferDestination, applicationFee });
      }
    }

    const priceInCents = Math.round(price * 100);
    const origin = req.headers.get("origin") || "https://ppkbhdiiqdusdeatgdft-preview.lovable.app";

    // Create checkout session with optional Connect split
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      customer: customerId,
      customer_email: customerId ? undefined : user.email,
      payment_method_types: ['ideal', 'card', 'bancontact'],
      mode: 'payment',
      success_url: `${origin}/booking-success?session_id={CHECKOUT_SESSION_ID}&booking_id=${bookingId}`,
      cancel_url: `${origin}/book/${trainerId || ''}`,
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: {
              name: lessonTitle || 'Training Session',
              description: `Lesson with ${trainerName || 'trainer'}`,
            },
            unit_amount: priceInCents,
          },
          quantity: 1,
        },
      ],
      metadata: {
        booking_id: bookingId,
        trainer_id: trainerId || '',
      },
    };

    // Add Connect split if trainer has connected account
    if (transferDestination && applicationFee) {
      sessionParams.payment_intent_data = {
        application_fee_amount: applicationFee,
        transfer_data: {
          destination: transferDestination,
        },
      };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    logStep("Checkout session created", { sessionId: session.id, url: session.url });

    // Update booking with session ID
    const { error: updateError } = await supabaseClient
      .from('bookings')
      .update({ stripe_session_id: session.id })
      .eq('id', bookingId);

    if (updateError) {
      logStep("Warning: Could not update booking with session ID", { error: updateError });
    }

    return new Response(JSON.stringify({ url: session.url, sessionId: session.id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
