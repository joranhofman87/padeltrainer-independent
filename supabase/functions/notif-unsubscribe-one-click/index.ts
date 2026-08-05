// N2 S5 — the RFC 8058 one-click unsubscribe target. Mailbox providers POST here (body
// `List-Unsubscribe=One-Click`) when a recipient presses their client's native Unsubscribe.
//
// verify_jwt = false (config.toml): a mailbox provider cannot carry a Supabase JWT; the SIGNED
// TOKEN is the auth. Every decision — grammar, signature, live key window, row liveness — lives
// in _shared (manage-token.ts + notif-manage-core.ts) under Deno tests; this module ends in
// Deno.serve and is deliberately unimportable, so it contains nothing worth testing.
//
// THE ONE RULE THAT MATTERS HERE: an operational failure is 503, never 2xx. RFC 8058 senders do
// not retry a success, so a 200 produced by an outage is a silently lost opt-out.
//
// GET never unsubscribes — mailbox scanners prefetch List-Unsubscribe URLs with GET; acting on
// that would mass-unsubscribe people who clicked nothing. GET redirects to the manage page.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import {
  handleOneClickPost,
  oneClickGetRedirect,
  type ManageContextRow,
  type ManageEndpointDeps,
} from "../_shared/notif-manage-core.ts";

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
      // Unreadable and absent BOTH yield null → the core answers 503 (operational, retryable).
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
  const url = new URL(req.url);
  const token = url.searchParams.get("token");

  if (req.method === "GET") {
    const r = oneClickGetRedirect(token);
    return new Response(null, { status: r.status, headers: { Location: r.location } });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const result = await handleOneClickPost(buildDeps(), token);
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { "Content-Type": "application/json" },
  });
});
