// D7 — the transport JANITOR (cron-driven). Lease recovery and unresolved-row closure.
//
// A thin wrapper: the two-step run and the status matrix live in
// `_shared/rebook-member-open-janitor-core.ts`.
//
// IT IS SEPARATE FROM THE DISPATCHER ON PURPOSE — a wedged dispatcher must not be able to block
// the path that un-wedges it — and it is deliberately NOT behind the send flag: it performs no
// provider call, and an inert janitor turns a stale lease into a permanent wedge.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { requireServiceRole } from "../_shared/auth.ts";
import { notifySlackEdge } from "../_shared/edge-slack.ts";
import {
  makeRebookMemberOpenJanitorEntry,
  REBOOK_MEMBER_OPEN_JANITOR_LIMITS,
  runRebookMemberOpenJanitor,
} from "../_shared/rebook-member-open-janitor-core.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/** Matches the dispatcher's per-RPC ceiling; both janitor RPCs are bounded batch operations. */
const RPC_TIMEOUT_MS = 10_000;

const entry = makeRebookMemberOpenJanitorEntry({
  env: (k) => Deno.env.get(k),
  requireServiceRole,
  log: (event) => console.log(JSON.stringify(event)),
  alert: (payload) => notifySlackEdge("rebook_member_open_janitor_alert", payload),
  corsHeaders,
  run: ({ supabaseUrl, serviceKey }) => {
    const supabase = createClient(supabaseUrl, serviceKey);
    return runRebookMemberOpenJanitor({
      limits: REBOOK_MEMBER_OPEN_JANITOR_LIMITS,
      rpcTimeoutMs: RPC_TIMEOUT_MS,
      rpc: async (name, args) => {
        const { data, error } = await supabase.rpc(name, args);
        if (error) throw new Error(`${name} rpc failed`);
        return data;
      },
      log: (event) => console.log(JSON.stringify(event)),
    });
  },
});

serve(entry);
