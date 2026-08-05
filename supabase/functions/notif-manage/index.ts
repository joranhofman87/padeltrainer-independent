// N2 S5 — the manage page's API: context (what does this link manage?) and apply (the human
// pressed the button). POST JSON { op: "context" | "apply", token }.
//
// verify_jwt = false (config.toml): the page is PUBLIC — a marketing recipient may have no
// account — and the SIGNED TOKEN is the auth. All decisions live in _shared/notif-manage-core.ts
// under Deno tests; this module is a thin unimportable adapter.
//
// CORS is open deliberately: the page runs on padeltrainer.ai, this function on *.supabase.co,
// and the token in the body is the only credential — there is no cookie or ambient auth for a
// cross-site request to ride on.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import {
  handleManageApply,
  handleManageContext,
  type ManageContextRow,
  type ManageEndpointDeps,
} from "../_shared/notif-manage-core.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function buildDeps(): ManageEndpointDeps {
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
  return {
    loadKeyState: async () => {
      const { data, error } = await supabase
        .from("notification_manage_key_state")
        .select("current_version, min_mintable_version")
        .maybeSingle();
      if (error || !data) return null;
      return { currentVersion: data.current_version, minMintableVersion: data.min_mintable_version };
    },
    getContext: async (capabilityId) => {
      const { data, error } = await supabase.rpc("get_notification_manage_context", {
        p_capability_id: capabilityId,
      });
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      return (row as ManageContextRow | undefined) ?? null;
    },
    applyAction: async (capabilityId, source) => {
      const { data, error } = await supabase.rpc("apply_notification_manage_action", {
        p_capability_id: capabilityId,
        p_action: "marketing_unsubscribe",
        p_source: source,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  let op: unknown, token: unknown;
  try {
    const body = await req.json();
    op = body.op;
    token = body.token;
  } catch {
    return new Response(JSON.stringify({ error: "invalid_body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const tokenStr = typeof token === "string" ? token : null;
  const deps = buildDeps();
  const result =
    op === "context"
      ? await handleManageContext(deps, tokenStr)
      : op === "apply"
        ? await handleManageApply(deps, tokenStr)
        : { status: 400, body: { error: "unknown_op" } };

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
});
