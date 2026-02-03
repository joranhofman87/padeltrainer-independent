import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: any) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[CONNECT-TRAINER] ${step}${detailsStr}`);
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
    if (!user?.email) throw new Error("User not authenticated or email not available");
    logStep("User authenticated", { userId: user.id, email: user.email });

    // Get trainer profile
    const { data: trainerProfile, error: trainerError } = await supabaseClient
      .from('trainer_profiles')
      .select('id')
      .eq('user_id', user.id)
      .single();

    if (trainerError || !trainerProfile) {
      throw new Error("Trainer profile not found");
    }
    logStep("Trainer profile found", { trainerId: trainerProfile.id });

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });
    const origin = req.headers.get("origin") || "https://app.padeltrainer.ai";

    // Check if trainer already has a Mollie account
    const { data: existingAccount } = await supabaseClient
      .from('trainer_mollie_accounts')
      .select('mollie_organization_id, onboarding_complete')
      .eq('trainer_id', trainerProfile.id)
      .single();

    let accountId: string;

    if (existingAccount?.mollie_organization_id) {
      accountId = existingAccount.mollie_organization_id;
      logStep("Existing account found", { accountId });
    } else {
      // Create new Connect Express account
      const account = await stripe.accounts.create({
        type: 'express',
        email: user.email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
          ideal_payments: { requested: true },
          bancontact_payments: { requested: true },
        },
        business_type: 'individual',
        metadata: {
          trainer_id: trainerProfile.id,
          user_id: user.id,
        },
      });

      accountId = account.id;
      logStep("Created new account", { accountId });

      // Save to database
      const { error: insertError } = await supabaseClient
        .from('trainer_mollie_accounts')
        .insert({
          trainer_id: trainerProfile.id,
          mollie_organization_id: accountId,
          onboarding_complete: false,
          charges_enabled: false,
          payouts_enabled: false,
        });

      if (insertError) {
        logStep("Error saving account to database", { error: insertError });
      }
    }

    // Create onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${origin}/earnings?refresh=true`,
      return_url: `${origin}/earnings?connected=true`,
      type: 'account_onboarding',
    });

    logStep("Account link created", { url: accountLink.url });

    return new Response(JSON.stringify({ url: accountLink.url }), {
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
