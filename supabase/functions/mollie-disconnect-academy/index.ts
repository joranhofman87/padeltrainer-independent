import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { corsHeaders, jsonForbidden, requireUser } from "../_shared/auth.ts";

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[MOLLIE-DISCONNECT-ACADEMY] ${step}`, details ? JSON.stringify(details) : "");
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authResult = await requireUser(req);
    if (authResult instanceof Response) return authResult;
    const { user, supabase: supabaseClient } = authResult;

    const { academyProfileId } = await req.json();
    if (!academyProfileId) throw new Error("Academy profile ID is required");

    const { data: academyManager } = await supabaseClient
      .from("academy_managers")
      .select("role")
      .eq("academy_profile_id", academyProfileId)
      .eq("user_id", user.id)
      .single();

    if (!academyManager) {
      return jsonForbidden("You are not a manager of this academy");
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
