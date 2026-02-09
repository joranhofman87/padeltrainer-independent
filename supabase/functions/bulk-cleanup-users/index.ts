import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PRESERVED_USER_IDS = [
  "256b0ed5-1563-4eb5-899b-df559c5e9090", // info@padeltrainer.ai
  "9bcc1c6f-7978-49bb-aa06-6f1be4135fc7", // joranhofman87@gmail.com
];

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

    // Get all user IDs except preserved ones
    const { data: allProfiles, error: profilesError } = await supabaseAdmin
      .from("profiles")
      .select("user_id, email, full_name")
      .not("user_id", "in", `(${PRESERVED_USER_IDS.join(",")})`);

    if (profilesError) {
      console.error("Error fetching profiles:", profilesError);
      return new Response(
        JSON.stringify({ error: "Failed to fetch profiles" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const results: { deleted: string[]; errors: string[] } = { deleted: [], errors: [] };

    for (const profile of allProfiles || []) {
      const userId = profile.user_id;
      
      try {
        console.log(`Processing user: ${userId} (${profile.email})`);

        // 1. Delete calendar events
        await supabaseAdmin.from("calendar_events").delete().eq("user_id", userId);

        // 2. Delete notification preferences
        await supabaseAdmin.from("notification_preferences").delete().eq("user_id", userId);

        // 3. Get and delete club profiles created by this user
        const { data: userClubProfiles } = await supabaseAdmin
          .from("club_profiles")
          .select("id")
          .eq("created_by", userId);

        if (userClubProfiles && userClubProfiles.length > 0) {
          const clubIds = userClubProfiles.map((c) => c.id);
          await supabaseAdmin.from("club_trainer_invitations").delete().in("club_profile_id", clubIds);
          await supabaseAdmin.from("club_players").delete().in("club_profile_id", clubIds);
          await supabaseAdmin.from("club_mollie_accounts").delete().in("club_profile_id", clubIds);
          await supabaseAdmin.from("club_managers").delete().in("club_profile_id", clubIds);
          await supabaseAdmin.from("club_profiles").delete().in("id", clubIds);
        }

        // 4. Delete remaining club manager associations
        await supabaseAdmin.from("club_managers").delete().eq("user_id", userId);

        // 5. Get and delete trainer profile data
        const { data: trainerProfile } = await supabaseAdmin
          .from("trainer_profiles")
          .select("id")
          .eq("user_id", userId)
          .single();

        if (trainerProfile) {
          await supabaseAdmin.from("trainer_locations").delete().eq("trainer_id", trainerProfile.id);
          await supabaseAdmin.from("trainer_followers").delete().eq("trainer_id", trainerProfile.id);
          await supabaseAdmin.from("trainer_profile_views").delete().eq("trainer_id", trainerProfile.id);
          await supabaseAdmin.from("availability_slots").delete().eq("trainer_id", trainerProfile.id);
          await supabaseAdmin.from("guest_players").delete().eq("trainer_id", trainerProfile.id);
          await supabaseAdmin.from("invoices").delete().eq("trainer_id", trainerProfile.id);
          await supabaseAdmin.from("trainer_profiles").delete().eq("user_id", userId);
        }

        // 6. Get and delete player profile data
        const { data: playerProfile } = await supabaseAdmin
          .from("profiles")
          .select("id")
          .eq("user_id", userId)
          .single();

        if (playerProfile) {
          await supabaseAdmin.from("player_locations").delete().eq("profile_id", playerProfile.id);
          await supabaseAdmin.from("player_rating_history").delete().eq("profile_id", playerProfile.id);
          await supabaseAdmin.from("trainer_followers").delete().eq("player_id", playerProfile.id);
          await supabaseAdmin.from("bookings").update({ player_id: null }).eq("player_id", playerProfile.id);
          await supabaseAdmin.from("reviews").update({ is_anonymous: true }).eq("player_id", playerProfile.id);
        }

        // 7. Delete user roles
        await supabaseAdmin.from("user_roles").delete().eq("user_id", userId);

        // 8. Delete profile
        await supabaseAdmin.from("profiles").delete().eq("user_id", userId);

        // 9. Delete auth user
        const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(userId);

        if (deleteError) {
          console.error(`Error deleting auth user ${userId}:`, deleteError);
          results.errors.push(`${profile.email}: ${deleteError.message}`);
        } else {
          results.deleted.push(`${profile.email} (${userId})`);
          console.log(`Deleted user: ${userId} (${profile.email})`);
        }
      } catch (error) {
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
        preserved_users: PRESERVED_USER_IDS,
      },
      ip_address: req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip"),
      user_agent: req.headers.get("user-agent"),
      expires_at: new Date().toISOString(),
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: `Cleanup complete. Deleted ${results.deleted.length} users.`,
        deleted: results.deleted,
        errors: results.errors,
        preserved: PRESERVED_USER_IDS,
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
