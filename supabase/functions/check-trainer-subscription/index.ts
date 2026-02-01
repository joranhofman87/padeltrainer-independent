import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: any) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[CHECK-TRAINER-SUBSCRIPTION] ${step}${detailsStr}`);
};

// Get tier from database based on Stripe product ID
async function getTierFromDB(supabaseClient: any, productId: string): Promise<string> {
  try {
    const { data, error } = await supabaseClient
      .from('subscription_plans')
      .select('tier')
      .or(`stripe_product_id_monthly.eq.${productId},stripe_product_id_yearly.eq.${productId}`)
      .limit(1)
      .maybeSingle();

    if (error || !data) {
      logStep("Could not find tier in DB, defaulting to trial", { productId, error });
      return 'trial';
    }

    return data.tier;
  } catch (error) {
    logStep("Error fetching tier from DB", { error });
    return 'trial';
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    logStep("Function started");

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY is not set");
    logStep("Stripe key verified");

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } }
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");
    logStep("Authorization header found");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user?.email) throw new Error("User not authenticated or email not available");
    logStep("User authenticated", { userId: user.id, email: user.email });

    // Fetch trainer profile to get trial info and visibility
    const { data: trainerProfile, error: tpError } = await supabaseClient
      .from('trainer_profiles')
      .select('id, trial_started_at, trial_ends_at, is_public, subscription_status')
      .eq('user_id', user.id)
      .maybeSingle();

    if (tpError) {
      logStep("Error fetching trainer profile", { error: tpError });
    }

    const trialEndsAt = trainerProfile?.trial_ends_at || null;
    const isPublic = trainerProfile?.is_public || false;
    const now = new Date();
    const isInTrial = trialEndsAt ? new Date(trialEndsAt) > now : false;

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });

    if (customers.data.length === 0) {
      logStep("No customer found, returning trial tier");
      return new Response(JSON.stringify({ 
        subscribed: false,
        tier: 'trial',
        product_id: null,
        subscription_end: null,
        trial_ends_at: trialEndsAt,
        is_trial: isInTrial,
        is_public: isPublic,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    const customerId = customers.data[0].id;
    logStep("Found Stripe customer", { customerId });

    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "active",
      limit: 1,
    });

    const hasActiveSub = subscriptions.data.length > 0;
    let productId: string | null = null;
    let tier = 'trial';
    let subscriptionEnd: string | null = null;

    // Check for admin-granted subscription status
    const hasAdminGrantedAccess = trainerProfile?.subscription_status === 'active';

    if (hasActiveSub) {
      const subscription = subscriptions.data[0];
      subscriptionEnd = new Date(subscription.current_period_end * 1000).toISOString();
      productId = subscription.items.data[0].price.product as string;
      
      // Get tier from database instead of hardcoded map
      tier = await getTierFromDB(supabaseClient, productId);
      logStep("Active subscription found", { subscriptionId: subscription.id, productId, tier, endDate: subscriptionEnd });
    } else if (hasAdminGrantedAccess) {
      // Admin manually set status to active - grant access without Stripe
      tier = 'professional';
      logStep("Admin-granted subscription detected", { subscription_status: trainerProfile.subscription_status });
    } else {
      logStep("No active subscription found");
    }

    return new Response(JSON.stringify({
      subscribed: hasActiveSub || hasAdminGrantedAccess,
      tier,
      product_id: productId,
      subscription_end: subscriptionEnd,
      trial_ends_at: trialEndsAt,
      is_trial: isInTrial && !hasActiveSub && !hasAdminGrantedAccess,
      is_public: isPublic,
    }), {
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
