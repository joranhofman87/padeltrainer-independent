import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface NotifyRequest {
  slot_count: number;
  date_range: string;
  single_slot?: {
    date: string;
    time: string;
  };
  // BJ-08: the cancelled booking id, used as the per-event dedup anchor for a
  // reopened slot so re-opens of a re-booked slot still notify (each cancellation
  // is a distinct event). Optional — falls back to the slot date/time.
  booking_id?: string;
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    
    // Verify authentication
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      console.error("No authorization header provided");
      return new Response(
        JSON.stringify({ error: "Authentication required" }),
        { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Create client to verify user token
    const supabaseAuth = createClient(supabaseUrl, supabaseServiceKey);
    const token = authHeader.replace("Bearer ", "");
    
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(token);
    
    if (authError || !user) {
      console.error("Authentication failed:", authError?.message);
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Create service role client for database operations
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get trainer profile from authenticated user - DO NOT trust trainer_id from request body
    const { data: trainerProfile, error: trainerError } = await supabase
      .from("trainer_profiles")
      .select("id, user_id, business_name")
      .eq("user_id", user.id)
      .single();

    if (trainerError || !trainerProfile) {
      console.error("User is not a trainer:", trainerError?.message);
      return new Response(
        JSON.stringify({ error: "Only trainers can notify followers" }),
        { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const trainer_id = trainerProfile.id;
    const { slot_count, date_range, single_slot, booking_id }: NotifyRequest = await req.json();

    if (!slot_count) {
      return new Response(
        JSON.stringify({ error: "Missing required field: slot_count" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const isReopenedSlot = !!single_slot;

    // Get trainer's name
    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("user_id", trainerProfile.user_id)
      .single();

    // business_name takes precedence (matches the in-app trainer name resolver).
    const trainerName = trainerProfile.business_name?.trim() || profile?.full_name || "Your trainer";

    // Get followers who want notifications
    const { data: followers } = await supabase
      .from("trainer_followers")
      .select(`
        player_id,
        notify_new_availability
      `)
      .eq("trainer_id", trainer_id)
      .eq("notify_new_availability", true);

    if (!followers || followers.length === 0) {
      return new Response(
        JSON.stringify({ message: "No followers to notify", sent: 0 }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Get player info and their notification preferences
    const playerIds = followers.map((f) => f.player_id);
    
    const { data: players } = await supabase
      .from("profiles")
      .select("id, user_id, email, full_name")
      .in("id", playerIds);

    if (!players || players.length === 0) {
      return new Response(
        JSON.stringify({ message: "No players found", sent: 0 }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Check global notification preferences
    const userIds = players.map((p) => p.user_id);
    const { data: preferences } = await supabase
      .from("notification_preferences")
      .select("user_id, email_new_availability")
      .in("user_id", userIds);

    const prefMap = new Map(preferences?.map((p) => [p.user_id, p.email_new_availability]) || []);

    // Filter players who have global notifications enabled (or no preference set = default true)
    const playersToNotify = players.filter((p) => {
      const pref = prefMap.get(p.user_id);
      return pref === undefined || pref === true;
    });

    if (playersToNotify.length === 0) {
      return new Response(
        JSON.stringify({ message: "All followers have disabled notifications", sent: 0 }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Determine email type + a deterministic per-event dedup anchor (BJ-08).
    // new_availability keys on the slot batch's date range; slot_reopened keys on
    // the cancelled booking id (falls back to slot date/time). A re-trigger after
    // an apparent timeout therefore re-uses the same keys and does NOT re-spam.
    const emailType = isReopenedSlot ? "slot_reopened" : "new_availability";
    const eventAnchor = isReopenedSlot
      ? `sr:${booking_id ?? `${single_slot!.date}:${single_slot!.time}`}`
      : `na:${date_range}`;
    const dedupKeyFor = (playerId: string) => `${trainer_id}:${playerId}:${eventAnchor}`;

    const recipients = playersToNotify.filter((p) => p.email);

    let sentCount = 0;
    let remaining = 0;
    const errors: string[] = [];

    // Bounded-concurrency batches with a per-chunk dedup claim and a wall-clock
    // budget: a large follower set can't blow the edge timeout (serial → ~15x
    // faster) and can't re-spam (claim-before-send). Un-processed chunks (budget
    // hit) stay UN-claimed so a re-invoke continues them; a failed send releases
    // its claim so it retries instead of being silently suppressed.
    // 10 concurrent sends per chunk — a ~10x speedup over the old serial loop
    // while staying near the email provider's rate ceiling. A 429 (or any send
    // error) releases that claim, so it simply retries on the next run.
    const CHUNK_SIZE = 10;
    const TIME_BUDGET_MS = 110_000;
    const start = Date.now();

    for (let i = 0; i < recipients.length; i += CHUNK_SIZE) {
      if (Date.now() - start > TIME_BUDGET_MS) {
        remaining = recipients.length - i;
        break;
      }
      const chunk = recipients.slice(i, i + CHUNK_SIZE);

      // Claim this chunk: INSERT ... ON CONFLICT DO NOTHING returns only rows we
      // actually inserted → exactly the players not yet notified for this event.
      const { data: claimed } = await supabase
        .from("notification_sends")
        .upsert(
          chunk.map((p) => ({ dedup_key: dedupKeyFor(p.id) })),
          { onConflict: "dedup_key", ignoreDuplicates: true },
        )
        .select("dedup_key");
      const claimedKeys = new Set((claimed ?? []).map((r) => r.dedup_key));
      const toSend = chunk.filter((p) => claimedKeys.has(dedupKeyFor(p.id)));

      const results = await Promise.all(
        toSend.map(async (player) => {
          try {
            const emailRes = await fetch(`${supabaseUrl}/functions/v1/send-email`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${supabaseServiceKey}`,
              },
              body: JSON.stringify({
                type: emailType,
                to: player.email,
                data: {
                  playerName: player.full_name || "Player",
                  trainerName,
                  slotCount: slot_count,
                  dateRange: date_range,
                  ...(single_slot && {
                    slotDate: single_slot.date,
                    slotTime: single_slot.time,
                  }),
                },
              }),
            });
            if (emailRes.ok) return { ok: true as const };
            const errText = await emailRes.text();
            return { ok: false as const, key: dedupKeyFor(player.id), err: `Failed to email ${player.email}: ${errText}` };
          } catch (err) {
            return { ok: false as const, key: dedupKeyFor(player.id), err: `Error emailing ${player.email}: ${(err as Error).message}` };
          }
        }),
      );

      const failedKeys: string[] = [];
      for (const r of results) {
        if (r.ok) sentCount++;
        else {
          failedKeys.push(r.key);
          errors.push(r.err);
        }
      }
      // Release failed claims so they retry next run (never suppress a
      // notification that didn't actually go out).
      if (failedKeys.length > 0) {
        await supabase.from("notification_sends").delete().in("dedup_key", failedKeys);
      }
    }

    console.log(
      `Notified ${sentCount} followers about ${isReopenedSlot ? "reopened slot" : "new availability"}` +
        (remaining ? ` (${remaining} deferred — time budget)` : ""),
    );
    if (errors.length > 0) {
      console.error("Email errors:", errors);
    }

    return new Response(
      JSON.stringify({
        message: `Notified ${sentCount} followers`,
        sent: sentCount,
        remaining,
        type: isReopenedSlot ? "reopened_slot" : "new_availability",
        errors: errors.length > 0 ? errors : undefined,
      }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  } catch (error: any) {
    console.error("Error in notify-followers function:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
};

serve(handler);
