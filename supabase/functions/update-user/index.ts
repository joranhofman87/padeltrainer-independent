import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendResendEmail } from "../_shared/resend-send.ts";
import { GLOBAL_IDENTITY_FIELDS } from "../_shared/trainer-authority.ts";

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

    // GoTrue stores emails lowercased; normalize once so the auth update, the
    // profiles write, the change-detection and the notification all agree.
    const normalizedEmail = typeof email === "string" && email.trim() ? email.trim().toLowerCase() : null;

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

      // The club-manager grant that used to live here queried `club_trainers`, a table no
      // migration creates: PostgREST answered 42703, the error was dropped, and the branch could
      // never authorize anyone. Removed rather than repaired — under OD-1 a tenant manager has no
      // global-identity authority to grant, so restoring it would only re-create a path that must
      // refuse anyway. Club trainer management belongs to the trainer-permissions unit.
    }

    // SECURITY (IDOR guard): the manager checks above prove the caller manages the
    // SUBMITTED trainer_profile_id — but that only grants authority over the user who
    // OWNS that trainer profile. Without this, a manager of trainer A could pass
    // trainer_profile_id=A together with target_user_id=B (any unrelated non-admin)
    // and edit B's profile. Resolve the trainer's user_id server-side and revoke the
    // manager grant unless it matches the target. (Admins and self are unaffected.)
    if (isAuthorizedManager) {
      const { data: managedTrainer } = await supabaseAdmin
        .from("trainer_profiles")
        .select("user_id")
        .eq("id", trainer_profile_id)
        .maybeSingle();
      if (!managedTrainer || managedTrainer.user_id !== target_user_id) {
        isAuthorizedManager = false;
      }
    }

    // IDENTITY IS SELF-SERVICE (OD-1, owner decision 2026-08-06).
    //
    // A tenant manager may manage a trainer's membership, their academy role and their
    // permissions. They may never change that trainer's global login identity — the auth email,
    // the password, the credential — because the trainer owns it, not the academy. This holds even
    // when one manager happens to manage every academy the trainer belongs to: "nobody else is
    // affected today" is not the same as "this is mine to change", and a trainer who joins a second
    // academy tomorrow should not discover their login was rotated by the first.
    //
    // What an academy MAY do instead is INITIATE: invite, send a password-reset link, ask the
    // trainer to confirm an email change. Those flows end with the trainer acting, which is the
    // point. A platform-administrator recovery path exists and is audited.
    //
    // This replaces the earlier exclusivity carve-out (a manager of every tenant could still
    // rotate the login). The cross-tenant case it closed stays closed; the rest is now closed too.
    const mayChangeGlobalIdentity = isAdmin || isSelf;

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
    // Admins and academy/club managers change the email directly via the admin API;
    // regular users changing their own email go through Supabase's verification flow.
    // Manager changes are a deliberate capability (academies fully manage their
    // trainers' accounts, which they often created themselves) — the trade-off is that
    // this rotates the trainer's LOGIN. Safeguards: the change is audit-logged below
    // and a notification is sent to the OLD address so a real account owner notices.
    let emailChanged = false;
    let previousEmail: string | null = null;
    if (normalizedEmail && !mayChangeGlobalIdentity) {
      // Refused, not silently dropped: a manager who believes they changed a login and did not is
      // worse off than one who is told they cannot. The answer names what they CAN do.
      return new Response(
        JSON.stringify({
          error: "A trainer's login email can only be changed by the trainer themselves, or by a platform administrator through the audited recovery path. Send them a password-reset or email-change link instead — they confirm it from their own account.",
          code: "identity_is_self_service",
        }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (normalizedEmail) {
      if (isAdmin) {
        // the audited platform-administrator recovery path. A notice still goes to the OLD address
        // below, so a real account owner sees that their login moved.
        const { data: oldUser, error: lookupError } = await supabaseAdmin.auth.admin.getUserById(target_user_id);
        if (lookupError) console.error("Old-email lookup failed (notification may be skipped):", lookupError);
        previousEmail = oldUser?.user?.email?.toLowerCase() ?? null;
        if (previousEmail === normalizedEmail) previousEmail = null; // no-op change → no notice
        // Directly update via admin API (no verification needed)
        const { error: updateAuthError } = await supabaseAdmin.auth.admin.updateUserById(
          target_user_id,
          { email: normalizedEmail }
        );

        if (updateAuthError) {
          console.error("Error updating auth email:", updateAuthError);
          return new Response(
            JSON.stringify({ error: updateAuthError.message }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        emailChanged = true;
      } else if (isSelf) {
        // Self: use admin API with email_confirm=false to trigger verification email
        const { error: updateAuthError } = await supabaseAdmin.auth.admin.updateUserById(
          target_user_id,
          { email: normalizedEmail, email_confirm: false }
        );

        if (updateAuthError) {
          console.error("Error updating auth email:", updateAuthError);
          return new Response(
            JSON.stringify({ error: updateAuthError.message }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        emailChanged = true;
      }
    }

    // Update profile — every field below lives on the ONE shared identity (GLOBAL_IDENTITY_FIELDS),
    // so a caller without that authority writes none of them. Refusing the whole write rather than
    // silently dropping fields: a partial success that reports success is how a manager comes to
    // believe they renamed someone.
    const updates: Record<string, string | number | null> = {};
    if (normalizedEmail && mayChangeGlobalIdentity) updates.email = normalizedEmail;
    if (full_name !== undefined) updates.full_name = full_name;
    if (phone !== undefined) updates.phone = phone;
    if (bio !== undefined) updates.bio = bio;
    if (avatar_url !== undefined) updates.avatar_url = avatar_url;
    if (skill_rating !== undefined) updates.skill_rating = skill_rating;
    if (rating_system !== undefined) updates.rating_system = rating_system;
    if (rating_member_id !== undefined) updates.rating_member_id = rating_member_id;

    // EVERY field this endpoint writes lives on the ONE shared identity — the profiles row every
    // tenant reads. So under OD-1 a manager caller writes none of them, and the honest answer is a
    // refusal rather than a 200 that changed nothing. Listed explicitly (GLOBAL_IDENTITY_FIELDS)
    // so adding a column here is a decision about whose it is rather than an accident.
    const attemptedGlobal = Object.keys(updates).filter(
      (k) => (GLOBAL_IDENTITY_FIELDS as readonly string[]).includes(k));
    if (attemptedGlobal.length > 0 && !mayChangeGlobalIdentity) {
      return new Response(
        JSON.stringify({
          error: "A trainer's own name, contact details and photo belong to them. Ask the trainer to update them in their account, or change what your academy controls — their membership, role and permissions.",
          code: "identity_is_self_service",
          fields: attemptedGlobal,
        }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

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

    // Best-effort heads-up to the OLD address on a manager-initiated change: a real
    // account owner must be able to notice a takeover. Sent only after BOTH the auth
    // and profiles writes landed; never blocks the update. The address is HTML-escaped
    // as defense-in-depth (GoTrue already rejects addresses with markup characters).
    if (emailChanged && isAdmin && !isSelf && previousEmail && normalizedEmail) {
      const escapedEmail = normalizedEmail
        .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
      const resendKey = Deno.env.get("RESEND_API_KEY");
      if (resendKey) {
        const outcome = await sendResendEmail(resendKey, {
          from: "PadelTrainer.ai <noreply@app.padeltrainer.ai>",
          to: [previousEmail],
          subject: "Your PadelTrainer.ai login email was changed",
          html: `<p>The login email of your PadelTrainer.ai account was changed to <strong>${escapedEmail}</strong> by a manager of your academy or club.</p><p>If this was expected, no action is needed. If you did not expect this, contact your academy or reply to this email immediately.</p>`,
        });
        if (!outcome.ok) console.error("Old-address notification failed:", outcome.error);
      } else {
        console.error("RESEND_API_KEY not configured — old-address notification skipped");
      }
    }

    // Log the action
    await supabaseAdmin.from("admin_impersonation_logs").insert({
      admin_user_id: callerUser.id,
      target_user_id: target_user_id,
      action: 'update_user',
      details: { 
        email_changed: emailChanged, 
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
