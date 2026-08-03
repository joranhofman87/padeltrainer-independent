// 10c-b D — open-slot follower alerts, CUT OVER to the v2 notification pipeline.
//
// This route used to POST send-email once per follower and dedup through its own
// `notification_sends` table. It now calls enqueue_notification('open_slots_player', ...) once
// per follower and lets the v2 resolver own preference, consent, suppression, contact
// resolution and idempotency. The policy rules live in _shared/open-slots-notify.ts so the
// suite exercises production code (this module ends in `serve(handler)` and cannot be imported).
//
// WHAT CHANGED THAT A READER MUST NOT MISS:
//   * There is no "sent" count any more, and the response no longer claims one. This route
//     ENQUEUES. Whether mail goes out is the worker's business, and while the digest engine is
//     disabled a daily/weekly follower is deliberately recorded `skipped`/`digest_engine_disabled`
//     rather than downgraded to an instant email.
//   * Dedup is the resolver's idempotency key (`<event>:<subject>:<recipient>`), so a retry or
//     two concurrent invocations collapse to ONE logical row per follower. The old
//     notification_sends claim/release is GONE — running both would be a dual-write with two
//     different notions of "already handled", and could produce a legacy send beside a v2 row.
//   * The old per-follower filter read notification_preferences.email_new_availability — a
//     column dropped in 20260210090026, whose error was discarded, so that filter had been
//     silently inert. Preference is now enforced inside enqueue_notification against
//     notification_preferences_v2, which slice C backfilled from the legacy open_slots_digest.
//   * Dates arrive as validated ISO fields, never display text.
//
// Trainer identity is still taken from the authenticated user's trainer_profiles row and is
// never read from the request body.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  classifyEnqueue,
  digestPayload,
  eventSubject,
  newCounts,
  parseNotifyRequest,
  tally,
} from "../_shared/open-slots-notify.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      console.error("No authorization header provided");
      return json({ error: "Authentication required" }, 401);
    }

    const supabaseAuth = createClient(supabaseUrl, supabaseServiceKey);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(token);
    if (authError || !user) {
      console.error("Authentication failed:", authError?.message);
      return json({ error: "Unauthorized" }, 401);
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Trainer identity comes from the AUTHENTICATED user, never from request data.
    const { data: trainerProfile, error: trainerError } = await supabase
      .from("trainer_profiles")
      .select("id, user_id, business_name")
      .eq("user_id", user.id)
      .single();

    if (trainerError || !trainerProfile) {
      console.error("User is not a trainer:", trainerError?.message);
      return json({ error: "Only trainers can notify followers" }, 403);
    }
    const trainerId = trainerProfile.id;

    const parsed = parseNotifyRequest(await req.json().catch(() => null));
    if (!parsed.ok) {
      return json({ error: parsed.error }, 400);
    }
    const notify = parsed.req;

    // business_name takes precedence (matches the in-app trainer name resolver).
    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("user_id", trainerProfile.user_id)
      .single();
    const trainerName = trainerProfile.business_name?.trim() || profile?.full_name || "Your trainer";

    // Followers who still want new-availability alerts. This flag is re-checked live before
    // prepare and before every send attempt by the §PS event hook, so unfollowing between
    // enqueue and delivery still stops the notification.
    const { data: followers, error: followersError } = await supabase
      .from("trainer_followers")
      .select("player_id, notify_new_availability")
      .eq("trainer_id", trainerId)
      .eq("notify_new_availability", true);

    // A failed READ must not read as "nobody to notify". Returning 200/zero here would make a
    // database outage indistinguishable from a trainer with no followers.
    if (followersError) {
      console.error("Follower lookup failed:", followersError.message);
      return json({ error: "follower_lookup_failed" }, 500);
    }

    if (!followers || followers.length === 0) {
      return json({ message: "No followers to notify", ...newCounts() }, 200);
    }

    // enqueue_notification is user_id-keyed; trainer_followers.player_id is profiles.id.
    const { data: players, error: playersError } = await supabase
      .from("profiles")
      .select("id, user_id")
      .in("id", followers.map((f) => f.player_id));

    if (playersError) {
      console.error("Follower profile lookup failed:", playersError.message);
      return json({ error: "profile_lookup_failed" }, 500);
    }

    const recipients = (players ?? []).filter((p) => p.user_id);
    if (recipients.length === 0) {
      return json({ message: "No followers with an account", ...newCounts() }, 200);
    }

    const subject = eventSubject(notify, trainerId);
    const payload = digestPayload(notify, trainerName);
    const counts = newCounts();
    const errors: string[] = [];

    // Bounded processing: a large follower set must not blow the edge timeout. Un-processed
    // recipients are reported as `deferred` and a re-invoke continues them — safely, because
    // the resolver's idempotency key makes an already-enqueued recipient a no-op rather than a
    // duplicate.
    const CHUNK_SIZE = 10;
    const TIME_BUDGET_MS = 110_000;
    const start = Date.now();

    for (let i = 0; i < recipients.length; i += CHUNK_SIZE) {
      if (Date.now() - start > TIME_BUDGET_MS) {
        counts.deferred = recipients.length - i;
        break;
      }
      const chunk = recipients.slice(i, i + CHUNK_SIZE);

      const results = await Promise.all(chunk.map(async (player) => {
        const { data, error } = await supabase.rpc("enqueue_notification", {
          p_event_key: "open_slots_player",
          p_recipient_user_id: player.user_id,
          p_tenant_trainer_id: trainerId,
          p_idempotency_subject: subject,
          p_payload: payload,
        });
        if (error) return { outcome: "failed" as const, err: `enqueue failed for follower: ${error.message}` };
        return { outcome: classifyEnqueue(data as Array<{ status?: string | null }>) };
      }));

      for (const r of results) {
        tally(counts, r.outcome);
        if (r.err) errors.push(r.err);
      }
    }

    console.log(
      `open_slots_player ${notify.subtype}: enqueued=${counts.enqueued} skipped=${counts.skipped} ` +
      `no_row=${counts.no_row} failed=${counts.failed} deferred=${counts.deferred}`,
    );
    if (errors.length > 0) console.error("Enqueue errors:", errors);

    // Truthful reporting: these are ENQUEUE outcomes, not deliveries.
    //
    // An INCOMPLETE run must not return 200. Nothing re-invokes this function on a schedule and
    // the sole caller ignores the body, so a deferred or failed recipient is LOST unless the
    // caller can see the run was incomplete. A non-2xx is the only signal it can act on.
    const incomplete = counts.failed > 0 || counts.deferred > 0;
    return json({
      message: `Enqueued ${counts.enqueued} follower notification(s)`,
      subtype: notify.subtype,
      incomplete,
      ...counts,
      errors: errors.length > 0 ? errors : undefined,
    }, incomplete ? 500 : 200);
  } catch (error: unknown) {
    console.error("Error in notify-followers function:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return json({ error: message }, 500);
  }
};

serve(handler);
