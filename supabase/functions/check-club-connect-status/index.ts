import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: any) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[CHECK-CLUB-CONNECT] ${step}${detailsStr}`);
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
    if (!user) throw new Error("User not authenticated");
    logStep("User authenticated", { userId: user.id });

    const { clubProfileId } = await req.json();
    if (!clubProfileId) throw new Error("Club profile ID is required");

    // Verify user is a manager of this club
    const { data: clubManager } = await supabaseClient
      .from('club_managers')
      .select('role')
      .eq('club_profile_id', clubProfileId)
      .eq('user_id', user.id)
      .single();

    if (!clubManager) {
      throw new Error("You are not a manager of this club");
    }

    // Get club's Mollie account
    const { data: mollieAccount, error: accountError } = await supabaseClient
      .from('club_mollie_accounts')
      .select('mollie_organization_id, charges_enabled, payouts_enabled, onboarding_complete')
      .eq('club_profile_id', clubProfileId)
      .maybeSingle();

    if (!mollieAccount) {
      logStep("No Mollie account found for club");
      return new Response(JSON.stringify({ 
        connected: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        onboardingComplete: false,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

    // Get current status from Stripe (temporary - will be replaced with Mollie API)
    const account = await stripe.accounts.retrieve(mollieAccount.mollie_organization_id);
    logStep("Retrieved account", { 
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
    });

    // Get balance
    let balance = null;
    if (account.charges_enabled) {
      try {
        const stripeBalance = await stripe.balance.retrieve({
          stripeAccount: mollieAccount.mollie_organization_id,
        });
        balance = {
          available: stripeBalance.available.map((b: { amount: number; currency: string }) => ({
            amount: b.amount / 100,
            currency: b.currency.toUpperCase(),
          })),
          pending: stripeBalance.pending.map((b: { amount: number; currency: string }) => ({
            amount: b.amount / 100,
            currency: b.currency.toUpperCase(),
          })),
        };
        logStep("Retrieved balance", balance);
      } catch (balanceError) {
        logStep("Could not retrieve balance", { error: balanceError });
      }
    }

    // Update database with current status
    const { error: updateError } = await supabaseClient
      .from('club_mollie_accounts')
      .update({
        charges_enabled: account.charges_enabled,
        payouts_enabled: account.payouts_enabled,
        onboarding_complete: account.details_submitted,
        updated_at: new Date().toISOString(),
      })
      .eq('club_profile_id', clubProfileId);

    if (updateError) {
      logStep("Warning: Could not update Mollie account status", { error: updateError });
    }

    return new Response(JSON.stringify({
      connected: true,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      onboardingComplete: account.details_submitted,
      balance,
      mollieOrganizationId: mollieAccount.mollie_organization_id,
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
