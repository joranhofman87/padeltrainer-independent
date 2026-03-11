import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // 1. Check if bootstrap is enabled
    const bootstrapEnabled = Deno.env.get("BOOTSTRAP_ENABLED");
    if (bootstrapEnabled === "false") {
      return new Response(
        JSON.stringify({ error: "Bootstrap endpoint is disabled" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { secret, email, new_password } = await req.json();

    // 2. Verify bootstrap secret
    const bootstrapSecret = Deno.env.get("BOOTSTRAP_SECRET");
    if (!bootstrapSecret || secret !== bootstrapSecret) {
      return new Response(
        JSON.stringify({ error: "Invalid secret" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!email || !new_password) {
      return new Response(
        JSON.stringify({ error: "email and new_password are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (new_password.length < 8) {
      return new Response(
        JSON.stringify({ error: "Password must be at least 8 characters" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // 3. Find user by email using admin API (no listUsers)
    const { data: usersResponse, error: listError } = await supabaseAdmin
      .from("profiles")
      .select("user_id, email")
      .eq("email", email)
      .single();

    if (listError || !usersResponse) {
      return new Response(
        JSON.stringify({ error: "User not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const targetUserId = usersResponse.user_id;

    // 4. Block admin account resets
    const { data: adminCheck } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", targetUserId)
      .eq("role", "admin")
      .single();

    if (adminCheck) {
      return new Response(
        JSON.stringify({ error: "Cannot reset admin passwords via this endpoint" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 5. Update the password
    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
      targetUserId,
      { password: new_password }
    );

    if (updateError) {
      console.error("Password update error:", updateError);
      return new Response(
        JSON.stringify({ error: "Failed to update password" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 6. Write audit log
    await supabaseAdmin.from("admin_impersonation_logs").insert({
      admin_user_id: targetUserId, // bootstrap has no caller identity
      target_user_id: targetUserId,
      action: "bootstrap_password_reset",
      ip_address: req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip"),
      user_agent: req.headers.get("user-agent"),
      expires_at: new Date().toISOString(),
      details: { source: "bootstrap-admin-password" },
    });

    console.log(`Bootstrap password reset for ${email} at ${new Date().toISOString()}`);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Password updated successfully",
        email,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
