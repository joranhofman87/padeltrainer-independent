import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { corsHeaders, requireUser, jsonForbidden } from "../_shared/auth.ts";

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[BULK-REBOOK-CYCLE] ${step}`, details ? JSON.stringify(details) : "");
};

/**
 * Bulk cohort rebooking, keyed on LOCATION + TERM-END week (not cyclus_id).
 *
 * The cohort spans registration-module sessions AND hand-added agenda sessions,
 * so cyclus_id is an unreliable key (the X-ray found 12/81 players reachable
 * only via hand-added slots). This gathers the academy's slots at the chosen
 * location(s), clusters them into weekly SERIES by (location, trainer, weekday,
 * time), keeps the series whose term ends in the chosen week, copies each
 * series forward into one fresh target cycle, and creates GROUP-LEVEL priority
 * claims (shared rebook_group_id per series) so each player gets ONE invite per
 * group and one "Yes" rebooks the whole next term (see the group-aware
 * respond_to_priority_claim RPC).
 */

type Slot = {
  id: string;
  trainer_id: string | null;
  location_id: string | null;
  academy_profile_id: string | null;
  start_time: string;
  end_time: string;
  court_type: string | null;
  training_level: string | null;
  price_per_session: number | null;
  total_price: number | null;
  allow_single_booking: boolean | null;
  min_participants: number | null;
  max_participants: number | null;
  extra_costs: unknown;
  rating_system: string | null;
  min_rating: number | null;
  max_rating: number | null;
  prices_include_vat: boolean | null;
  split_payment: boolean | null;
  cyclus_id: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function shiftWeeks(iso: string, weeks: number): string {
  return new Date(new Date(iso).getTime() + weeks * 7 * DAY_MS).toISOString();
}

// Series key — clusters weekly recurrences of the same group. UTC weekday+time
// is stable within a term (a DST change mid-term could split a series; minor).
function seriesKey(s: Slot): string {
  const d = new Date(s.start_time);
  const hhmm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return `${s.location_id ?? "_"}|${s.trainer_id ?? "_"}|${d.getUTCDay()}|${hhmm}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const supabase = auth.supabase;

  try {
    const body = await req.json().catch(() => ({}));
    const academyProfileId: string = body?.academyProfileId;
    const locationIds: string[] = Array.isArray(body?.locationIds) ? body.locationIds : [];
    const termEndDate: string = body?.termEndDate; // yyyy-mm-dd
    const newStartDate: string = body?.newStartDate; // yyyy-mm-dd
    const priorityWindowDays: number = Number(body?.priorityWindowDays ?? 7);
    const memberWindowDays: number = Number(body?.memberWindowDays ?? 0);
    const paymentMode: string = body?.paymentMode === "upfront" ? "upfront" : "deferred_split";
    const requireAdminReview: boolean = body?.requireAdminReview === true;
    const targetCycleName: string | null = body?.targetCycleName ?? null;
    const dryRun: boolean = body?.dryRun === true;

    if (!academyProfileId || locationIds.length === 0 || !termEndDate || !newStartDate) {
      return new Response(JSON.stringify({ error: "academyProfileId, locationIds, termEndDate, newStartDate required" }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Authorization: caller must manage this academy (or be service-role).
    if (!auth.isServiceRole) {
      const { data: mgr } = await supabase
        .from("academy_managers")
        .select("user_id")
        .eq("academy_profile_id", academyProfileId)
        .eq("user_id", auth.user.id)
        .maybeSingle();
      if (!mgr) return jsonForbidden("You do not manage this academy.");
    }

    // 1. Gather candidate slots at the chosen location(s), up to the term end.
    const termEnd = new Date(`${termEndDate}T23:59:59.999Z`);
    const windowStart = new Date(termEnd.getTime() - 200 * DAY_MS); // generous term lookback
    const { data: slots, error: slotsErr } = await supabase
      .from("availability_slots")
      .select("id, trainer_id, location_id, academy_profile_id, start_time, end_time, court_type, training_level, price_per_session, total_price, allow_single_booking, min_participants, max_participants, extra_costs, rating_system, min_rating, max_rating, prices_include_vat, split_payment, cyclus_id")
      .eq("academy_profile_id", academyProfileId)
      .in("location_id", locationIds)
      .gte("start_time", windowStart.toISOString())
      .lte("start_time", termEnd.toISOString());
    if (slotsErr) throw slotsErr;

    // 2. Cluster into series; keep those whose LAST session is in the term-end week.
    const termEndWeekStart = termEnd.getTime() - 6 * DAY_MS;
    const bySeries = new Map<string, Slot[]>();
    for (const s of (slots ?? []) as Slot[]) {
      const arr = bySeries.get(seriesKey(s)) ?? [];
      arr.push(s);
      bySeries.set(seriesKey(s), arr);
    }
    const qualifyingSeries: Slot[][] = [];
    for (const arr of bySeries.values()) {
      const lastMs = Math.max(...arr.map((s) => new Date(s.start_time).getTime()));
      if (lastMs >= termEndWeekStart && lastMs <= termEnd.getTime()) {
        qualifyingSeries.push(arr.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()));
      }
    }

    const allQualifyingSlotIds = qualifyingSeries.flat().map((s) => s.id);
    if (allQualifyingSlotIds.length === 0) {
      return new Response(JSON.stringify({ ok: true, dryRun, groups: 0, players: 0, slotsCopied: 0, claimsCreated: 0, invitesSent: 0, message: "No series found ending in that week at those locations." }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // 3. Bookings on the qualifying source slots → cohort membership.
    const bookingsBySlot = new Map<string, { player_id: string | null; guest_player_id: string | null }[]>();
    const playerSet = new Set<string>();
    for (let i = 0; i < allQualifyingSlotIds.length; i += 200) {
      const batch = allQualifyingSlotIds.slice(i, i + 200);
      const { data: bks } = await supabase
        .from("bookings")
        .select("slot_id, player_id, guest_player_id, status")
        .in("slot_id", batch);
      for (const b of bks ?? []) {
        if (["cancelled", "cancelled_swap"].includes(String(b.status ?? "confirmed"))) continue;
        if (!b.player_id && !b.guest_player_id) continue;
        const arr = bookingsBySlot.get(b.slot_id) ?? [];
        arr.push({ player_id: b.player_id, guest_player_id: b.guest_player_id });
        bookingsBySlot.set(b.slot_id, arr);
        playerSet.add(b.player_id ?? `g:${b.guest_player_id}`);
      }
    }

    const earliestSrcMs = Math.min(...qualifyingSeries.flat().map((s) => new Date(s.start_time).getTime()));
    const newStartMs = new Date(`${newStartDate}T00:00:00.000Z`).getTime();
    const weeksOffset = Math.round((newStartMs - new Date(new Date(earliestSrcMs).toISOString().slice(0, 10) + "T00:00:00.000Z").getTime()) / (7 * DAY_MS));

    if (dryRun) {
      return new Response(JSON.stringify({
        ok: true, dryRun: true,
        groups: qualifyingSeries.length,
        players: playerSet.size,
        weeksOffset,
        slotsToCopy: qualifyingSeries.flat().length,
      }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    // 4. Create one target cycle for the run.
    const repTemplate = qualifyingSeries[0][0];
    const termLenDays = Math.round((termEnd.getTime() - earliestSrcMs) / DAY_MS);
    const newEndDate = new Date(newStartMs + termLenDays * DAY_MS).toISOString().slice(0, 10);
    const singleLocation = locationIds.length === 1 ? locationIds[0] : null;
    const { data: targetCycle, error: tcErr } = await supabase
      .from("cycles")
      .insert({
        owner_type: "academy",
        owner_id: academyProfileId,
        name: targetCycleName || "Volgende ronde",
        start_date: newStartDate,
        end_date: newEndDate,
        type: "cyclus",
        status: "open",
        location_id: singleLocation,
        price_per_session: repTemplate.price_per_session,
        settings: { rebook_payment_mode: paymentMode },
      })
      .select("id, name")
      .single();
    if (tcErr) throw tcErr;

    const now = new Date();
    const priorityEnd = new Date(now.getTime() + priorityWindowDays * DAY_MS);
    const memberEnd = memberWindowDays > 0 ? new Date(priorityEnd.getTime() + memberWindowDays * DAY_MS) : null;
    const publicReleaseStatus = requireAdminReview ? "pending_admin_review" : "auto_release_scheduled";

    let slotsCopied = 0;
    let claimsCreated = 0;
    const representativeClaimIds: string[] = [];

    // 5. Copy each series forward; create grouped claims (one rebook_group_id per series).
    for (const series of qualifyingSeries) {
      const rebookGroupId = crypto.randomUUID();
      // player key -> earliest copied claim id (the representative we email)
      const repByPlayer = new Map<string, string>();

      for (const src of series) {
        const { data: newSlot, error: insErr } = await supabase
          .from("availability_slots")
          .insert({
            trainer_id: src.trainer_id,
            start_time: shiftWeeks(src.start_time, weeksOffset),
            end_time: shiftWeeks(src.end_time, weeksOffset),
            is_recurring: false,
            cyclus_id: targetCycle.id,
            cyclus_name: targetCycle.name,
            court_type: src.court_type,
            location_id: src.location_id,
            academy_profile_id: src.academy_profile_id,
            is_public: true,
            training_level: src.training_level,
            price_per_session: src.price_per_session,
            total_price: src.total_price,
            allow_single_booking: src.allow_single_booking,
            min_participants: src.min_participants,
            max_participants: src.max_participants,
            extra_costs: src.extra_costs,
            rating_system: src.rating_system,
            min_rating: src.min_rating,
            max_rating: src.max_rating,
            prices_include_vat: src.prices_include_vat,
            split_payment: src.split_payment,
            priority_source_slot_id: src.id,
            priority_window_starts_at: now.toISOString(),
            priority_window_ends_at: priorityEnd.toISOString(),
            source_cycle_id: src.cyclus_id, // best-effort cohort link for membership reads
            member_window_starts_at: memberEnd ? priorityEnd.toISOString() : null,
            member_window_ends_at: memberEnd ? memberEnd.toISOString() : null,
            public_release_status: publicReleaseStatus,
          })
          .select("id")
          .single();
        if (insErr) throw insErr;
        slotsCopied++;

        for (const b of bookingsBySlot.get(src.id) ?? []) {
          const { data: claim, error: cErr } = await supabase
            .from("slot_priority_claims")
            .insert({
              slot_id: newSlot.id,
              player_id: b.player_id,
              guest_player_id: b.guest_player_id,
              source_slot_id: src.id,
              rebook_group_id: rebookGroupId,
              status: "pending",
            })
            .select("id")
            .single();
          if (cErr) continue; // dup (slot,player) guard — skip
          claimsCreated++;
          const pkey = b.player_id ?? `g:${b.guest_player_id}`;
          if (!repByPlayer.has(pkey)) repByPlayer.set(pkey, claim.id); // earliest week = representative
        }
      }
      representativeClaimIds.push(...repByPlayer.values());
    }

    // 6. One invite per (player, series): email only the representative claims.
    let invitesSent = 0;
    for (let i = 0; i < representativeClaimIds.length; i += 50) {
      const batch = representativeClaimIds.slice(i, i + 50);
      const { data, error } = await supabase.functions.invoke("send-priority-claim-invitation", {
        body: { claimIds: batch },
      });
      if (!error && data) invitesSent += batch.length;
    }

    logStep("done", { targetCycle: targetCycle.id, groups: qualifyingSeries.length, players: playerSet.size, slotsCopied, claimsCreated, invitesSent });
    return new Response(JSON.stringify({
      ok: true,
      targetCycleId: targetCycle.id,
      groups: qualifyingSeries.length,
      players: playerSet.size,
      slotsCopied,
      claimsCreated,
      invitesSent,
    }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    return new Response(JSON.stringify({ error: message }), {
      status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
