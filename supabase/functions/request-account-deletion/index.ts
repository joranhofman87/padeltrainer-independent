import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { deleteUserData } from "../_shared/delete-user-data.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Get the authorization header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Verify the user
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid authorization token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Prevent admins from using this self-deletion endpoint
    const { data: adminRole } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .single();

    if (adminRole) {
      return new Response(
        JSON.stringify({ error: "Admin accounts cannot be deleted via self-service. Please contact support." }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get user profile for logging
    const { data: userProfile } = await supabaseAdmin
      .from("profiles")
      .select("email, full_name")
      .eq("user_id", user.id)
      .single();

    // AUDIT FIRST, then delete. The audit table's admin/target columns reference auth.users, so an
    // insert attempted AFTER the account is gone is an insert that can only fail — which is what
    // made the previous ordering silently unauditable. Writing it first also means a deletion that
    // fails part-way still leaves the evidence that it was attempted.
    const { error: auditError } = await supabaseAdmin.from("admin_impersonation_logs").insert({
      admin_user_id: user.id,
      target_user_id: user.id,
      action: 'self_delete_account',
      details: { 
        deleted_email: userProfile?.email,
        deleted_name: userProfile?.full_name,
        self_service: true
      },
      ip_address: req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip"),
      user_agent: req.headers.get("user-agent"),
      expires_at: new Date().toISOString(),
    });
    if (auditError) {
      // An unauditable deletion is one we do not perform: this is a privacy operation, and "it
      // happened but nothing recorded it" is not an acceptable outcome of one.
      console.error("request-account-deletion: could not record the audit entry", auditError);
      return new Response(
        JSON.stringify({ error: "Could not record the deletion audit entry — no data was deleted." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Delete all user data. Every step fails loudly, so the auth account is removed only after
    // every dependent row has actually gone.
    await deleteUserData(supabaseAdmin, user.id);

    console.log(`User self-deleted: ${user.id}`);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Account deleted successfully",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Internal server error";
    console.error("Error in request-account-deletion function:", error);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
