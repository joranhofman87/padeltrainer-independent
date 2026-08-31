// D7 — the ROUND MATERIALIZER (cron-driven). One bounded call to `rebook_round_materialize`.
//
// A thin wrapper: the bounds, the verbatim result mapping and the status matrix live in
// `_shared/rebook-round-materializer-core.ts`.
//
// IT IS SEPARATE FROM THE DISPATCHER so a materialization failure cannot block dispatch or vice
// versa, and it is deliberately NOT behind the send flag: it writes outbox rows and performs no
// provider call, so with dispatch disabled those rows sit unsent in the outbox — which is the state a
// controlled activation wants to inspect before anything is sent.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { requireServiceRole } from "../_shared/auth.ts";
import { notifySlackEdge } from "../_shared/edge-slack.ts";
import {
  makeRebookRoundMaterializerEntry,
  MATERIALIZER_MAX_RECIPIENTS,
  MATERIALIZER_MAX_ROUNDS,
  runRebookRoundMaterializer,
} from "../_shared/rebook-round-materializer-core.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/** One materialize page freezes a round and writes up to 500 decisions; it gets a wider ceiling
 *  than the dispatcher's per-row RPCs, while staying well inside the platform wall clock. */
const RPC_TIMEOUT_MS = 60_000;

const entry = makeRebookRoundMaterializerEntry({
  env: (k) => Deno.env.get(k),
  requireServiceRole,
  log: (event) => console.log(JSON.stringify(event)),
  alert: (payload) => notifySlackEdge("rebook_round_materializer_alert", payload),
  corsHeaders,
  run: ({ supabaseUrl, serviceKey }) => {
    const supabase = createClient(supabaseUrl, serviceKey);
    return runRebookRoundMaterializer({
      rpcTimeoutMs: RPC_TIMEOUT_MS,
      maxRounds: MATERIALIZER_MAX_ROUNDS,
      maxRecipients: MATERIALIZER_MAX_RECIPIENTS,
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
