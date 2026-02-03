import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[CANCEL-MOLLIE-SUBSCRIPTION] ${step}`, details ? JSON.stringify(details) : "");
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
    logStep("User authenticated", { userId: user.id });

    const { type = "trainer", profileId } = await req.json();

    let profile;
    let customerId: string | null = null;
    let subscriptionId: string | null = null;

    if (type === "trainer") {
      const { data, error } = await supabase
        .from("trainer_profiles")
        .select("id, mollie_customer_id, subscription_id, subscription_ends_at")
        .eq("user_id", user.id)
        .single();

      if (error || !data) throw new Error("Trainer profile not found");
      profile = data;
      customerId = data.mollie_customer_id;
      subscriptionId = data.subscription_id;
    } else if (type === "club") {
      if (!profileId) throw new Error("Club profile ID required");
      
      const { data, error } = await supabase
        .from("club_profiles")
        .select("id, mollie_customer_id, subscription_id, subscription_ends_at, club_managers!inner(user_id)")
        .eq("id", profileId)
        .eq("club_managers.user_id", user.id)
        .single();

      if (error || !data) throw new Error("Club profile not found or access denied");
      profile = data;
      customerId = data.mollie_customer_id;
      subscriptionId = data.subscription_id;
    } else {
      throw new Error("Invalid type. Use 'trainer' or 'club'");
    }

    if (!customerId || !subscriptionId) {
      throw new Error("No active subscription found");
    }

    logStep("Canceling subscription", { customerId, subscriptionId });

    // Cancel subscription in Mollie
    const cancelResponse = await fetch(
      `https://api.mollie.com/v2/customers/${customerId}/subscriptions/${subscriptionId}`,
      {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${mollieApiKey}` },
      }
    );

    if (!cancelResponse.ok && cancelResponse.status !== 404) {
      const errorText = await cancelResponse.text();
      throw new Error(`Failed to cancel subscription: ${errorText}`);
    }

    // Update database - subscription remains active until end date
    const table = type === "trainer" ? "trainer_profiles" : "club_profiles";
    await supabase
      .from(table)
      .update({
        subscription_status: "canceled",
      })
      .eq("id", profile.id);

    logStep("Subscription canceled", { endsAt: profile.subscription_ends_at });

    return new Response(
      JSON.stringify({
        success: true,
        message: "Subscription canceled. Access continues until the end of the billing period.",
        endsAt: profile.subscription_ends_at,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    return new Response(
      JSON.stringify({ error: message, success: false }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
