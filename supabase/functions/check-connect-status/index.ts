import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: any) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[CHECK-CONNECT-STATUS] ${step}${detailsStr}`);
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
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user) throw new Error("User not authenticated");
    logStep("User authenticated", { userId: user.id });

    // Get trainer profile
    const { data: trainerProfile, error: trainerError } = await supabaseClient
      .from('trainer_profiles')
      .select('id')
      .eq('user_id', user.id)
      .single();

    if (trainerError || !trainerProfile) {
      return new Response(JSON.stringify({ connected: false, message: "No trainer profile" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    // Get Mollie account
    const { data: mollieAccount } = await supabaseClient
      .from('trainer_mollie_accounts')
      .select('mollie_organization_id, onboarding_complete, charges_enabled, payouts_enabled')
      .eq('trainer_id', trainerProfile.id)
      .single();

    if (!mollieAccount?.mollie_organization_id) {
      return new Response(JSON.stringify({ connected: false, message: "No payment account" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

    // Fetch latest account status from Stripe (temporary - will be replaced with Mollie API)
    const account = await stripe.accounts.retrieve(mollieAccount.mollie_organization_id);
    logStep("Account retrieved", { 
      chargesEnabled: account.charges_enabled, 
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted 
    });

    // Update database with latest status
    const { error: updateError } = await supabaseClient
      .from('trainer_mollie_accounts')
      .update({
        charges_enabled: account.charges_enabled,
        payouts_enabled: account.payouts_enabled,
        onboarding_complete: account.details_submitted,
      })
      .eq('trainer_id', trainerProfile.id);

    if (updateError) {
      logStep("Warning: Could not update account status", { error: updateError });
    }

    // Get balance if charges are enabled
    let balance = null;
    if (account.charges_enabled) {
      try {
        const stripeBalance = await stripe.balance.retrieve({
          stripeAccount: mollieAccount.mollie_organization_id,
        });
        balance = {
          available: stripeBalance.available.reduce((sum: number, b: { amount: number }) => sum + b.amount, 0) / 100,
          pending: stripeBalance.pending.reduce((sum: number, b: { amount: number }) => sum + b.amount, 0) / 100,
          currency: stripeBalance.available[0]?.currency || 'eur',
        };
        logStep("Balance retrieved", balance);
      } catch (balanceError) {
        logStep("Could not retrieve balance", { error: balanceError });
      }
    }

    return new Response(JSON.stringify({
      connected: true,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      onboardingComplete: account.details_submitted,
      balance,
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
