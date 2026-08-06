import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { restrictedCors } from "../_shared/cors.ts";

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[CHECK-STRIPE-SUBSCRIPTION] ${step}`, details ? JSON.stringify(details) : "");
};

// Academy-managed trainers inherit entitlement from their academy's
// subscription, INCLUDING its trial period — payments go through the academy.
// Returns a success Response when an active/trialing academy covers the
// trainer, or null when there is no academy entitlement.
const academyEntitlementResponse = async (
  supabase: ReturnType<typeof createClient>,
  profile: { id: string; is_public?: boolean | null },
  corsHeaders: Record<string, string>,
): Promise<Response | null> => {
  const { data, error } = await supabase
    .from("academy_trainers")
    .select("academy_profile:academy_profiles!inner(id, name, subscription_status, trial_ends_at)")
    .eq("trainer_profile_id", profile.id)
    .eq("status", "active");

  if (error) {
    logStep("Academy entitlement check failed", { error: error.message });
    return null;
  }

  type AcademyRow = {
    academy_profile: {
      id: string;
      name: string | null;
      subscription_status: string | null;
      trial_ends_at: string | null;
    } | null;
  };

  const now = new Date();
  const coveringAcademy = ((data ?? []) as AcademyRow[])
    .map((row) => row.academy_profile)
    .find((academy) =>
      academy !== null &&
      (academy.subscription_status === "active" ||
        (academy.trial_ends_at !== null && new Date(academy.trial_ends_at) > now))
    );

  if (!coveringAcademy) return null;

  logStep("Trainer covered by academy subscription", { academyId: coveringAcademy.id });
  return new Response(
    JSON.stringify({
      subscribed: true,
      status: "active",
      tier: "academy",
      managedByAcademy: true,
      academyName: coveringAcademy.name,
      isPublic: profile.is_public ?? false,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
};

serve(async (req) => {
  const corsHeaders = restrictedCors(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY is not set");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header");

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims(token);
    if (claimsError || !claimsData?.claims?.sub) {
      logStep("Auth failed", { error: claimsError?.message });
      throw new Error("Authentication failed");
    }

    const user = { id: claimsData.claims.sub as string };
    logStep("User authenticated", { userId: user.id });

    const { type = "trainer", profileId } = await req.json();

    let profile: any;
    let trialEndsAt: string | null = null;

    if (type === "trainer") {
      const { data, error } = await supabase
        .from("trainer_profiles")
        .select("id, stripe_customer_id, subscription_status, subscription_tier, subscription_id, subscription_ends_at, trial_ends_at, is_public")
        .eq("user_id", user.id)
        .single();
      if (error || !data) throw new Error("Trainer profile not found");
      profile = data;
      trialEndsAt = data.trial_ends_at;
    } else if (type === "academy") {
      if (!profileId) throw new Error("Academy profile ID required");
      const { data, error } = await supabase
        .from("academy_profiles")
        .select("id, stripe_customer_id, subscription_status, subscription_tier, subscription_id, subscription_ends_at, trial_ends_at, academy_managers!inner(user_id)")
        .eq("id", profileId)
        .eq("academy_managers.user_id", user.id)
        .single();
      if (error || !data) throw new Error("Academy profile not found or access denied");
      profile = data;
      trialEndsAt = data.trial_ends_at;
    } else if (type === "club") {
      if (!profileId) throw new Error("Club profile ID required");
      const { data, error } = await supabase
        .from("club_profiles")
        .select("id, stripe_customer_id, subscription_status, subscription_tier, subscription_id, subscription_ends_at, trial_ends_at, club_managers!inner(user_id)")
        .eq("id", profileId)
        .eq("club_managers.user_id", user.id)
        .single();
      if (error || !data) throw new Error("Club profile not found or access denied");
      profile = data;
      trialEndsAt = data.trial_ends_at;
    } else {
      throw new Error("Invalid type. Use 'trainer', 'academy', or 'club'");
    }

    // Check manual admin override (active status without a Stripe customer)
    if (profile.subscription_status === "active" && !profile.stripe_customer_id) {
      logStep("Manual subscription override detected");
      return new Response(
        JSON.stringify({
          subscribed: true,
          status: "active",
          tier: profile.subscription_tier || "professional",
          endsAt: profile.subscription_ends_at,
          isManualOverride: true,
          ...(type === "trainer" && { isPublic: profile.is_public ?? false }),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check trial status
    if (trialEndsAt) {
      const trialEnd = new Date(trialEndsAt);
      if (trialEnd > new Date()) {
        logStep(`${type} is in trial period`);
        return new Response(
          JSON.stringify({
            subscribed: true,
            status: "trialing",
            tier: type === "trainer" ? "trial" : type === "academy" ? "academy" : "club",
            trialEndsAt,
            ...(type === "trainer" && { isPublic: profile.is_public ?? false }),
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    if (!profile.stripe_customer_id) {
      if (type === "trainer") {
        const academyResponse = await academyEntitlementResponse(supabase, profile, corsHeaders);
        if (academyResponse) return academyResponse;
      }
      logStep("No Stripe customer found");
      return new Response(
        JSON.stringify({ subscribed: false, status: "none" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Query Stripe for active subscriptions
    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

    const subscriptions = await stripe.subscriptions.list({
      customer: profile.stripe_customer_id,
      status: "active",
      limit: 1,
    });

    if (subscriptions.data.length > 0) {
      const sub = subscriptions.data[0];
      const endsAt = new Date(sub.current_period_end * 1000).toISOString();

      // Sync DB if needed
      const table = type === "trainer" ? "trainer_profiles" : type === "academy" ? "academy_profiles" : "club_profiles";
      if (profile.subscription_status !== "active" || profile.subscription_id !== sub.id) {
        await supabase.from(table).update({
          subscription_status: "active",
          subscription_id: sub.id,
          subscription_ends_at: endsAt,
        }).eq("id", profile.id);
      }

      return new Response(
        JSON.stringify({
          subscribed: true,
          status: "active",
          tier: profile.subscription_tier || (type === "trainer" ? "professional" : type),
          endsAt,
          ...(type === "trainer" && { isPublic: profile.is_public ?? false }),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check for canceled but still active subscriptions
    await stripe.subscriptions.list({
      customer: profile.stripe_customer_id,
      status: "canceled",
      limit: 1,
    });

    // Also check past_due
    const pastDueSubs = await stripe.subscriptions.list({
      customer: profile.stripe_customer_id,
      status: "past_due",
      limit: 1,
    });

    if (pastDueSubs.data.length > 0) {
      const sub = pastDueSubs.data[0];
      return new Response(
        JSON.stringify({
          subscribed: true,
          status: "past_due",
          tier: profile.subscription_tier,
          endsAt: new Date(sub.current_period_end * 1000).toISOString(),
          ...(type === "trainer" && { isPublic: profile.is_public ?? false }),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check if there's a subscription that's been canceled but still within the period
    if (profile.subscription_ends_at) {
      const endsAt = new Date(profile.subscription_ends_at);
      if (endsAt > new Date()) {
        return new Response(
          JSON.stringify({
            subscribed: true,
            status: "canceled",
            tier: profile.subscription_tier,
            endsAt: profile.subscription_ends_at,
            ...(type === "trainer" && { isPublic: profile.is_public ?? false }),
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // No active subscription
    if (type === "trainer") {
      const academyResponse = await academyEntitlementResponse(supabase, profile, corsHeaders);
      if (academyResponse) return academyResponse;
    }
    const table = type === "trainer" ? "trainer_profiles" : type === "academy" ? "academy_profiles" : "club_profiles";
    await supabase.from(table).update({ subscription_status: "inactive" }).eq("id", profile.id);

    return new Response(
      JSON.stringify({ subscribed: false, status: "inactive" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    return new Response(
      JSON.stringify({ error: message, subscribed: false }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
