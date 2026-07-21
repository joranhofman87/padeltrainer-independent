import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// PR 10b: notify-followers is now a THIN producer. It used to compose emails, read a
// nonexistent v1 preference column (email_new_availability, error discarded → opt-out inert),
// and fan out to every follower inside this one request with a claim-before-send table that
// stranded recipients on a crash. All of that moved server-side:
//
//   * the client sends the CANONICAL inserted slot ids — nothing else. No count, no date
//     range, no trainer name, no recipient, no HTML.
//   * create_open_slots_fanout validates the caller owns every slot and each is public, then
//     records a durable job.
//   * process_notification_fanout (driven by the notification-fanout-worker cron) drains the
//     job in bounded, resumable pages, letting enqueue_notification + the outbox worker own
//     per-recipient delivery, digest cadence and idempotency.
//
// This function's only job is: authenticate the trainer, hand the slot ids to the RPC (which
// re-derives everything and re-checks ownership under its own privileges), and kick one drain
// so a small follower set is delivered promptly without waiting for the cron.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface NotifyRequest {
  slot_ids: string[];
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Authentication required" }),
        { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    // Authenticate the caller. create_open_slots_fanout runs as the authenticated actor
    // (auth.uid()), so it must be called with the USER's token, not the service key — the
    // ownership check depends on knowing who is asking.
    const supabaseUser = createClient(supabaseUrl, serviceKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await supabaseUser.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    const { slot_ids }: NotifyRequest = await req.json();
    if (!Array.isArray(slot_ids) || slot_ids.length === 0) {
      return new Response(JSON.stringify({ error: "Missing slot_ids" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    // Create the durable job AS THE TRAINER. The RPC validates ownership + public and derives
    // everything else; a foreign/private slot raises, which we surface as a 403.
    const { data: jobId, error: jobError } = await supabaseUser.rpc("create_open_slots_fanout", {
      p_slot_ids: slot_ids,
    });
    if (jobError) {
      console.error("create_open_slots_fanout failed:", jobError.message);
      const status = /not a trainer|not owned|not public|multiple academy scopes/.test(jobError.message) ? 403 : 500;
      return new Response(JSON.stringify({ error: jobError.message }),
        { status, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    // Kick ONE drain page for latency on small follower sets. The cron guarantees completion
    // for large ones; failing to kick here is non-fatal (the job is durable and will be
    // drained on the next cron tick regardless).
    const supabaseService = createClient(supabaseUrl, serviceKey);
    let drained: unknown = null;
    try {
      // Inspect the returned error too — rpc RESOLVES { error } for a DB-level failure. The
      // kick is non-fatal (the job is durable and the cron resumes it), but a failing kick
      // should be visible, not swallowed.
      const { data, error: drainError } = await supabaseService.rpc("process_notification_fanout", {
        p_worker: "notify-followers-kick",
        p_max_followers: 200,
      });
      if (drainError) {
        console.error("kick drain error (non-fatal, cron will resume):", drainError.message);
      }
      drained = data;
    } catch (e) {
      console.error("kick drain threw (non-fatal, cron will resume):", (e as Error).message);
    }

    return new Response(JSON.stringify({ job_id: jobId, drained }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } });
  } catch (error) {
    console.error("Error in notify-followers:", (error as Error).message);
    return new Response(JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
  }
};

serve(handler);
