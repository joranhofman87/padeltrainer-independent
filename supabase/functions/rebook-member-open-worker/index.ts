// D7 — the `rebook_member_open_player` TRANSPORT DISPATCHER (cron-driven, INERT until enabled).
//
// A thin wrapper and nothing else: auth, the activation flag, config gating and the status matrix
// live in `_shared/rebook-member-open-worker-entry.ts`; the claim -> resolve -> begin -> send ->
// record loop lives in `_shared/rebook-member-open-worker-core.ts`. Every atomicity, ownership,
// classification, retry and decision policy lives in the DATABASE. This file injects Deno's
// environment, the service-role guard, a Slack alert, a supabase-js-backed `rpc` and the single
// observed provider call — and holds no policy of its own.
//
// INERT BY DEFAULT. `REBOOK_MEMBER_OPEN_SEND_ENABLED` is absent, so every invocation returns
// 200 {"status":"disabled"} having made ZERO database calls. Setting it is a separate owner gate,
// performed after the schedules are armed and one controlled canary has been reconciled.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { requireServiceRole } from "../_shared/auth.ts";
import { notifySlackEdge } from "../_shared/edge-slack.ts";
import { observeSingleSend } from "../_shared/rebook-member-open-observed-send.ts";
import {
  REBOOK_MEMBER_OPEN_WORKER_LIMITS,
  runRebookMemberOpenWorker,
} from "../_shared/rebook-member-open-worker-core.ts";
import { makeRebookMemberOpenWorkerEntry } from "../_shared/rebook-member-open-worker-entry.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const entry = makeRebookMemberOpenWorkerEntry({
  env: (k) => Deno.env.get(k),
  requireServiceRole,
  log: (event) => console.log(JSON.stringify(event)),
  alert: (payload) => notifySlackEdge("rebook_member_open_worker_alert", payload),
  corsHeaders,
  run: ({ resendApiKey, supabaseUrl, serviceKey }) => {
    const supabase = createClient(supabaseUrl, serviceKey);
    return runRebookMemberOpenWorker({
      limits: REBOOK_MEMBER_OPEN_WORKER_LIMITS,
      rpc: async (name, args) => {
        const { data, error } = await supabase.rpc(name, args);
        // NO ARGS AND NO DATA IN THE MESSAGE. A PostgREST error can echo a parameter value, and
        // these parameters carry outbox ids, worker tokens and the frozen request hash.
        if (error) throw new Error(`${name} rpc failed`);
        return data;
      },
      sendOnce: (frozen) => observeSingleSend(resendApiKey, frozen),
      // `performance.now()` and not `Date.now()`: the budget must be immune to a wall-clock step.
      monotonicNowMs: () => performance.now(),
      newToken: () => `rebook-member-open-worker:${crypto.randomUUID()}`,
      log: (event) => console.log(JSON.stringify(event)),
    });
  },
});

serve(entry);
