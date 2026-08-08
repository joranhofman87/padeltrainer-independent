import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { deleteUserData, AccountHasMembershipsError } from "../_shared/delete-user-data.ts";
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
    const { data: adminRole, error: adminRoleError } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .single();
    // PGRST116 is the ANSWER ("no admin role"), not a failure. Any other error means we do not
    // know whether this caller is an admin, and "we don't know" must not become "go ahead and
    // delete" — this endpoint deliberately refuses admins.
    if (adminRoleError && (adminRoleError as { code?: string }).code !== "PGRST116") {
      console.error("request-account-deletion: admin-role check failed", adminRoleError);
      return new Response(
        JSON.stringify({ error: "Could not verify your account type — no data was deleted." }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (adminRole) {
      return new Response(
        JSON.stringify({ error: "Admin accounts cannot be deleted via self-service. Please contact support." }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get user profile for logging (best-effort: missing metadata must not block an erasure the
    // user is entitled to, and the audit row records the ids regardless)
    const { data: userProfile } = await supabaseAdmin
      .from("profiles")
      .select("email, full_name")
      .eq("user_id", user.id)
      .single();

    // AUDIT FIRST, in a table that OUTLIVES the account. `admin_impersonation_logs` cascades from
    // auth.users, so a self-deletion destroyed its own record — and writing it earlier only moved
    // the problem: the row then existed exactly when the deletion had FAILED. Two phases here, in
    // a FK-free table: `started` before anything is touched, `completed` once the account is gone.
    const { data: auditRow, error: auditError } = await supabaseAdmin
      .from("account_deletion_audit")
      .insert({
        subject_user_id: user.id,
        actor_user_id: user.id,
        self_service: true,
        subject_email: userProfile?.email ?? null,
        subject_name: userProfile?.full_name ?? null,
        ip_address: req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip"),
        user_agent: req.headers.get("user-agent"),
      })
      .select("id")
      .single();
    if (auditError || !auditRow) {
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
    try {
      await deleteUserData(supabaseAdmin, user.id);
    } catch (err) {
      // A membership-bearing account is REFUSED, not failed-mid-way: the preflight runs before the
      // first destructive statement, so nothing was deleted. The reason is prefixed with the machine
      // -readable code so the audit can be filtered on it rather than on prose.
      const refused = err instanceof AccountHasMembershipsError;
      const reason = refused
        ? `${err.code}: ${err.message}`
        : String((err as Error)?.message ?? err);

      // the row stays as evidence, marked for what it is: a deletion that began and did not finish
      const { error: stampErr } = await supabaseAdmin.from("account_deletion_audit")
        .update({ status: "failed", failure_reason: reason.slice(0, 500) })
        .eq("id", auditRow.id);
      // a stamp that fails leaves the row at `started`, which the unfinished-deletions index
      // already surfaces — but say so loudly, because the two states mean different things
      if (stampErr) console.error("request-account-deletion: could not stamp the audit as failed", auditRow.id, stampErr);

      if (refused) {
        // 409: the account's current state prevents deletion — not a bug, and retrying unchanged will
        // not help. The message is deliberately plain: a real person reads it.
        return new Response(
          JSON.stringify({
            error: "Your account has player records that must be handled before it can be deleted. Please contact support.",
            code: err.code,
          }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      throw err;
    }
    const { error: completeErr } = await supabaseAdmin.from("account_deletion_audit")
      .update({ status: "completed" })
      .eq("id", auditRow.id);
    if (completeErr) {
      // The account IS gone; this cannot be undone and must not be reported as an outright
      // failure. What it must not do is claim a clean success: the row stays at `started`, which
      // reads as "began and did not finish" — the opposite of the truth — so it is alerted on and
      // the response says the erasure completed but its record did not.
      console.error("request-account-deletion: DELETION COMPLETED BUT UNSTAMPED", auditRow.id, completeErr);
      await notifySlackEdgeError("request-account-deletion",
        "account deleted but its audit row is still 'started' — reconcile manually",
        { audit_id: auditRow.id }).catch(() => {});
      return new Response(
        JSON.stringify({
          success: true,
          message: "Account deleted successfully",
          audit_incomplete: true,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

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
}

// Only start the server when run as the entrypoint — importing the module (for tests) must not bind a port.
if (import.meta.main) Deno.serve((req) => handleRequest(req));

