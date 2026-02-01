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

const STARTER_FEE = 10; // 10% for starter/free tier
const CLUB_FEE = 5; // 5% fee for club payments

// Get platform fee from database based on Stripe product ID
async function getPlatformFeeFromDB(supabaseClient: any, productId: string): Promise<number> {
  try {
    const { data, error } = await supabaseClient
      .from('subscription_plans')
      .select('platform_fee_percent')
      .or(`stripe_product_id_monthly.eq.${productId},stripe_product_id_yearly.eq.${productId}`)
      .limit(1)
      .maybeSingle();

    if (error || !data) {
      logStep("Could not find plan in DB, using starter fee", { productId, error });
      return STARTER_FEE;
    }

    return data.platform_fee_percent;
  } catch (error) {
    logStep("Error fetching platform fee from DB", { error });
    return STARTER_FEE;
  }
}

async function getTrainerPlatformFee(stripe: Stripe, supabaseClient: any, trainerEmail: string): Promise<number> {
  try {
    // Find trainer's Stripe customer
    const customers = await stripe.customers.list({ email: trainerEmail, limit: 1 });
    if (customers.data.length === 0) {
      return STARTER_FEE;
    }

    const customerId = customers.data[0].id;

    // Check for active subscription
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "active",
      limit: 1,
    });

    if (subscriptions.data.length === 0) {
      return STARTER_FEE;
    }

    const productId = subscriptions.data[0].items.data[0].price.product as string;
    
    // Get fee from database
    return await getPlatformFeeFromDB(supabaseClient, productId);
  } catch (error) {
    console.error('Error getting trainer platform fee:', error);
    return STARTER_FEE;
  }
}

// Get club's Stripe account if trainer is a club_trainer at the slot's location
async function getClubStripeAccountForSlot(
  supabaseClient: any,
  trainerId: string,
  slotId: string
): Promise<{ clubProfileId: string; stripeAccountId: string } | null> {
  // Get the slot to find its location (if it's tied to a lesson with a location)
  const { data: slot } = await supabaseClient
    .from('availability_slots')
    .select('lesson_id')
    .eq('id', slotId)
    .single();

  // Check if trainer is a club_trainer at any location
  const { data: trainerLocations } = await supabaseClient
    .from('trainer_locations')
    .select('location_id, relationship_type')
    .eq('trainer_id', trainerId)
    .eq('relationship_type', 'club_trainer');

  if (!trainerLocations || trainerLocations.length === 0) {
    return null; // Not a club trainer
  }

  // For now, use the first club location if trainer is a club_trainer
  // In the future, we could match based on the lesson's location
  const clubLocationId = trainerLocations[0].location_id;

  // Get club profile for this location
  const { data: clubProfile } = await supabaseClient
    .from('club_profiles')
    .select('id')
    .eq('location_id', clubLocationId)
    .maybeSingle();

  if (!clubProfile) {
    return null; // No club profile for this location
  }

  // Get club's Stripe account
  const { data: clubStripeAccount } = await supabaseClient
    .from('club_stripe_accounts')
    .select('stripe_account_id, charges_enabled')
    .eq('club_profile_id', clubProfile.id)
    .maybeSingle();

  if (!clubStripeAccount?.charges_enabled || !clubStripeAccount?.stripe_account_id) {
    return null; // Club doesn't have Stripe set up
  }

  return {
    clubProfileId: clubProfile.id,
    stripeAccountId: clubStripeAccount.stripe_account_id,
  };
}

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

    const { bookingId, lessonTitle, trainerName, price, trainerId, slotId } = await req.json();
    logStep("Request payload", { bookingId, lessonTitle, price, trainerId, slotId });

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

    const priceInCents = Math.round(price * 100);

    // Determine payment destination: club or independent trainer
    let connectedAccountId: string | undefined;
    let applicationFeeAmount: number | undefined;
    let platformFeePercent = STARTER_FEE;
    let isClubPayment = false;
    let clubProfileId: string | undefined;
    
    if (!trainerId) {
      throw new Error("Trainer ID is required for booking");
    }

    // First, check if this is a club trainer and should route to club
    if (slotId) {
      const clubAccount = await getClubStripeAccountForSlot(supabaseClient, trainerId, slotId);
      if (clubAccount) {
        isClubPayment = true;
        clubProfileId = clubAccount.clubProfileId;
        connectedAccountId = clubAccount.stripeAccountId;
        platformFeePercent = CLUB_FEE;
        applicationFeeAmount = Math.round(priceInCents * (platformFeePercent / 100));
        logStep("Routing payment to club", { 
          clubProfileId, 
          connectedAccountId, 
          platformFeePercent 
        });
      }
    }

    // If not a club payment, use trainer's personal Stripe account
    if (!isClubPayment) {
      const { data: stripeAccount } = await supabaseClient
        .from('trainer_stripe_accounts')
        .select('stripe_account_id, charges_enabled')
        .eq('trainer_id', trainerId)
        .single();

      if (!stripeAccount?.charges_enabled || !stripeAccount?.stripe_account_id) {
        throw new Error("This trainer has not connected their Stripe account. Please contact them to set up payments or choose a different trainer.");
      }

      connectedAccountId = stripeAccount.stripe_account_id;
      
      // Get trainer's email to check their subscription tier
      const { data: trainerProfile } = await supabaseClient
        .from('profiles')
        .select('email')
        .eq('id', trainerId)
        .single();

      if (trainerProfile?.email) {
        platformFeePercent = await getTrainerPlatformFee(stripe, supabaseClient, trainerProfile.email);
        logStep("Got trainer platform fee from DB", { email: trainerProfile.email, feePercent: platformFeePercent });
      }

      // Calculate platform fee in cents based on trainer's subscription tier
      applicationFeeAmount = Math.round(priceInCents * (platformFeePercent / 100));
      logStep("Using trainer connected account for direct charge", { 
        connectedAccountId, 
        applicationFeeAmount, 
        platformFeePercent 
      });
    }

    const origin = req.headers.get("origin") || "https://app.padeltrainer.ai";

    // Create checkout session with DIRECT CHARGE on connected account
    // This places liability with the recipient (connected account pays Stripe fees)
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      payment_method_types: ['ideal', 'card', 'bancontact'],
      mode: 'payment',
      success_url: `${origin}/booking-success?session_id={CHECKOUT_SESSION_ID}&booking_id=${bookingId}`,
      cancel_url: `${origin}/book/${trainerId}`,
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
        trainer_id: trainerId,
        platform_fee_percent: platformFeePercent.toString(),
        connected_account_id: connectedAccountId,
        is_club_payment: isClubPayment ? 'true' : 'false',
        club_profile_id: clubProfileId || '',
      },
      payment_intent_data: {
        application_fee_amount: applicationFeeAmount,
      },
    };

    // Create session ON the connected account (direct charge model)
    // Recipient pays Stripe fees, platform collects application fee
    const session = await stripe.checkout.sessions.create(
      sessionParams,
      { stripeAccount: connectedAccountId }
    );
    logStep("Checkout session created", { sessionId: session.id, url: session.url, isClubPayment });

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
