import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { deleteUserData } from "../_shared/delete-user-data.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * The route body, exported so tests can drive the REAL contract — status codes, response shape and
 * audit writes — instead of a copy of it. `deps.admin` is the only injection point: production passes
 * nothing and the client is built from the environment exactly as before.
 */
export async function handleRequest(
  req: Request,
  deps: { admin?: SupabaseClient } = {},
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabaseAdmin = deps.admin ?? createClient(supabaseUrl, supabaseServiceKey, {
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

    // Verify the admin user
    const token = authHeader.replace("Bearer ", "");
    const { data: { user: adminUser }, error: authError } = await supabaseAdmin.auth.getUser(token);

    if (authError || !adminUser) {
      return new Response(
        JSON.stringify({ error: "Invalid authorization token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check if the caller is an admin
    const { data: adminRole } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", adminUser.id)
      .eq("role", "admin")
      .single();

    if (!adminRole) {
      return new Response(
        JSON.stringify({ error: "Unauthorized: Admin access required" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get the target user ID from request body
    const { target_user_id } = await req.json();

    if (!target_user_id) {
      return new Response(
        JSON.stringify({ error: "Missing target_user_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Prevent self-deletion
    if (target_user_id === adminUser.id) {
      return new Response(
        JSON.stringify({ error: "Cannot delete your own account" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check if target user is an admin (prevent deleting other admins)
    const { data: targetAdminRole } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", target_user_id)
      .eq("role", "admin")
      .single();

    if (targetAdminRole) {
      return new Response(
        JSON.stringify({ error: "Cannot delete admin users" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get target user info for logging
    const { data: targetProfile } = await supabaseAdmin
      .from("profiles")
      .select("email, full_name")
      .eq("user_id", target_user_id)
      .single();

    // Delete all user data
    await deleteUserData(supabaseAdmin, target_user_id);

    // Log the admin action
    const { error: auditLogError } = await supabaseAdmin.from("admin_impersonation_logs").insert({
      admin_user_id: adminUser.id,
      target_user_id: target_user_id,
      action: 'delete_user',
      details: { 
        deleted_email: targetProfile?.email,
        deleted_name: targetProfile?.full_name
      },
      ip_address: req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip"),
      user_agent: req.headers.get("user-agent"),
      expires_at: new Date().toISOString(),
    });
    if (auditLogError) {
      // Alert: user was deleted but the audit-trail write failed — IDs/error only, no PII
      console.error("Failed to write admin_impersonation_logs for delete_user:", auditLogError);
      await notifySlackEdgeError("delete-user", `audit log insert failed: ${auditLogError.message}`, { admin_user_id: adminUser.id, target_user_id });
    }

    console.log(`User deleted: ${target_user_id} by admin ${adminUser.id}`);

    return new Response(
      JSON.stringify({
        success: true,
        message: "User deleted successfully",
        deleted_user: {
          id: target_user_id,
          email: targetProfile?.email,
          full_name: targetProfile?.full_name,
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Internal server error";
    console.error("Error in delete-user function:", error);
    // Alert: security-sensitive account deletion failed — IDs/error only, no PII
    await notifySlackEdgeError("delete-user", errorMessage);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

// Only start the server when run as the entrypoint — importing the module (for tests) must not bind a port.
if (import.meta.main) Deno.serve((req) => handleRequest(req));

