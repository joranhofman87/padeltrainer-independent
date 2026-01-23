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

    // Clean up related data in order (respecting foreign key constraints)
    // 1. Delete calendar events
    await supabaseAdmin
      .from("calendar_events")
      .delete()
      .eq("user_id", user.id);

    // 2. Delete notification preferences
    await supabaseAdmin
      .from("notification_preferences")
      .delete()
      .eq("user_id", user.id);

    // 3. Get club profiles created by this user and delete them
    const { data: userClubProfiles } = await supabaseAdmin
      .from("club_profiles")
      .select("id")
      .eq("created_by", user.id);

    if (userClubProfiles && userClubProfiles.length > 0) {
      const clubIds = userClubProfiles.map((c) => c.id);
      
      // Delete club-related data first
      await supabaseAdmin
        .from("club_trainer_invitations")
        .delete()
        .in("club_profile_id", clubIds);

      await supabaseAdmin
        .from("club_players")
        .delete()
        .in("club_profile_id", clubIds);

      await supabaseAdmin
        .from("club_stripe_accounts")
        .delete()
        .in("club_profile_id", clubIds);

      await supabaseAdmin
        .from("club_managers")
        .delete()
        .in("club_profile_id", clubIds);

      // Delete the club profiles
      await supabaseAdmin
        .from("club_profiles")
        .delete()
        .in("id", clubIds);
    }

    // 4. Delete remaining club manager associations (where user was manager but not creator)
    await supabaseAdmin
      .from("club_managers")
      .delete()
      .eq("user_id", user.id);

    // 5. Get trainer profile ID if exists
    const { data: trainerProfile } = await supabaseAdmin
      .from("trainer_profiles")
      .select("id")
      .eq("user_id", user.id)
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
        .from("lessons")
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

      // Delete trainer profile
      await supabaseAdmin
        .from("trainer_profiles")
        .delete()
        .eq("user_id", user.id);
    }

    // 6. Get player profile ID if exists
    const { data: playerProfile } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("user_id", user.id)
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

    // 7. Delete user roles
    await supabaseAdmin
      .from("user_roles")
      .delete()
      .eq("user_id", user.id);

    // 8. Delete profile
    await supabaseAdmin
      .from("profiles")
      .delete()
      .eq("user_id", user.id);

    // 9. Finally, delete the auth user
    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(user.id);

    if (deleteError) {
      console.error("Error deleting auth user:", deleteError);
      return new Response(
        JSON.stringify({ error: "Failed to delete user from auth system" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Log the self-deletion action for audit
    await supabaseAdmin.from("admin_impersonation_logs").insert({
      admin_user_id: user.id, // Self-delete, user is their own admin
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

    console.log(`User self-deleted: ${user.id} (${userProfile?.email})`);

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
