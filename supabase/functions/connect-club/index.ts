import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: any) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[CONNECT-CLUB] ${step}${detailsStr}`);
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
    if (!user?.email) throw new Error("User not authenticated");
    logStep("User authenticated", { userId: user.id });

    const { clubProfileId } = await req.json();
    if (!clubProfileId) throw new Error("Club profile ID is required");
    logStep("Request payload", { clubProfileId });

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
    logStep("Club manager verified", { role: clubManager.role });

    // Get club profile with location
    const { data: clubProfile, error: clubError } = await supabaseClient
      .from('club_profiles')
      .select(`
        id,
        contact_email,
        phone,
        location_id
      `)
      .eq('id', clubProfileId)
      .single();

    if (clubError || !clubProfile) {
      throw new Error("Club profile not found");
    }

    // Get location name separately
    const { data: location } = await supabaseClient
      .from('locations')
      .select('name, city')
      .eq('id', clubProfile.location_id)
      .single();

    logStep("Club profile found", { email: clubProfile.contact_email });

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

    // Check if club already has a Stripe account
    const { data: existingAccount } = await supabaseClient
      .from('club_stripe_accounts')
      .select('stripe_account_id')
      .eq('club_profile_id', clubProfileId)
      .maybeSingle();

    let stripeAccountId: string;

    if (existingAccount?.stripe_account_id) {
      stripeAccountId = existingAccount.stripe_account_id;
      logStep("Using existing Stripe account", { stripeAccountId });
    } else {
      // Create new Stripe Express account for the club
      const locationName = location?.name || 'Club';
      const account = await stripe.accounts.create({
        type: 'express',
        email: clubProfile.contact_email || user.email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
          ideal_payments: { requested: true },
          bancontact_payments: { requested: true },
        },
        business_type: 'company',
        business_profile: {
          name: locationName,
          product_description: 'Tennis and padel training services',
        },
        metadata: {
          club_profile_id: clubProfileId,
          user_id: user.id,
        },
      });
      stripeAccountId = account.id;
      logStep("Created new Stripe account", { stripeAccountId });

      // Save to database
      const { error: insertError } = await supabaseClient
        .from('club_stripe_accounts')
        .insert({
          club_profile_id: clubProfileId,
          stripe_account_id: stripeAccountId,
        });

      if (insertError) {
        logStep("Warning: Could not save Stripe account", { error: insertError });
      }
    }

    // Create onboarding link
    const origin = req.headers.get("origin") || "https://app.padeltrainer.ai";
    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: `${origin}/club/settings?stripe_refresh=true`,
      return_url: `${origin}/club/settings?stripe_success=true`,
      type: 'account_onboarding',
    });
    logStep("Created onboarding link", { url: accountLink.url });

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
