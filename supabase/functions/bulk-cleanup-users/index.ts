// Admin-only "wipe all non-admin users" tool (dev/reset utility; UI: src/lib/admin.ts).
//
// B0 (audit Theme B prereq / R03+R06 leftover): this function used to carry its OWN drifted copy of
// the per-user deletion sequence, which still HARD-DELETED the trainer's availability_slots
// (cascading away every booking, paid included) and invoices — the exact financial-record loss
// Theme A (R02/R03, PRs #549/#550) removed from the shared path. Its player branch had also rotted:
// the bare bookings anonymize (no anonymized_at stamp) now trips booking_has_player, gets
// swallowed, and the subsequent profiles delete FK-fails — stranding half-deleted users.
//
// Now every user goes through the SAME shared deleteUserData as delete-user and
// request-account-deletion: financial records are retained (anonymized-shell trainer_profiles,
// anonymized bookings/invoices), clubs/academies are preserved with created_by nulled, ordering and
// error surfacing are maintained in ONE place. This function keeps only what is bulk-specific: the
// admin gate, the {confirm:true} safety latch, the preserved-admins set, per-user error collection,
// and the audit log entry.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { deleteUserData, AccountHasMembershipsError } from "../_shared/delete-user-data.ts";

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

    // Get confirmation from request body
    const { confirm } = await req.json();
    if (!confirm) {
      return new Response(
        JSON.stringify({ error: "Confirmation required. Send { confirm: true }" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Resolve preserved user IDs at runtime: every admin is preserved.
    const { data: adminRows, error: adminFetchError } = await supabaseAdmin
      .from("user_roles")
      .select("user_id")
      .eq("role", "admin");

    if (adminFetchError) {
      console.error("Error fetching admin users:", adminFetchError);
      return new Response(
        JSON.stringify({ error: "Failed to load preserved admins" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const preservedUserIds = Array.from(new Set((adminRows ?? []).map((r) => r.user_id)));
    if (preservedUserIds.length === 0) {
      return new Response(
        JSON.stringify({ error: "Refusing to run: no admin users to preserve" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get all user IDs except preserved ones
    const { data: allProfiles, error: profilesError } = await supabaseAdmin
      .from("profiles")
      .select("user_id, email, full_name")
      .not("user_id", "in", `(${preservedUserIds.join(",")})`);

    if (profilesError) {
      console.error("Error fetching profiles:", profilesError);
      return new Response(
        JSON.stringify({ error: "Failed to fetch profiles" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // `skipped` is its own bucket, deliberately separate from `errors`: a membership-bearing account
    // is not a failure to investigate, it is a decision the preflight made. Folding the two together
    // would bury a routine skip in a list of things that went wrong — and, worse, make a run that
    // skipped everything look like a run that broke.
    const results: { deleted: string[]; errors: string[]; skipped: string[] } =
      { deleted: [], errors: [], skipped: [] };

    for (const profile of allProfiles || []) {
      const userId = profile.user_id;

      try {
        console.log(`Processing user: ${userId}`);
        // The one shared deletion path (retains financial records, preserves orgs,
        // FK-ordered, throws loudly on any failed step incl. the auth-user delete).
        await deleteUserData(supabaseAdmin, userId);
        results.deleted.push(`${profile.email} (${userId})`);
        console.log(`Deleted user: ${userId}`);
      } catch (error) {
        if (error instanceof AccountHasMembershipsError) {
          // SKIP and continue. The preflight refused before touching anything, so this user's auth
          // account and every row it owns are untouched — nothing to clean up, nothing half-done.
          console.log(`Skipped user ${userId}: ${error.code} (${error.membershipCount} membership(s))`);
          results.skipped.push(
            `${profile.email} (${userId}): ${error.code} — ${error.membershipCount} academy membership(s)`,
          );
          continue;
        }
        console.error(`Error processing user ${userId}:`, error);
        results.errors.push(`${profile.email}: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }

    // Log the cleanup action
    await supabaseAdmin.from("admin_impersonation_logs").insert({
      admin_user_id: adminUser.id,
      target_user_id: adminUser.id,
      action: "bulk_cleanup_users",
      details: {
        deleted_count: results.deleted.length,
        error_count: results.errors.length,
        skipped_count: results.skipped.length,
        preserved_users: preservedUserIds,
      },
      ip_address: req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip"),
      user_agent: req.headers.get("user-agent"),
      expires_at: new Date().toISOString(),
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: `Cleanup complete. Deleted ${results.deleted.length} users, skipped ${results.skipped.length}.`,
        deleted: results.deleted,
        errors: results.errors,
        skipped: results.skipped,
        preserved: preservedUserIds,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Internal server error";
    console.error("Error in bulk-cleanup-users function:", error);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
