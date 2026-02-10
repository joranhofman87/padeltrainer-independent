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

    // Verify the caller
    const token = authHeader.replace("Bearer ", "");
    const { data: { user: callerUser }, error: authError } = await supabaseAdmin.auth.getUser(token);

    if (authError || !callerUser) {
      return new Response(
        JSON.stringify({ error: "Invalid authorization token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get the request body
    const { 
      target_user_id, 
      trainer_profile_id,
      email, 
      full_name, 
      phone, 
      bio, 
      avatar_url, 
      skill_rating, 
      rating_system, 
      rating_member_id 
    } = await req.json();

    if (!target_user_id) {
      return new Response(
        JSON.stringify({ error: "Missing target_user_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check authorization: must be admin, academy manager, club manager, or the user themselves
    const { data: adminRole } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", callerUser.id)
      .eq("role", "admin")
      .single();

    const isAdmin = !!adminRole;
    const isSelf = callerUser.id === target_user_id;
    let isAuthorizedManager = false;

    // If not admin and not self, check if caller is academy/club manager for this trainer
    if (!isAdmin && !isSelf && trainer_profile_id) {
      // Check if caller is academy manager for this trainer
      const { data: trainerAcademies } = await supabaseAdmin
        .from('academy_trainers')
        .select('academy_profile_id')
        .eq('trainer_profile_id', trainer_profile_id)
        .eq('status', 'active');

      if (trainerAcademies && trainerAcademies.length > 0) {
        const academyIds = trainerAcademies.map(a => a.academy_profile_id);
        const { data: managerCheck } = await supabaseAdmin
          .from('academy_managers')
          .select('id')
          .eq('user_id', callerUser.id)
          .in('academy_profile_id', academyIds)
          .limit(1);
        
        if (managerCheck && managerCheck.length > 0) {
          isAuthorizedManager = true;
        }
      }

      // If still not authorized, check club manager
      if (!isAuthorizedManager) {
        const { data: trainerClubs } = await supabaseAdmin
          .from('club_trainers')
          .select('club_profile_id')
          .eq('trainer_profile_id', trainer_profile_id)
          .eq('status', 'active');

        if (trainerClubs && trainerClubs.length > 0) {
          const clubIds = trainerClubs.map(c => c.club_profile_id);
          const { data: clubManagerCheck } = await supabaseAdmin
            .from('club_managers')
            .select('id')
            .eq('user_id', callerUser.id)
            .in('club_profile_id', clubIds)
            .limit(1);
          
          if (clubManagerCheck && clubManagerCheck.length > 0) {
            isAuthorizedManager = true;
          }
        }
      }
    }

    if (!isAdmin && !isSelf && !isAuthorizedManager) {
      return new Response(
        JSON.stringify({ error: "Unauthorized: You don't have permission to update this user" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Prevent non-admins from modifying admin users
    if (!isAdmin) {
      const { data: targetAdminRole } = await supabaseAdmin
        .from("user_roles")
        .select("role")
        .eq("user_id", target_user_id)
        .eq("role", "admin")
        .single();

      if (targetAdminRole) {
        return new Response(
          JSON.stringify({ error: "Cannot modify admin users" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Update email in auth if provided
    // Admins can change any user's email directly; regular users changing their own email
    // triggers Supabase's built-in email change verification flow
    if (email) {
      if (isAdmin) {
        // Admin: directly update via admin API (no verification needed)
        const { error: updateAuthError } = await supabaseAdmin.auth.admin.updateUserById(
          target_user_id,
          { email }
        );

        if (updateAuthError) {
          console.error("Error updating auth email:", updateAuthError);
          return new Response(
            JSON.stringify({ error: updateAuthError.message }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      } else if (isSelf) {
        // Self: use admin API with email_confirm=false to trigger verification email
        const { error: updateAuthError } = await supabaseAdmin.auth.admin.updateUserById(
          target_user_id,
          { email, email_confirm: false }
        );

        if (updateAuthError) {
          console.error("Error updating auth email:", updateAuthError);
          return new Response(
            JSON.stringify({ error: updateAuthError.message }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }
      // Managers cannot change email
    }

    // Update profile - support all profile fields
    const updates: Record<string, string | number | null> = {};
    if (email !== undefined && (isAdmin || isSelf)) updates.email = email;
    if (full_name !== undefined) updates.full_name = full_name;
    if (phone !== undefined) updates.phone = phone;
    if (bio !== undefined) updates.bio = bio;
    if (avatar_url !== undefined) updates.avatar_url = avatar_url;
    if (skill_rating !== undefined) updates.skill_rating = skill_rating;
    if (rating_system !== undefined) updates.rating_system = rating_system;
    if (rating_member_id !== undefined) updates.rating_member_id = rating_member_id;

    if (Object.keys(updates).length > 0) {
      const { error: profileError } = await supabaseAdmin
        .from("profiles")
        .update(updates)
        .eq("user_id", target_user_id);

      if (profileError) {
        console.error("Error updating profile:", profileError);
        return new Response(
          JSON.stringify({ error: profileError.message }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Log the action
    await supabaseAdmin.from("admin_impersonation_logs").insert({
      admin_user_id: callerUser.id,
      target_user_id: target_user_id,
      action: 'update_user',
      details: { 
        email_changed: !!email && isAdmin, 
        name_changed: full_name !== undefined,
        caller_type: isAdmin ? 'admin' : (isSelf ? 'self' : 'manager'),
      },
      ip_address: req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip"),
      user_agent: req.headers.get("user-agent"),
      expires_at: new Date().toISOString(),
    });

    console.log(`User updated: ${target_user_id} by ${callerUser.id} (${isAdmin ? 'admin' : isSelf ? 'self' : 'manager'})`);

    return new Response(
      JSON.stringify({
        success: true,
        message: "User updated successfully",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Internal server error";
    console.error("Error in update-user function:", error);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
