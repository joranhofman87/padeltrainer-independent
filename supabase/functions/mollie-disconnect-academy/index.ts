import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[MOLLIE-DISCONNECT-ACADEMY] ${step}`, details ? JSON.stringify(details) : "");
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user) throw new Error("User not authenticated");

    const { academyProfileId } = await req.json();
    if (!academyProfileId) throw new Error("Academy profile ID is required");

    const { data: academyManager } = await supabaseClient
      .from("academy_managers")
      .select("role")
      .eq("academy_profile_id", academyProfileId)
      .eq("user_id", user.id)
      .single();

    if (!academyManager) {
      throw new Error("You are not a manager of this academy");
    }

    const { error: deleteError } = await supabaseClient
      .from("academy_mollie_accounts")
      .delete()
      .eq("academy_profile_id", academyProfileId);

    if (deleteError) {
      logStep("Delete failed", { error: deleteError.message });
      throw new Error("Failed to disconnect payment account");
    }

    await supabaseClient
      .from("academy_profiles")
      .update({ mollie_customer_id: null })
      .eq("id", academyProfileId);

    logStep("Academy Mollie disconnected", { academyProfileId });

    return new Response(JSON.stringify({ success: true }), {
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
