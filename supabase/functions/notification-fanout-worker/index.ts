// PR 10b: drains the durable open_slots_player fan-out jobs.
//
// Each call processes bounded pages via process_notification_fanout until either there is no
// claimable work or a per-invocation page budget is hit (so one run cannot exceed the edge
// timeout). Because every page is leased + cursor-resumable and the enqueues are idempotent,
// stopping early is always safe: the next cron tick — or a concurrent worker — resumes exactly
// where this left off, and re-processing a page creates no duplicate outbox rows.
//
// Per-recipient DELIVERY is NOT done here — this only enqueues into the outbox. The
// notification-email-worker sends and records delivery. This worker's sole job is turning a
// job + its followers into outbox rows, durably.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireServiceRole } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// A single worker id per invocation, so leases in the job table are attributable.
const workerId = () => `fanout-worker-${Date.now()}`;

// Bounded so one cron run cannot run away: at most this many pages per invocation. A page is
// up to 200 followers; the cron fires often enough that a very large backlog simply drains
// across several ticks rather than in one long request.
const MAX_PAGES_PER_RUN = 25;

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const denied = requireServiceRole(req);   // Response on failure, null on success
  if (denied) return denied;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const worker = workerId();

  let pages = 0;
  let enqueued = 0;
  let skipped = 0;
  let noIdentity = 0;
  const errors: string[] = [];

  for (let i = 0; i < MAX_PAGES_PER_RUN; i++) {
    const { data, error } = await supabase.rpc("process_notification_fanout", {
      p_worker: worker,
      p_max_followers: 200,
    });
    if (error) {
      errors.push(error.message);
      break;
    }
    const r = (data ?? {}) as {
      claimed?: boolean; done?: boolean; enqueued?: number; skipped?: number; no_identity?: number;
    };
    if (!r.claimed) break;   // no claimable work left this run
    pages++;
    enqueued += r.enqueued ?? 0;
    skipped += r.skipped ?? 0;
    noIdentity += r.no_identity ?? 0;
    // A `done:false` page leaves the SAME job pending; the next loop re-claims it and
    // continues from the cursor. `done:true` frees the loop to pick up the next job.
  }

  return new Response(
    JSON.stringify({ pages, enqueued, skipped, no_identity: noIdentity, errors: errors.length ? errors : undefined }),
    { status: errors.length ? 500 : 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
  );
};

serve(handler);
