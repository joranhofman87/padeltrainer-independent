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

type Holiday = { from: string; to: string; name?: string }; // from/to = yyyy-mm-dd inclusive
// (slots are now GENERATED for the next term, not copied 1:1 from source weeks)

// The UTC instant whose LOCAL wall-clock time (in tz) is y-mo-d h:mi. Uses the
// standard offset trick (correct except inside the ~1h DST-transition window).
function localWallTimeToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, mo, d, h, mi, 0);
  const asUtc = new Date(new Date(guess).toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  const asTz = new Date(new Date(guess).toLocaleString("en-US", { timeZone: tz })).getTime();
  return new Date(guess + (asUtc - asTz));
}

/**
 * Generate up to `weeks` weekly session start times for the next term, anchored
 * on the source group's weekday + LOCAL time-of-day (in the academy's tz), from
 * the first matching weekday on/after newStartDate. Anchoring on local time (not
 * UTC) keeps an 18:00 session at 18:00 across a daylight-saving change between
 * the old and new term. Any occurrence whose local date is inside a holiday
 * range is dropped — nothing is planned on holidays.
 */
function generateWeeklyStarts(newStartDate: string, templateStartIso: string, weeks: number, holidays: Holiday[], tz: string): string[] {
  const tmpl = new Date(templateStartIso);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(tmpl);
  const tWeekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const tHour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const tMin = Number(parts.find((p) => p.type === "minute")?.value ?? "0");

  const wdFmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" });
  const ymdFmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });

  // First local date on/after newStartDate whose weekday matches the group's.
  let cur = new Date(`${newStartDate}T12:00:00.000Z`); // noon avoids DST edges while stepping days
  for (let i = 0; i < 7 && wdFmt.format(cur) !== tWeekday; i++) cur = new Date(cur.getTime() + DAY_MS);

  const out: string[] = [];
  for (let i = 0; i < weeks; i++) {
    const dayAnchor = new Date(cur.getTime() + i * 7 * DAY_MS);
    const dateStr = ymdFmt.format(dayAnchor); // yyyy-mm-dd in tz
    if (holidays.some((h) => h.from && h.to && dateStr >= h.from && dateStr <= h.to)) continue;
    const [y, mo, d] = dateStr.split("-").map(Number);
    out.push(localWallTimeToUtc(y, mo - 1, d, tHour, tMin, tz).toISOString());
  }
  return out;
}

// Most common value in a list (for suggesting the source price / term length).
function mode(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const counts = new Map<number, number>();
  let best = nums[0], bestN = 0;
  for (const n of nums) {
    const c = (counts.get(n) ?? 0) + 1;
    counts.set(n, c);
    if (c > bestN) { bestN = c; best = n; }
  }
  return best;
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
    // Two source modes (exactly one required): a single source CYCLUS — rebook
    // that whole cyclus's weekly pattern (Agenda "new round" / bulk-copy) — or
    // LOCATION(s) + term-end week — the cohort spanning hand-added + registration
    // slots (RebookCohortWizard).
    const sourceCyclusId: string | null = body?.sourceCyclusId ?? null;
    let academyProfileId: string = body?.academyProfileId;
    const locationIds: string[] = Array.isArray(body?.locationIds) ? body.locationIds : [];
    const termEndDate: string = body?.termEndDate; // yyyy-mm-dd
    const newStartDate: string = body?.newStartDate; // yyyy-mm-dd
    const priorityWindowDays: number = Number(body?.priorityWindowDays ?? 7);
    const memberWindowDays: number = Number(body?.memberWindowDays ?? 0);
    const paymentMode: string = body?.paymentMode === "upfront" ? "upfront" : "deferred_split";
    const requireAdminReview: boolean = body?.requireAdminReview === true;
    const targetCycleName: string | null = body?.targetCycleName ?? null;
    const dryRun: boolean = body?.dryRun === true;
    // New term shape (see generateWeeklyStarts): number of weeks, named holiday
    // ranges to skip, and the session price to apply to every new session.
    const weeks: number = Math.min(52, Math.max(0, Math.floor(Number(body?.weeks ?? 0)))); // hard cap at the source-form max
    const holidays: Holiday[] = Array.isArray(body?.holidays)
      ? body.holidays.filter((h: Holiday) => h && h.from && h.to)
      : [];
    const sessionPrice: number | null = body?.sessionPrice == null || body?.sessionPrice === ""
      ? null
      : Number(body.sessionPrice);

    if (!newStartDate || (!sourceCyclusId && (!academyProfileId || locationIds.length === 0 || !termEndDate))) {
      return new Response(JSON.stringify({ error: "newStartDate plus either sourceCyclusId, or academyProfileId + locationIds + termEndDate, are required" }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
    if (sessionPrice != null && (Number.isNaN(sessionPrice) || sessionPrice < 0)) {
      return new Response(JSON.stringify({ error: "sessionPrice must be a non-negative number" }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Cyclus mode: derive (and trust) the academy from the cyclus row itself, so a
    // caller can't rebook a cyclus into a different academy's namespace. The
    // manager authorization below then runs against this derived academy.
    if (sourceCyclusId) {
      const { data: srcCycle, error: scErr } = await supabase
        .from("cycles")
        .select("id, owner_id, owner_type, type")
        .eq("id", sourceCyclusId)
        .maybeSingle();
      if (scErr) throw scErr;
      if (!srcCycle || srcCycle.owner_type !== "academy") {
        return new Response(JSON.stringify({ error: "source cyclus not found" }), {
          status: 404, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      // Only weekly training cycli are rebookable — an event/registration cycle has
      // no weekly series, so it would silently produce a 0-player round.
      if (srcCycle.type !== "cyclus") {
        return new Response(JSON.stringify({ error: "source must be a training cyclus" }), {
          status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      academyProfileId = srcCycle.owner_id;
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

    // Academy timezone for DISPLAY (slots are stored UTC). NL academies default
    // to Europe/Amsterdam, so 18:00-local reads as 18:00, not the 16:00 UTC.
    const { data: acadTz } = await supabase
      .from("academy_profiles")
      .select("timezone")
      .eq("id", academyProfileId)
      .maybeSingle();
    const tz = acadTz?.timezone || "Europe/Amsterdam";

    // 1. Gather candidate slots: the whole source cyclus, or the academy's slots
    //    at the chosen location(s) up to the term end.
    const SLOT_COLUMNS = "id, trainer_id, location_id, academy_profile_id, start_time, end_time, court_type, training_level, price_per_session, total_price, allow_single_booking, min_participants, max_participants, extra_costs, rating_system, min_rating, max_rating, prices_include_vat, split_payment, cyclus_id";
    let slots: Slot[] = [];
    let termEndMs = 0;
    if (sourceCyclusId) {
      const { data, error: slotsErr } = await supabase
        .from("availability_slots")
        .select(SLOT_COLUMNS)
        .eq("cyclus_id", sourceCyclusId);
      if (slotsErr) throw slotsErr;
      slots = (data ?? []) as Slot[];
    } else {
      const termEnd = new Date(`${termEndDate}T23:59:59.999Z`);
      termEndMs = termEnd.getTime();
      const windowStart = new Date(termEnd.getTime() - 200 * DAY_MS); // generous term lookback
      const { data, error: slotsErr } = await supabase
        .from("availability_slots")
        .select(SLOT_COLUMNS)
        .eq("academy_profile_id", academyProfileId)
        .in("location_id", locationIds)
        .gte("start_time", windowStart.toISOString())
        .lte("start_time", termEnd.toISOString());
      if (slotsErr) throw slotsErr;
      slots = (data ?? []) as Slot[];
    }

    // 2. Cluster into series. Cyclus mode rebooks EVERY series in the cyclus;
    //    location mode keeps only series whose LAST session is in the term-end week.
    const bySeries = new Map<string, Slot[]>();
    for (const s of slots) {
      const arr = bySeries.get(seriesKey(s)) ?? [];
      arr.push(s);
      bySeries.set(seriesKey(s), arr);
    }
    const termEndWeekStart = termEndMs - 6 * DAY_MS;
    const qualifyingSeries: Slot[][] = [];
    for (const arr of bySeries.values()) {
      const sorted = arr.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
      if (sourceCyclusId) {
        qualifyingSeries.push(sorted);
      } else {
        const lastMs = Math.max(...arr.map((s) => new Date(s.start_time).getTime()));
        if (lastMs >= termEndWeekStart && lastMs <= termEndMs) qualifyingSeries.push(sorted);
      }
    }

    const allQualifyingSlotIds = qualifyingSeries.flat().map((s) => s.id);
    if (allQualifyingSlotIds.length === 0) {
      const message = sourceCyclusId
        ? "No bookable sessions found in this cyclus."
        : "No series found ending in that week at those locations.";
      return new Response(JSON.stringify({ ok: true, dryRun, groups: 0, players: 0, slotsCopied: 0, claimsCreated: 0, invitesSent: 0, message }), {
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

    // Suggested defaults from the source term: most common price + length in weeks.
    const suggestedPrice = mode(qualifyingSeries.flat().map((s) => s.price_per_session).filter((p): p is number => p != null));
    const suggestedWeeks = Math.max(
      ...qualifyingSeries.map((series) => {
        const weeksInSeries = new Set(series.map((s) => Math.floor(new Date(s.start_time).getTime() / (7 * DAY_MS))));
        return weeksInSeries.size;
      }),
    );

    const effWeeks = weeks > 0 ? weeks : suggestedWeeks;

    if (dryRun) {
      // Per-group breakdown for the admin to review BEFORE anything is created
      // or emailed: weekday + time, how many players (= invites), and how many
      // sessions will be planned for the next term (after skipping holidays).
      const weekdayFmt = new Intl.DateTimeFormat("nl-NL", { weekday: "long", timeZone: tz });
      const timeFmt = new Intl.DateTimeFormat("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: tz });
      const groupsDetail = qualifyingSeries.map((series) => {
        const tmpl = series[0];
        const d = new Date(tmpl.start_time);
        const cohort = new Set<string>();
        for (const src of series) {
          for (const b of bookingsBySlot.get(src.id) ?? []) cohort.add(b.player_id ?? `g:${b.guest_player_id}`);
        }
        const sessions = generateWeeklyStarts(newStartDate, tmpl.start_time, effWeeks, holidays, tz).length;
        return {
          weekday: weekdayFmt.format(d),
          time: timeFmt.format(d),
          players: cohort.size,
          sessions,
        };
      }).filter((g) => g.players > 0);
      const totalSessions = groupsDetail.reduce((sum, g) => sum + g.sessions * g.players, 0);
      return new Response(JSON.stringify({
        ok: true, dryRun: true,
        groups: qualifyingSeries.length,
        players: playerSet.size,
        suggestedWeeks,
        suggestedPrice,
        effWeeks,
        groupsDetail,
        totalSessions,
      }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    }
    const effName = targetCycleName || "Volgende ronde";

    // Best-effort teardown of a half-built cycle (used to roll back a failed run, and
    // to clear a leftover draft before a clean retry). A freshly-built rebook cycle
    // has no bookings yet, so deleting its slots can't orphan a paid seat.
    const cleanupCycle = async (cycleId: string) => {
      const { data: slotRows } = await supabase.from("availability_slots").select("id").eq("cyclus_id", cycleId);
      const ids = (slotRows ?? []).map((r) => r.id);
      for (let i = 0; i < ids.length; i += 100) {
        await supabase.from("slot_priority_claims").delete().in("slot_id", ids.slice(i, i + 100));
      }
      await supabase.from("availability_slots").delete().eq("cyclus_id", cycleId);
      await supabase.from("cycles").delete().eq("id", cycleId);
    };

    // Re-run guard. An existing NON-draft cycle with the same name+start_date is a
    // genuine double-run → block it (a second run would email everyone again). A
    // leftover DRAFT with the same key is debris from a previously-failed run (it was
    // never visible/bookable) → delete it and rebuild cleanly.
    const { data: existing } = await supabase
      .from("cycles")
      .select("id, status")
      .eq("owner_type", "academy")
      .eq("owner_id", academyProfileId)
      .eq("name", effName)
      .eq("start_date", newStartDate)
      // Only ever match THIS engine's own cycles (rebook marker present), so the
      // already_exists block and the draft cleanup below can never touch — let alone
      // delete — a manually-created registration/event cycle that shares name+date.
      .not("settings->>rebook_payment_mode", "is", null)
      .limit(1);
    if (existing && existing.length > 0) {
      if (existing[0].status === "draft") {
        await cleanupCycle(existing[0].id);
      } else {
        // 200 (not 409) so supabase.functions.invoke returns it as data, not an error.
        return new Response(JSON.stringify({ ok: false, reason: "already_exists", existingCycleId: existing[0].id }), {
          status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    // 4. Create the target cycle as a DRAFT. It is flipped to 'open' only after every
    //    slot + claim is written, so a mid-run failure/timeout leaves an invisible
    //    draft (cleaned up on retry) instead of a half-built 'open' round that a retry
    //    would refuse with already_exists.
    const repTemplate = qualifyingSeries[0][0];
    const cyclePrice = sessionPrice ?? suggestedPrice ?? repTemplate.price_per_session;
    const newEndDate = new Date(new Date(`${newStartDate}T00:00:00.000Z`).getTime() + (effWeeks - 1) * 7 * DAY_MS).toISOString().slice(0, 10);
    const singleLocation = locationIds.length === 1
      ? locationIds[0]
      : (sourceCyclusId ? repTemplate.location_id : null); // cyclus mode: inherit the source venue
    const { data: targetCycle, error: tcErr } = await supabase
      .from("cycles")
      .insert({
        owner_type: "academy",
        owner_id: academyProfileId,
        name: effName,
        start_date: newStartDate,
        end_date: newEndDate,
        type: "cyclus",
        status: "draft",
        location_id: singleLocation,
        price_per_session: cyclePrice,
        settings: { rebook_payment_mode: paymentMode, rebook_weeks: effWeeks, rebook_holidays: holidays, rebook_session_price: sessionPrice ?? null },
      })
      .select("id, name")
      .single();
    if (tcErr) {
      // 23505 = the concurrency unique index fired (a simultaneous run won the race).
      if (String((tcErr as { code?: string }).code) === "23505") {
        return new Response(JSON.stringify({ ok: false, reason: "already_exists" }), {
          status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      throw tcErr;
    }

    let committed = false;
    try {
      const now = new Date();
      const priorityEnd = new Date(now.getTime() + priorityWindowDays * DAY_MS);
      const memberEnd = memberWindowDays > 0 ? new Date(priorityEnd.getTime() + memberWindowDays * DAY_MS) : null;
      const publicReleaseStatus = requireAdminReview ? "pending_admin_review" : "auto_release_scheduled";

      let slotsCopied = 0;
      let claimsCreated = 0;
      const representativeClaimIds: string[] = [];

      // 5. For each source series, generate `effWeeks` weekly sessions for the next
      //    term (skipping holidays, applying the session price) and create group-level
      //    claims (one rebook_group_id per series) for every player who was in that
      //    group — so one Yes rebooks the whole new term. Inserts are BATCHED per
      //    series (one slot insert + chunked claim inserts) so a 20-group term is a few
      //    dozen round-trips, not thousands.
      for (const series of qualifyingSeries) {
        const tmpl = series[0];
        const durationMs = new Date(tmpl.end_time).getTime() - new Date(tmpl.start_time).getTime();
        const effPrice = sessionPrice ?? tmpl.price_per_session;
        const rebookGroupId = crypto.randomUUID();

        // Cohort for this group = distinct players booked on ANY session of the series.
        const cohort = new Map<string, { player_id: string | null; guest_player_id: string | null }>();
        for (const src of series) {
          for (const b of bookingsBySlot.get(src.id) ?? []) {
            cohort.set(b.player_id ?? `g:${b.guest_player_id}`, b);
          }
        }
        if (cohort.size === 0) continue;

        const starts = generateWeeklyStarts(newStartDate, tmpl.start_time, effWeeks, holidays, tz);
        if (starts.length === 0) continue;

        // 5a. Batch-insert this series' weekly slots in ONE round-trip.
        const slotRows = starts.map((startIso) => ({
          trainer_id: tmpl.trainer_id,
          start_time: startIso,
          end_time: new Date(new Date(startIso).getTime() + durationMs).toISOString(),
          is_recurring: false,
          cyclus_id: targetCycle.id,
          cyclus_name: targetCycle.name,
          court_type: tmpl.court_type,
          location_id: tmpl.location_id,
          academy_profile_id: tmpl.academy_profile_id,
          is_public: true,
          training_level: tmpl.training_level,
          price_per_session: effPrice,
          total_price: tmpl.total_price,
          allow_single_booking: tmpl.allow_single_booking,
          min_participants: tmpl.min_participants,
          max_participants: tmpl.max_participants,
          extra_costs: tmpl.extra_costs,
          rating_system: tmpl.rating_system,
          min_rating: tmpl.min_rating,
          max_rating: tmpl.max_rating,
          prices_include_vat: tmpl.prices_include_vat,
          split_payment: tmpl.split_payment,
          priority_source_slot_id: tmpl.id,
          priority_window_starts_at: now.toISOString(),
          priority_window_ends_at: priorityEnd.toISOString(),
          // Membership for the member window = anyone with a booking in THIS rebooked
          // cohort cycle. Pointing at the target (not the old, possibly mixed/null
          // source cyclus_id) makes the member window work uniformly: a freed seat
          // opens first to players who already rebooked into the new round.
          source_cycle_id: targetCycle.id,
          member_window_starts_at: memberEnd ? priorityEnd.toISOString() : null,
          member_window_ends_at: memberEnd ? memberEnd.toISOString() : null,
          public_release_status: publicReleaseStatus,
        }));
        const { data: newSlots, error: insErr } = await supabase
          .from("availability_slots")
          .insert(slotRows)
          .select("id, start_time");
        if (insErr) throw insErr;
        const slots = newSlots ?? [];
        slotsCopied += slots.length;

        // slot_id -> start_time, so we can pick each player's EARLIEST-week claim as
        // the representative (the one we email). start_time is unique within a series.
        const startBySlot = new Map<string, string>();
        for (const s of slots) startBySlot.set(s.id, s.start_time);

        // 5b. Batch-insert all (slot × player) claims for this series, chunked.
        const cohortArr = [...cohort.values()];
        const claimRows = slots.flatMap((s) =>
          cohortArr.map((b) => ({
            slot_id: s.id,
            player_id: b.player_id,
            guest_player_id: b.guest_player_id,
            source_slot_id: tmpl.id,
            rebook_group_id: rebookGroupId,
            status: "pending",
          })),
        );
        const insertedClaims: Array<{ id: string; slot_id: string; player_id: string | null; guest_player_id: string | null }> = [];
        for (let i = 0; i < claimRows.length; i += 500) {
          const { data: chunk, error: cErr } = await supabase
            .from("slot_priority_claims")
            .insert(claimRows.slice(i, i + 500))
            .select("id, slot_id, player_id, guest_player_id");
          if (cErr) throw cErr;
          insertedClaims.push(...(chunk ?? []));
        }
        claimsCreated += insertedClaims.length;

        // Representative = each player's claim on the EARLIEST week (min start_time).
        const repByPlayer = new Map<string, { claimId: string; start: string }>();
        for (const cl of insertedClaims) {
          const pkey = cl.player_id ?? `g:${cl.guest_player_id}`;
          const start = startBySlot.get(cl.slot_id) ?? "";
          const cur = repByPlayer.get(pkey);
          if (!cur || start < cur.start) repByPlayer.set(pkey, { claimId: cl.id, start });
        }
        for (const r of repByPlayer.values()) representativeClaimIds.push(r.claimId);
      }

      // 6. Commit: flip the draft to 'open' now that all slots + claims are written.
      //    Done BEFORE the invites so a later email hiccup can't roll back the round.
      const { error: commitErr } = await supabase.from("cycles").update({ status: "open" }).eq("id", targetCycle.id);
      if (commitErr) throw commitErr;
      committed = true;

      // 7. One invite per (player, series): email only the representative claims.
      //    Track failed batches so the admin can be told / a resend is possible —
      //    the cycle is already committed, so a partial send is recoverable.
      let invitesSent = 0;
      const failedClaimIds: string[] = [];
      for (let i = 0; i < representativeClaimIds.length; i += 50) {
        const batch = representativeClaimIds.slice(i, i + 50);
        const { data, error } = await supabase.functions.invoke("send-priority-claim-invitation", {
          body: { claimIds: batch },
        });
        if (!error && data) invitesSent += batch.length;
        else failedClaimIds.push(...batch);
      }

      logStep("done", { targetCycle: targetCycle.id, groups: qualifyingSeries.length, players: playerSet.size, slotsCopied, claimsCreated, invitesSent, failed: failedClaimIds.length });
      return new Response(JSON.stringify({
        ok: true,
        targetCycleId: targetCycle.id,
        groups: qualifyingSeries.length,
        players: playerSet.size,
        slotsCopied,
        claimsCreated,
        invitesSent,
        failedClaimIds,
      }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    } catch (buildErr) {
      // Roll back the half-built draft (only if not yet committed) so a retry is clean.
      if (!committed) {
        try { await cleanupCycle(targetCycle.id); } catch (_) { /* best-effort */ }
      }
      throw buildErr;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    return new Response(JSON.stringify({ error: message }), {
      status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
