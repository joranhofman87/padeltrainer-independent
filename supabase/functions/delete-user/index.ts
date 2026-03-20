import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

    // Clean up related data in order (respecting foreign key constraints)
    // 1. Delete calendar events
    await supabaseAdmin
      .from("calendar_events")
      .delete()
      .eq("user_id", target_user_id);

    // 2. Delete notification preferences
    await supabaseAdmin
      .from("notification_preferences")
      .delete()
      .eq("user_id", target_user_id);

    // 3. Clean up cycles owned by clubs/academies this user created
    const { data: userClubProfiles } = await supabaseAdmin
      .from("club_profiles")
      .select("id")
      .eq("created_by", target_user_id);

    if (userClubProfiles && userClubProfiles.length > 0) {
      const clubIds = userClubProfiles.map((c) => c.id);
      const { data: clubCycles } = await supabaseAdmin
        .from("cycles")
        .select("id")
        .eq("owner_type", "club")
        .in("owner_id", clubIds);

      if (clubCycles && clubCycles.length > 0) {
        const cycleIds = clubCycles.map((c) => c.id);
        await supabaseAdmin.from("intake_requests").delete().in("cycle_id", cycleIds);
        await supabaseAdmin.from("cycles").delete().in("id", cycleIds);
      }
    }

    const { data: userAcademyProfiles } = await supabaseAdmin
      .from("academy_profiles")
      .select("id")
      .eq("created_by", target_user_id);

    if (userAcademyProfiles && userAcademyProfiles.length > 0) {
      const academyIds = userAcademyProfiles.map((c) => c.id);
      const { data: academyCycles } = await supabaseAdmin
        .from("cycles")
        .select("id")
        .eq("owner_type", "academy")
        .in("owner_id", academyIds);

      if (academyCycles && academyCycles.length > 0) {
        const cycleIds = academyCycles.map((c) => c.id);
        await supabaseAdmin.from("intake_requests").delete().in("cycle_id", cycleIds);
        await supabaseAdmin.from("cycles").delete().in("id", cycleIds);
      }
    }

    // Preserve club profiles created by this user - just remove the creator reference
    // This keeps the club data (logo, banner, description) intact
    await supabaseAdmin
      .from("club_profiles")
      .update({ created_by: null })
      .eq("created_by", target_user_id);

    // Remove user from club_managers where they are a member (but preserve the club itself)
    await supabaseAdmin
      .from("club_managers")
      .delete()
      .eq("user_id", target_user_id);

    // Preserve academy profiles created by this user - just remove the creator reference
    await supabaseAdmin
      .from("academy_profiles")
      .update({ created_by: null })
      .eq("created_by", target_user_id);

    // Remove user from academy_managers where they are a member (but preserve the academy itself)
    await supabaseAdmin
      .from("academy_managers")
      .delete()
      .eq("user_id", target_user_id);

    // 4. Get trainer profile ID if exists
    const { data: trainerProfile } = await supabaseAdmin
      .from("trainer_profiles")
      .select("id")
      .eq("user_id", target_user_id)
      .single();

    if (trainerProfile) {
      // Delete trainer-related data
      await supabaseAdmin
        .from("trainer_locations")
        .delete()
        .eq("trainer_id", trainerProfile.id);

      await supabaseAdmin
        .from("trainer_followers")
        .delete()
        .eq("trainer_id", trainerProfile.id);

      await supabaseAdmin
        .from("trainer_profile_views")
        .delete()
        .eq("trainer_id", trainerProfile.id);

      await supabaseAdmin
        .from("availability_slots")
        .delete()
        .eq("trainer_id", trainerProfile.id);

      await supabaseAdmin
        .from("guest_players")
        .delete()
        .eq("trainer_id", trainerProfile.id);

      await supabaseAdmin
        .from("invoices")
        .delete()
        .eq("trainer_id", trainerProfile.id);

      // Delete cycles owned by this trainer and their intake requests
      const { data: trainerCycles } = await supabaseAdmin
        .from("cycles")
        .select("id")
        .eq("owner_type", "trainer")
        .eq("owner_id", trainerProfile.id);

      if (trainerCycles && trainerCycles.length > 0) {
        const cycleIds = trainerCycles.map((c) => c.id);
        await supabaseAdmin
          .from("intake_requests")
          .delete()
          .in("cycle_id", cycleIds);
        await supabaseAdmin
          .from("cycles")
          .delete()
          .in("id", cycleIds);
      }

      // Delete trainer profile
      await supabaseAdmin
        .from("trainer_profiles")
        .delete()
        .eq("user_id", target_user_id);
    }

    // 5. Get player profile ID if exists
    const { data: playerProfile } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("user_id", target_user_id)
      .single();

    if (playerProfile) {
      // Delete player-related data
      await supabaseAdmin
        .from("player_locations")
        .delete()
        .eq("profile_id", playerProfile.id);

      await supabaseAdmin
        .from("player_rating_history")
        .delete()
        .eq("profile_id", playerProfile.id);

      await supabaseAdmin
        .from("trainer_followers")
        .delete()
        .eq("player_id", playerProfile.id);

      // Anonymize bookings (keep for record-keeping but remove player reference)
      await supabaseAdmin
        .from("bookings")
        .update({ player_id: null })
        .eq("player_id", playerProfile.id);

      // Anonymize reviews
      await supabaseAdmin
        .from("reviews")
        .update({ is_anonymous: true })
        .eq("player_id", playerProfile.id);
    }

    // 6. Delete user roles
    await supabaseAdmin
      .from("user_roles")
      .delete()
      .eq("user_id", target_user_id);

    // 7. Delete profile
    await supabaseAdmin
      .from("profiles")
      .delete()
      .eq("user_id", target_user_id);

    // 8. Finally, delete the auth user
    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(target_user_id);

    if (deleteError) {
      console.error("Error deleting auth user:", deleteError);
      return new Response(
        JSON.stringify({ error: "Failed to delete user from auth system" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Log the admin action
    await supabaseAdmin.from("admin_impersonation_logs").insert({
      admin_user_id: adminUser.id,
      target_user_id: target_user_id,
      action: 'delete_user',
      details: { 
        deleted_email: targetProfile?.email,
        deleted_name: targetProfile?.full_name
      },
      ip_address: req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip"),
      user_agent: req.headers.get("user-agent"),
      expires_at: new Date().toISOString(), // Not applicable for delete, just set to now
    });

    console.log(`User deleted: ${target_user_id} (${targetProfile?.email}) by admin ${adminUser.id}`);

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
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
