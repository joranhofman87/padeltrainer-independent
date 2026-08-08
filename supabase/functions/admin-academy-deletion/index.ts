/**
 * Admin academy deletion — the ONLY caller of the academy-deletion database functions.
 *
 * Those functions are granted to `service_role` alone, so the browser cannot reach them; this route
 * is the boundary. It verifies the caller is an admin BEFORE issuing any RPC, derives the acting
 * admin id from the token rather than the request body, and owns the audit lifecycle:
 *
 *   started  — a separate, committed row written BEFORE confirmation. If this write fails we do NOT
 *              confirm: an unauditable destruction is one we decline to perform.
 *   completed— stamped by `academy_delete_confirmed` INSIDE its own deletion transaction, so
 *              "deleted" and "recorded as completed" are the same commit.
 *   failed   — stamped here, in a separate call, when the database refuses. If THAT stamp fails the
 *              response says `audit_incomplete: true` and alerts; it never claims a clean refusal
 *              over a row still reading `started`.
 */
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { corsHeaders } from "../_shared/auth.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";

/** Structured refusals the database raises. Callers branch on these, never on message prose. */
export const DELETION_REFUSAL_CODES = [
  "ACADEMY_DELETION_CATALOG_DRIFT",
  "PREVIEW_STALE",
  "BLOCKED",
  "AUDIT_BINDING_MISMATCH",
  "AUDIT_NOT_FOUND",
  "AUDIT_NOT_COMPLETABLE",
] as const;

/** Pull the structured code out of a Postgres error message, or null if it is not one of ours. */
export function refusalCodeOf(message: string | undefined | null): string | null {
  if (!message) return null;
  for (const code of DELETION_REFUSAL_CODES) {
    if (message.startsWith(code) || message.includes(`${code}:`)) return code;
  }
  return null;
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

export async function handleRequest(
  req: Request,
  deps: { admin?: SupabaseClient } = {},
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = deps.admin ?? createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ── authorization, before ANY rpc ────────────────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing authorization header" }, 401);

    const { data: { user: adminUser }, error: authError } =
      await supabaseAdmin.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authError || !adminUser) return json({ error: "Invalid authorization token" }, 401);

    const { data: adminRole } = await supabaseAdmin
      .from("user_roles").select("role")
      .eq("user_id", adminUser.id).eq("role", "admin").maybeSingle();
    if (!adminRole) return json({ error: "Unauthorized: Admin access required" }, 403);

    const body = await req.json().catch(() => ({}));
    const action = body?.action;
    const academyProfileId = body?.academy_profile_id;
    if (!academyProfileId) return json({ error: "academy_profile_id is required" }, 400);

    // ── preview ─────────────────────────────────────────────────────────────────────────────
    if (action === "preview") {
      const { data, error } = await supabaseAdmin.rpc("academy_deletion_preview", {
        _academy_id: academyProfileId,
      });
      if (error) return json({ error: error.message }, 500);
      return json({ preview: data }, 200);
    }

    if (action !== "confirm") return json({ error: "action must be 'preview' or 'confirm'" }, 400);

    // ── confirm ─────────────────────────────────────────────────────────────────────────────
    // Only the digest and version travel from the client. Counts are never trusted from a caller —
    // the database recomputes them and writes its own into the audit.
    const expectedDigest = body?.expected_digest;
    const previewVersion = body?.preview_version;
    if (typeof expectedDigest !== "string" || !expectedDigest
        || !Number.isInteger(previewVersion)) {
      return json({ error: "expected_digest and preview_version are required" }, 400);
    }

    // (a) start — separate and committed BEFORE anything destructive.
    const { data: auditRow, error: auditError } = await supabaseAdmin
      .from("academy_deletion_audit")
      .insert({
        academy_profile_id: academyProfileId,
        actor_user_id: adminUser.id,          // server-derived, never from the body
        preview_version: previewVersion,
        digest: expectedDigest,
      })
      .select("id")
      .single();

    if (auditError || !auditRow) {
      // An unauditable deletion is one we do not perform.
      console.error("admin-academy-deletion: could not record the audit entry", auditError);
      return json({ error: "Could not record the deletion audit entry — nothing was deleted." }, 500);
    }

    // (b) confirm — the database stamps `completed` inside its own transaction.
    const { data: result, error: deleteError } = await supabaseAdmin.rpc("academy_delete_confirmed", {
      _academy_id: academyProfileId,
      _expected_digest: expectedDigest,
      _preview_version: previewVersion,
      _audit_id: auditRow.id,
      _actor_user_id: adminUser.id,
    });

    if (deleteError) {
      // (c) failure — stamp the SAME row, in a separate call.
      const code = refusalCodeOf(deleteError.message);
      const reason = `${code ?? "ERROR"}: ${deleteError.message}`.slice(0, 500);

      // ONLY over a row still reading `started`. A lost or failed RESPONSE to a transaction that
      // actually committed arrives here indistinguishable from a refusal — and without this filter
      // the handler would stamp `failed` over the `completed` row the database wrote inside that
      // commit, leaving durable evidence that the deletion did not happen when the academy is gone.
      // The status guard makes the winner the transaction, not the transport.
      const { data: stamped, error: stampErr } = await supabaseAdmin
        .from("academy_deletion_audit")
        .update({ status: "failed", finished_at: new Date().toISOString(), failure_reason: reason })
        .eq("id", auditRow.id)
        .eq("status", "started")
        .select("id");

      if (!stampErr && (stamped?.length ?? 0) === 0) {
        // Nothing was `started` to stamp: the row reached a terminal state without us. Report the
        // outcome as indeterminate rather than asserting either one.
        console.error("admin-academy-deletion: audit row is already terminal, not stamping", auditRow.id);
        await notifySlackEdgeError(
          "admin-academy-deletion",
          "the RPC reported an error but its audit row is already terminal — the transaction may have committed",
          { audit_id: auditRow.id, refusal_code: code ?? "ERROR" },
        ).catch(() => {});
        return json({ error: "Deletion outcome is indeterminate.", code, audit_incomplete: true }, 409);
      }

      if (stampErr) {
        // Never report a clean refusal over a row still reading `started` — that row means "began
        // and did not finish", which is the opposite of what happened.
        console.error("admin-academy-deletion: could not stamp the audit as failed", auditRow.id, stampErr);
        await notifySlackEdgeError(
          "admin-academy-deletion",
          "deletion refused but its audit row is still 'started' — reconcile manually",
          { audit_id: auditRow.id, refusal_code: code ?? "ERROR" },   // ids and codes only, no PII
        ).catch(() => {});
        return json({ error: "Deletion refused.", code, audit_incomplete: true }, 409);
      }

      return json({ error: "Deletion refused.", code, audit_id: auditRow.id }, 409);
    }

    return json({ success: true, audit_id: auditRow.id, result }, 200);
  } catch (error: unknown) {
    console.error("admin-academy-deletion: unhandled", error);
    return json({ error: error instanceof Error ? error.message : "Internal server error" }, 500);
  }
}

// Only start the server when run as the entrypoint — importing the module (for tests) must not bind a port.
if (import.meta.main) Deno.serve((req) => handleRequest(req));
