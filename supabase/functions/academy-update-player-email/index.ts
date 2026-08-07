// Email remediation — gated academy edit of a registered player's REAL email.
//
// Only allowed when get_player_email_edit_capability returns 'direct' (the player
// never logged in, is single-tenant, and this academy owns them) — i.e. the email
// is academy-entered contact data, not a login identity in use. The gate runs AS
// THE CALLER (the RPC authorizes via auth.uid()); only on 'direct' do we touch auth
// with the service role. Everything else must use the billing-email override.
//
// Auto-confirms the new email (no verification spam — they never logged in) and
// writes an audit row. verify_jwt=false: the caller's JWT is validated here.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const isValidEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json(401, { error: "missing_authorization" });
    const token = authHeader.replace("Bearer ", "");
    const { data: { user: caller }, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !caller) return json(401, { error: "invalid_token" });

    const { profile_id, academy_profile_id, email } = await req.json();
    if (!profile_id || !academy_profile_id || !email) {
      return json(400, { error: "missing_profile_id_academy_or_email" });
    }
    const newEmail = String(email).trim().toLowerCase();
    if (!isValidEmail(newEmail)) return json(400, { error: "invalid_email" });

    // GATE — run as the caller so the RPC's is_academy_manager(auth.uid()) check applies.
    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: capability, error: capErr } = await userClient.rpc("get_player_email_edit_capability", {
      _profile_id: profile_id,
      _academy_profile_id: academy_profile_id,
    });
    if (capErr) return json(403, { error: "not_authorized", detail: capErr.message });
    if (capability !== "direct") {
      return json(403, { error: "not_allowed", capability }); // UI must offer the billing override instead
    }

    // Resolve target login from the profile.
    const { data: prof, error: profErr } = await admin
      .from("profiles").select("user_id, email").eq("id", profile_id).single();
    if (profErr || !prof?.user_id) return json(404, { error: "player_not_found" });
    const targetUserId = prof.user_id as string;
    const oldEmail = prof.email as string | null;

    // Never touch an admin account.
    const { data: targetAdmin, error: targetAdminErr } = await admin
      .from("user_roles").select("role").eq("user_id", targetUserId).eq("role", "admin").maybeSingle();
    if (targetAdminErr) return json(503, { error: "role_check_failed" });
    if (targetAdmin) return json(403, { error: "cannot_modify_admin" });

    // NEVER A TRAINER (OD-1). A trainer owns their login and changes it themselves; an academy may
    // only INITIATE an invitation or reset. This endpoint exists for the narrower case the gate
    // below enforces — correcting a typo in a player invitation that has never been used — and a
    // trainer is outside it regardless of how nascent the account looks.
    const { data: targetTrainer, error: targetTrainerErr } = await admin
      .from("trainer_profiles").select("id").eq("user_id", targetUserId).maybeSingle();
    if (targetTrainerErr) return json(503, { error: "trainer_check_failed" });
    if (targetTrainer) {
      return json(403, {
        error: "identity_is_self_service",
        detail: "A trainer's login belongs to them. Send an invitation or a password-reset link instead — they confirm the change from their own account.",
      });
    }

    // Defense-in-depth: re-verify the account is STILL nascent right before the
    // write (closes the gate->write race, and redundantly enforces never-confirmed
    // independent of the capability RPC).
    const { data: targetAuth, error: targetAuthErr } = await admin.auth.admin.getUserById(targetUserId);
    // a lookup that FAILED is not evidence the account is nascent. Treating it as "inactive" made
    // the defence-in-depth check fail open, which is the opposite of its purpose.
    if (targetAuthErr || !targetAuth?.user) return json(503, { error: "account_state_unknown" });
    if (targetAuth?.user?.last_sign_in_at || targetAuth?.user?.email_confirmed_at) {
      return json(403, { error: "account_active" });
    }

    // Update the auth email (auto-confirmed — the gate guarantees they never logged in).
    const { error: authUpdErr } = await admin.auth.admin.updateUserById(targetUserId, {
      email: newEmail,
      email_confirm: true,
    });
    if (authUpdErr) return json(400, { error: authUpdErr.message });

    // Mirror to the profile.
    const { error: profUpdErr } = await admin.from("profiles").update({ email: newEmail }).eq("id", profile_id);
    if (profUpdErr) return json(400, { error: profUpdErr.message });

    // Audit (same table update-user uses).
    await admin.from("admin_impersonation_logs").insert({
      admin_user_id: caller.id,
      target_user_id: targetUserId,
      action: "academy_update_player_email",
      details: { profile_id, academy_profile_id, old_email: oldEmail, new_email: newEmail },
    });

    return json(200, { success: true, email: newEmail });
  } catch (e) {
    return json(500, { error: e instanceof Error ? e.message : String(e) });
  }
});
