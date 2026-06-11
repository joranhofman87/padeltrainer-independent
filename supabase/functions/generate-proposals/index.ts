import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface ScoringWeights {
  time_match: number;
  preferred_trainer: number;
  level_compatible: number;
  priority_bonus: number;
  capacity_available: number;
  sessions_per_week: number;
}

interface RatingSpreadSettings {
  maxSpread: number | null;
  ratingSystem: string;
}

interface TrainerProfile {
  id: string;
  preferred_min_rating: number | null;
  preferred_max_rating: number | null;
  preferred_rating_system: string | null;
}

interface TimeWindow {
  day: string;
  start: string;
  end: string;
}

interface RationaleItem {
  type: string;
  score: number;
  detail: string;
}

interface IntakeRequest {
  id: string;
  cycle_id: string;
  player_id: string;
  full_name: string;
  birth_date: string | null;
  rating: number | null;
  rating_system: string;
  lesson_type: string;
  preferred_days: string[];
  preferred_time_windows: TimeWindow[];
  preferred_trainer_ids: string[];
  preferred_duration_minutes: number | null;
  location_id: string | null;
  sessions_per_week: number;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface AvailabilitySlot {
  id: string;
  trainer_id: string;
  start_time: string;
  end_time: string;
  location_id: string | null;
  cyclus_id: string | null;
  max_participants: number | null;
}

interface TrainerAvailabilityInput {
  trainerId: string;
  trainerName: string;
  windows: { day: string; start: string; end: string }[];
  minRating: number | null;
  maxRating: number | null;
}

interface RequestBody {
  cycleId: string;
  weights?: ScoringWeights;
  ratingSpread?: RatingSpreadSettings;
  startDate?: string;
  trainerAvailability?: TrainerAvailabilityInput[];
  additionalCriteria?: string;
  keepCompleteGroups?: boolean; // backward compat
  linkStrategy?: 'strict' | 'prefer' | 'ignore';
  fillIncompleteGroups?: boolean;
  maxGroupSize?: number;
  timezone?: string;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  time_match: 35,
  preferred_trainer: 20,
  level_compatible: 15,
  priority_bonus: 10,
  capacity_available: 10,
  sessions_per_week: 10,
};


const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

function getDayOfWeek(dateString: string): string {
  const date = new Date(dateString);
  return WEEKDAYS[date.getDay()];
}

function getHour(dateString: string): number {
  return new Date(dateString).getHours();
}

function getMinutes(dateString: string): number {
  return new Date(dateString).getMinutes();
}

// Convert "13:00" or "13:30" to minutes from midnight
function timeToMinutes(time: string): number {
  const [hours, mins] = time.split(':').map(Number);
  return hours * 60 + (mins || 0);
}

// Get slot start time as minutes from midnight
function slotToMinutes(slotStart: string): number {
  const hour = getHour(slotStart);
  const minutes = getMinutes(slotStart);
  return hour * 60 + minutes;
}

function matchesTimeWindow(slotStart: string, timeWindow: TimeWindow): boolean {
  const slotDay = getDayOfWeek(slotStart);

  // Granular format: day + start + end
  if (timeWindow.day && timeWindow.start && timeWindow.end) {
    // Day must match exactly
    if (slotDay !== timeWindow.day.toLowerCase()) {
      return false;
    }
    
    // Check if slot start falls within the time window
    const slotMinutes = slotToMinutes(slotStart);
    const windowStart = timeToMinutes(timeWindow.start);
    const windowEnd = timeToMinutes(timeWindow.end);
    
    // Slot start must be within player's available window
    return slotMinutes >= windowStart && slotMinutes < windowEnd;
  }

  return false;
}

function calculateTimeScore(
  slot: AvailabilitySlot,
  request: IntakeRequest,
  maxScore: number
): { score: number; detail: string } {
  const matchingWindow = request.preferred_time_windows.find((tw) =>
    matchesTimeWindow(slot.start_time, tw)
  );

  if (matchingWindow) {
    const slotDay = getDayOfWeek(slot.start_time);
    const slotHour = getHour(slot.start_time);
    const slotMins = getMinutes(slot.start_time);
    const timeStr = `${slotHour.toString().padStart(2, '0')}:${slotMins.toString().padStart(2, '0')}`;
    
    return {
      score: maxScore,
      detail: `${slotDay.charAt(0).toUpperCase() + slotDay.slice(1)} ${timeStr} within ${matchingWindow.start}-${matchingWindow.end}`,
    };
  }

  return { score: 0, detail: "No availability match" };
}

function calculateTrainerScore(
  slot: AvailabilitySlot,
  request: IntakeRequest,
  maxScore: number
): { score: number; detail: string } {
  const preferredIds = request.preferred_trainer_ids || [];
  
  if (preferredIds.length === 0) {
    return { score: maxScore * 0.5, detail: "No trainer preference specified" };
  }

  if (preferredIds.includes(slot.trainer_id)) {
    return { score: maxScore, detail: "Matched with preferred trainer" };
  }

  return { score: 0, detail: "Not a preferred trainer" };
}

function calculateLevelScore(
  slot: AvailabilitySlot,
  request: IntakeRequest,
  trainerProfile: TrainerProfile | null,
  existingPlayersInSlot: IntakeRequest[],
  maxRatingSpread: number | null,
  ratingSpreadSystem: string | null,
  maxScore: number
): { score: number; detail: string; breakdown: { trainerRange: number; groupSpread: number } } {
  let trainerRangeScore = maxScore * 0.5;
  let groupSpreadScore = maxScore * 0.5;
  const details: string[] = [];

  if (!request.rating) {
    return { 
      score: maxScore * 0.5, 
      detail: "No rating provided",
      breakdown: { trainerRange: trainerRangeScore * 0.5, groupSpread: groupSpreadScore * 0.5 }
    };
  }

  if (trainerProfile?.preferred_min_rating !== null && 
      trainerProfile?.preferred_max_rating !== null &&
      trainerProfile?.preferred_rating_system === request.rating_system) {
    const inRange = request.rating >= trainerProfile.preferred_min_rating && 
                   request.rating <= trainerProfile.preferred_max_rating;
    if (inRange) {
      details.push(`Rating ${request.rating} in trainer range (${trainerProfile.preferred_min_rating}-${trainerProfile.preferred_max_rating})`);
    } else {
      trainerRangeScore = 0;
      details.push(`Rating ${request.rating} outside trainer range (${trainerProfile.preferred_min_rating}-${trainerProfile.preferred_max_rating})`);
    }
  } else {
    details.push("Trainer has no rating preference");
  }

  if (maxRatingSpread !== null && 
      ratingSpreadSystem === request.rating_system &&
      request.lesson_type !== 'private' &&
      existingPlayersInSlot.length > 0) {
    
    const otherRatings = existingPlayersInSlot
      .filter(p => p.rating !== null && p.rating_system === request.rating_system)
      .map(p => p.rating as number);

    if (otherRatings.length > 0) {
      const allRatings = [...otherRatings, request.rating];
      const minRating = Math.min(...allRatings);
      const maxRating = Math.max(...allRatings);
      const spread = Math.abs(maxRating - minRating);

      if (spread <= maxRatingSpread) {
        details.push(`Group spread ${spread.toFixed(2)} within limit ${maxRatingSpread}`);
      } else {
        groupSpreadScore = 0;
        details.push(`Group spread ${spread.toFixed(2)} exceeds limit ${maxRatingSpread}`);
      }
    }
  }

  const totalScore = Math.round(trainerRangeScore + groupSpreadScore);
  return { 
    score: totalScore, 
    detail: details.join(", ") || `Rating ${request.rating} compatible`,
    breakdown: { trainerRange: trainerRangeScore, groupSpread: groupSpreadScore }
  };
}


function calculatePriorityScore(
  registrationOrder: number,
  totalRequests: number,
  maxScore: number
): { score: number; detail: string } {
  const position = registrationOrder + 1;
  const score = Math.round(maxScore * (1 - registrationOrder / totalRequests));
  return {
    score,
    detail: `Registration #${position} of ${totalRequests}`,
  };
}

function calculateCapacityScore(
  currentBookings: number,
  maxParticipants: number,
  maxScore: number
): { score: number; detail: string } {
  const availableSpots = maxParticipants - currentBookings;
  if (availableSpots <= 0) {
    return { score: 0, detail: "Slot is full" };
  }
  if (availableSpots >= maxParticipants) {
    return { score: maxScore, detail: "Slot is empty" };
  }
  const score = Math.round(
    maxScore * (availableSpots / maxParticipants)
  );
  return {
    score,
    detail: `${availableSpots} of ${maxParticipants} spots available`,
  };
}

function calculateSessionsScore(
  sessionsPerWeek: number,
  maxScore: number
): { score: number; detail: string } {
  const score = Math.round(maxScore * (1 / sessionsPerWeek));
  return {
    score,
    detail: `${sessionsPerWeek}× per week`,
  };
}

// Check if two time ranges overlap
function rangesOverlap(
  startA: number, endA: number,
  startB: number, endB: number
): boolean {
  return startA < endB && startB < endA;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    let body: RequestBody;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid or empty request body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const { cycleId, weights: inputWeights, ratingSpread, startDate, trainerAvailability, additionalCriteria, keepCompleteGroups, fillIncompleteGroups: fillIncomplete, maxGroupSize: inputMaxGroupSize, timezone: inputTimezone } = body;
    // Resolve timezone: use provided value, default to Europe/Amsterdam
    const timezone = inputTimezone || 'Europe/Amsterdam';
    // Resolve linkStrategy: new field takes precedence, fallback to keepCompleteGroups for backward compat
    const linkStrategy: 'strict' | 'prefer' | 'ignore' = body.linkStrategy ?? (keepCompleteGroups === false ? 'ignore' : keepCompleteGroups === true ? 'strict' : 'prefer');
    const fillIncompleteGroups = fillIncomplete ?? true;

    if (!cycleId) {
      return new Response(
        JSON.stringify({ error: "cycleId is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const weights = inputWeights || DEFAULT_WEIGHTS;
    const maxRatingSpread = ratingSpread?.maxSpread ?? null;
    const ratingSpreadSystem = ratingSpread?.ratingSystem ?? null;

    const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
    const normalizedWeights: ScoringWeights = totalWeight > 0
      ? {
          time_match: (weights.time_match / totalWeight) * 100,
          preferred_trainer: (weights.preferred_trainer / totalWeight) * 100,
          level_compatible: (weights.level_compatible / totalWeight) * 100,
          priority_bonus: (weights.priority_bonus / totalWeight) * 100,
          capacity_available: (weights.capacity_available / totalWeight) * 100,
          sessions_per_week: ((weights.sessions_per_week || 0) / totalWeight) * 100,
        }
      : DEFAULT_WEIGHTS;

    // Fetch cycle details
    const { data: cycle, error: cycleError } = await supabase
      .from("cycles")
      .select("*")
      .eq("id", cycleId)
      .single();

    if (cycleError || !cycle) {
      return new Response(
        JSON.stringify({ error: "Cycle not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Parse additional criteria using AI if provided
    let aiRules: { type: string; condition: string; value: any }[] = [];
    if (additionalCriteria && additionalCriteria.trim()) {
      try {
        const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
        if (LOVABLE_API_KEY) {
          const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${LOVABLE_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash",
              messages: [
                {
                  role: "system",
                  content: `You parse scheduling criteria into structured rules. Return JSON array of rules. Each rule has: type (one of: "min_participants", "max_participants", "time_restriction", "lesson_type_restriction"), condition (e.g. "evening", "daytime", "kids"), value (number or string). Example input: "kids lessons only during the day, evening always 4 players" => [{"type":"time_restriction","condition":"kids","value":"06:00-18:00"},{"type":"min_participants","condition":"evening","value":4}]`
                },
                { role: "user", content: additionalCriteria }
              ],
              tools: [{
                type: "function",
                function: {
                  name: "parse_rules",
                  description: "Parse scheduling criteria into structured rules",
                  parameters: {
                    type: "object",
                    properties: {
                      rules: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            type: { type: "string" },
                            condition: { type: "string" },
                            value: {}
                          },
                          required: ["type", "condition", "value"]
                        }
                      }
                    },
                    required: ["rules"]
                  }
                }
              }],
              tool_choice: { type: "function", function: { name: "parse_rules" } }
            }),
          });

          if (aiResponse.ok) {
            const aiData = await aiResponse.json();
            const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
            if (toolCall?.function?.arguments) {
              const parsed = JSON.parse(toolCall.function.arguments);
              aiRules = parsed.rules || [];
              console.log("AI parsed rules:", JSON.stringify(aiRules));
            }
          } else {
            console.warn("AI criteria parsing failed, ignoring:", aiResponse.status);
          }
        }
      } catch (e) {
        console.warn("Failed to parse additional criteria:", e);
      }
    }

    // ===== STEP 0: Reset 'proposed' requests back to 'new' for re-run safety =====
    console.log(`Resetting proposed requests back to 'new' for cycle ${cycleId}...`);
    const { error: resetError } = await supabase
      .from("intake_requests")
      .update({ status: "new", skip_reason: null })
      .eq("cycle_id", cycleId)
      .in("status", ["proposed"]);

    if (resetError) {
      console.warn("Error resetting proposed requests:", resetError);
    }

    // Delete old proposed assignments for this cycle's requests
    const { data: allCycleRequests } = await supabase
      .from("intake_requests")
      .select("id")
      .eq("cycle_id", cycleId);

    if (allCycleRequests && allCycleRequests.length > 0) {
      const allReqIds = allCycleRequests.map(r => r.id);
      await supabase
        .from("proposed_assignments")
        .delete()
        .in("intake_request_id", allReqIds);
    }

    // Fetch intake requests with status 'new' (now includes the ones we just reset)
    const { data: requests, error: requestsError } = await supabase
      .from("intake_requests")
      .select("*")
      .eq("cycle_id", cycleId)
      .eq("status", "new")
      .order("created_at", { ascending: true });

    if (requestsError) throw requestsError;

    if (!requests || requests.length === 0) {
      return new Response(
        JSON.stringify({ generated: 0, skipped: 0, message: "No new requests to process" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const effectiveStartDate = startDate || cycle.start_date;

    // ===== Delete old cycle slots before creating new ones =====
    console.log(`Cleaning up old slots for cycle ${cycleId}...`);
    const { error: deleteOldSlotsError } = await supabase
      .from("availability_slots")
      .delete()
      .eq("cyclus_id", cycleId);

    if (deleteOldSlotsError) {
      console.error("Error deleting old slots:", deleteOldSlotsError);
    } else {
      console.log(`Deleted old cycle slots for cycle ${cycleId}`);
    }

    // ===== STEP 1: Generate new slots from trainer availability =====
    let slotsCreated = 0;
    if (trainerAvailability && trainerAvailability.length > 0) {
      // Update trainer profiles with provided rating ranges
      for (const ta of trainerAvailability) {
        if (ta.minRating !== null || ta.maxRating !== null) {
          await supabase
            .from("trainer_profiles")
            .update({
              preferred_min_rating: ta.minRating,
              preferred_max_rating: ta.maxRating,
            })
            .eq("id", ta.trainerId);
        }
      }

      // Fetch existing non-cycle slots for conflict checking
      const trainerIds = trainerAvailability.map(ta => ta.trainerId);
      const { data: existingSlots } = await supabase
        .from("availability_slots")
        .select("id, trainer_id, start_time, end_time")
        .in("trainer_id", trainerIds)
        .is("cyclus_id", null)
        .gte("start_time", effectiveStartDate)
        .lte("start_time", cycle.end_date);

      // Build conflict map: trainerId -> array of { start, end } in epoch ms
      const conflictMap = new Map<string, { start: number; end: number }[]>();
      (existingSlots || []).forEach(s => {
        const existing = conflictMap.get(s.trainer_id) || [];
        existing.push({
          start: new Date(s.start_time).getTime(),
          end: new Date(s.end_time).getTime(),
        });
        conflictMap.set(s.trainer_id, existing);
      });

      const cycleEndDate = new Date(cycle.end_date);
      const slotsToInsert: any[] = [];
      const SLOT_DURATION = 60; // Always 60-min uniform grid

      // Extract pricing fields from cycle record + settings
      const pricePerSession = cycle.price_per_session || null;
      const extraCosts = cycle.settings?.extra_costs || [];
      const splitPayment = cycle.settings?.split_payment || false;
      const pricesIncludeVat = cycle.settings?.prices_include_vat ?? true;

      for (const ta of trainerAvailability) {
        const trainerConflicts = conflictMap.get(ta.trainerId) || [];

        for (const window of ta.windows) {
          const dayIndex = WEEKDAYS.indexOf(window.day.toLowerCase());
          if (dayIndex === -1) continue;

          const [windowStartH, windowStartM] = window.start.split(":").map(Number);
          const [windowEndH, windowEndM] = window.end.split(":").map(Number);
          const windowStartMinutes = windowStartH * 60 + (windowStartM || 0);
          let windowEndMinutes = windowEndH * 60 + (windowEndM || 0);
          // Treat 00:00 as end-of-day (midnight wrap)
          if (windowEndMinutes === 0) windowEndMinutes = 1440;

          const current = new Date(effectiveStartDate);
          while (current.getDay() !== dayIndex) {
            current.setDate(current.getDate() + 1);
          }

          // Generate uniform 60-min slots for EVERY week until cycle end
          while (current <= cycleEndDate) {
            // Helper: compute UTC offset in minutes for a given date and timezone
            function getTimezoneOffsetMs(date: Date, tz: string): number {
              const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
              const tzStr = date.toLocaleString('en-US', { timeZone: tz });
              return new Date(utcStr).getTime() - new Date(tzStr).getTime();
            }

            let slotStartMinutes = windowStartMinutes;
            while (slotStartMinutes + SLOT_DURATION <= windowEndMinutes) {
              // Create slot in local timezone by computing UTC offset for this specific date
              const localHour = Math.floor(slotStartMinutes / 60);
              const localMin = slotStartMinutes % 60;

              // Build a date at the local time first, then adjust for timezone
              const startDateTime = new Date(current);
              startDateTime.setUTCHours(localHour, localMin, 0, 0);
              // Apply timezone offset: shift from "naive local" to correct UTC
              const offsetMs = getTimezoneOffsetMs(startDateTime, timezone);
              startDateTime.setTime(startDateTime.getTime() + offsetMs);

              const endMinutes = slotStartMinutes + SLOT_DURATION;
              const endLocalHour = Math.floor(endMinutes / 60);
              const endLocalMin = endMinutes % 60;
              const endDateTime = new Date(current);
              endDateTime.setUTCHours(endLocalHour, endLocalMin, 0, 0);
              endDateTime.setTime(endDateTime.getTime() + offsetMs);

              // Check for conflicts with existing non-cycle slots
              const startMs = startDateTime.getTime();
              const endMs = endDateTime.getTime();
              const hasConflict = trainerConflicts.some(c =>
                rangesOverlap(startMs, endMs, c.start, c.end)
              );

              if (!hasConflict) {
                slotsToInsert.push({
                  trainer_id: ta.trainerId,
                  start_time: startDateTime.toISOString(),
                  end_time: endDateTime.toISOString(),
                  allow_single_booking: (inputMaxGroupSize || cycle.settings?.max_group_size || 4) < 4,
                  is_public: false,
                  is_recurring: false,
                  cyclus_id: cycleId,
                  max_participants: inputMaxGroupSize || cycle.settings?.max_group_size || 4,
                  min_participants: cycle.settings?.min_group_size || null,
                  academy_profile_id: cycle.owner_type === "academy" ? cycle.owner_id : null,
                  location_id: cycle.location_id || null,
                  price_per_session: pricePerSession,
                  extra_costs: extraCosts.length > 0 ? extraCosts : null,
                  split_payment: splitPayment,
                  prices_include_vat: pricesIncludeVat,
                });
              }

              slotStartMinutes += SLOT_DURATION;
            }

            // Advance to the same weekday next week
            current.setDate(current.getDate() + 7);
          }
        }
      }

      if (slotsToInsert.length > 0) {
        const { error: slotInsertError } = await supabase
          .from("availability_slots")
          .insert(slotsToInsert);

        if (slotInsertError) {
          console.error("Error creating slots:", slotInsertError);
          throw new Error("Failed to create availability slots: " + slotInsertError.message);
        }
        slotsCreated = slotsToInsert.length;
        console.log(`Created ${slotsCreated} availability slots from wizard config`);
      }
    }

    // Get trainer IDs to include
    const trainerIds: string[] = trainerAvailability?.map(ta => ta.trainerId) 
      || cycle.settings?.applicable_trainer_ids 
      || [];
    if (cycle.owner_type === "trainer" && !trainerIds.includes(cycle.owner_id)) {
      trainerIds.push(cycle.owner_id);
    }

    // Fetch availability slots for THIS CYCLE only (cyclus_id match)
    let slotsQuery = supabase
      .from("availability_slots")
      .select("*, max_participants")
      .eq("cyclus_id", cycleId)
      .eq("", false);

    if (trainerIds.length > 0) {
      slotsQuery = slotsQuery.in("trainer_id", trainerIds);
    }

    const { data: slots, error: slotsError } = await slotsQuery;
    if (slotsError) throw slotsError;

    if (!slots || slots.length === 0) {
      return new Response(
        JSON.stringify({ generated: 0, skipped: requests.length, message: "No available slots found" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Found ${slots.length} cycle slots to match against`);

    // Fetch trainer profiles for rating preference checks
    const slotTrainerIds = [...new Set(slots.map(s => s.trainer_id))];
    const { data: trainerProfiles } = await supabase
      .from("trainer_profiles")
      .select("id, preferred_min_rating, preferred_max_rating, preferred_rating_system")
      .in("id", slotTrainerIds);

    const trainerProfileMap: Record<string, TrainerProfile> = {};
    (trainerProfiles || []).forEach((tp) => {
      trainerProfileMap[tp.id] = tp as TrainerProfile;
    });

    // Fetch existing bookings to check capacity (batched)
    const slotIds = slots.map((s) => s.id);
    const BATCH_SIZE = 200;
    const allBookings: { slot_id: string }[] = [];
    for (let i = 0; i < slotIds.length; i += BATCH_SIZE) {
      const batch = slotIds.slice(i, i + BATCH_SIZE);
      const { data, error: bookingsError } = await supabase
        .from("bookings")
        .select("slot_id")
        .in("slot_id", batch)
        .in("status", ["pending", "confirmed"]);
      if (bookingsError) throw bookingsError;
      if (data) allBookings.push(...data);
    }

    const bookingCounts: Record<string, number> = {};
    allBookings.forEach((b) => {
      bookingCounts[b.slot_id] = (bookingCounts[b.slot_id] || 0) + 1;
    });

    // Defensively clean up stale proposals for these "new" requests
    const requestIds = requests.map((r) => r.id);
    const { data: staleProposals } = await supabase
      .from("proposed_assignments")
      .select("id")
      .in("intake_request_id", requestIds);

    if (staleProposals && staleProposals.length > 0) {
      console.log(`Cleaning up ${staleProposals.length} stale proposals for 'new' requests`);
      await supabase
        .from("proposed_assignments")
        .delete()
        .in("intake_request_id", requestIds);
    }

    let generated = 0;
    let skipped = 0;
    const errors: string[] = [];

    // Track which requests have been assigned to which slots
    const slotAssignments: Record<string, IntakeRequest[]> = {};

    // Clear old skip reasons
    await supabase
      .from("intake_requests")
      .update({ skip_reason: null })
      .in("id", requestIds);

    // ===== Fetch player links for group cohesion =====
    const { data: playerLinksData } = await supabase
      .from("player_links")
      .select("*")
      .in("intake_request_id", requestIds);

    // Build link group map: requestId -> linkGroup, linkGroup -> requestIds
    const requestLinkGroup: Record<string, string> = {};
    const linkGroupMembers: Record<string, string[]> = {};
    (playerLinksData || []).forEach((pl: { intake_request_id: string; link_group: string }) => {
      requestLinkGroup[pl.intake_request_id] = pl.link_group;
      if (!linkGroupMembers[pl.link_group]) linkGroupMembers[pl.link_group] = [];
      linkGroupMembers[pl.link_group].push(pl.intake_request_id);
    });

    // ===== Handle linked groups based on linkStrategy =====
    const processedRequestIds = new Set<string>();
    const reservedSlots = new Set<string>(); // slots where remaining capacity is reserved (fillIncompleteGroups=false)

    if (linkStrategy === 'strict' || linkStrategy === 'prefer') {
      const defaultMaxParticipants = inputMaxGroupSize || cycle.settings?.max_group_size || 4;

      for (const [groupId, memberIds] of Object.entries(linkGroupMembers)) {
        const groupRequests = memberIds
          .map(id => requests.find(r => r.id === id))
          .filter(Boolean) as IntakeRequest[];

        if (groupRequests.length < 2) continue;

        // In 'prefer' mode, only handle complete groups as atomic units
        if (linkStrategy === 'prefer' && groupRequests.length < defaultMaxParticipants) continue;

        console.log(`[${linkStrategy}] Group ${groupId}: ${groupRequests.length} members, placing as unit`);

        const groupMatchingSlots = slots.filter(slot => {
          if (reservedSlots.has(slot.id)) return false;
          const maxP = slot.max_participants || defaultMaxParticipants;
          const currentBookings = bookingCounts[slot.id] || 0;
          const available = maxP - currentBookings - (slotAssignments[slot.id]?.length || 0);
          if (available < groupRequests.length) return false;
          return groupRequests.some(req =>
            req.preferred_time_windows.some(tw => matchesTimeWindow(slot.start_time, tw))
          );
        });

        if (groupMatchingSlots.length === 0) {
          if (linkStrategy === 'strict') {
            console.log(`No slot fits group ${groupId} in strict mode — skipping/waitlisting`);
            for (const req of groupRequests) {
              skipped++;
              await supabase.from("intake_requests").update({ skip_reason: "no_slot_for_group" }).eq("id", req.id);
              processedRequestIds.add(req.id);
            }
          } else {
            console.log(`No slot fits complete group ${groupId} in prefer mode, falling back to individual scoring`);
          }
          continue;
        }

        let bestSlot: AvailabilitySlot | null = null;
        let bestAvgScore = -1;

        for (const slot of groupMatchingSlots) {
          let totalScore = 0;
          for (const req of groupRequests) {
            const timeResult = calculateTimeScore(slot, req, normalizedWeights.time_match);
            totalScore += timeResult.score;
          }
          const avgScore = totalScore / groupRequests.length;
          if (avgScore > bestAvgScore) {
            bestAvgScore = avgScore;
            bestSlot = slot;
          }
        }

        if (!bestSlot) continue;

        let groupSuccess = true;
        for (const req of groupRequests) {
          const rationale: RationaleItem[] = [
            { type: "group_cohesion", score: 50, detail: `Group of ${groupRequests.length} placed together (${linkStrategy})` },
            calculateTimeScore(bestSlot, req, normalizedWeights.time_match),
          ];
          const totalScore = rationale.reduce((sum, r) => sum + r.score, 0);

          const { error: insertError } = await supabase
            .from("proposed_assignments")
            .insert({
              intake_request_id: req.id,
              slot_id: bestSlot.id,
              trainer_id: bestSlot.trainer_id,
              confidence_score: Math.round(totalScore),
              rationale,
              status: "proposed",
            });

          if (insertError) {
            console.error(`Failed to assign group member ${req.id}:`, insertError);
            groupSuccess = false;
          } else {
            if (!slotAssignments[bestSlot.id]) slotAssignments[bestSlot.id] = [];
            slotAssignments[bestSlot.id].push(req);
            await supabase.from("intake_requests").update({ status: "proposed" }).eq("id", req.id);
            processedRequestIds.add(req.id);
            generated++;
          }
        }

        if (groupSuccess) {
          console.log(`Group ${groupId} placed in slot ${bestSlot.id}`);
          // If fillIncompleteGroups is false, reserve remaining capacity
          if (!fillIncompleteGroups) {
            reservedSlots.add(bestSlot.id);
          }
        }
      }
    }

    // Sort requests: linked players first (grouped together), then the rest
    const sortedRequests = [...requests].filter(r => !processedRequestIds.has(r.id));
    sortedRequests.sort((a, b) => {
      const aGroup = requestLinkGroup[a.id];
      const bGroup = requestLinkGroup[b.id];
      if (aGroup && !bGroup) return -1;
      if (!aGroup && bGroup) return 1;
      if (aGroup && bGroup && aGroup !== bGroup) return aGroup.localeCompare(bGroup);
      return 0;
    });

    // Process each request
    for (let i = 0; i < sortedRequests.length; i++) {
      const request = sortedRequests[i] as IntakeRequest;
      const preferredWeeks = request.metadata?.preferred_number_of_weeks as number | undefined;

      if (preferredWeeks) {
        console.log(`Request ${request.id} (${request.full_name}) prefers ${preferredWeeks} weeks`);
      }

      const defaultMaxParticipantsIndiv = inputMaxGroupSize || cycle.settings?.max_group_size || 4;
      const matchingSlots = slots.filter((slot) => {
        // Skip reserved slots (fillIncompleteGroups=false)
        if (reservedSlots.has(slot.id)) return false;
        // HARD CAP: skip slots that are already full
        const maxP = slot.max_participants || defaultMaxParticipantsIndiv;
        const currentBookings = bookingCounts[slot.id] || 0;
        const currentAssignments = slotAssignments[slot.id]?.length || 0;
        if (currentBookings + currentAssignments >= maxP) return false;
        return request.preferred_time_windows.some((tw) =>
          matchesTimeWindow(slot.start_time, tw)
        );
      });

      if (matchingSlots.length === 0) {
        skipped++;
        await supabase
          .from("intake_requests")
          .update({ skip_reason: "no_matching_slots" })
          .eq("id", request.id);
        errors.push(`No slots match player availability for request ${request.id}`);
        continue;
      }

      if (request.rating && maxRatingSpread !== null) {
        const hasCompatibleTrainer = matchingSlots.some((slot) => {
          const trainerProfile = trainerProfileMap[slot.trainer_id];
          if (!trainerProfile?.preferred_min_rating || !trainerProfile?.preferred_max_rating) {
            return true;
          }
          if (trainerProfile.preferred_rating_system !== request.rating_system) {
            return true;
          }
          return request.rating! >= trainerProfile.preferred_min_rating &&
                 request.rating! <= trainerProfile.preferred_max_rating;
        });

        if (!hasCompatibleTrainer) {
          skipped++;
          await supabase
            .from("intake_requests")
            .update({ skip_reason: "rating_outside_trainer_range" })
            .eq("id", request.id);
          errors.push(`Player rating outside all trainers' preferred range for request ${request.id}`);
          continue;
        }
      }

      // Score each slot
      const scoredSlots = matchingSlots.map((slot) => {
        const rationale: RationaleItem[] = [];
        const trainerProfile = trainerProfileMap[slot.trainer_id] || null;
        const existingPlayersInSlot = slotAssignments[slot.id] || [];

        const timeResult = calculateTimeScore(slot, request, normalizedWeights.time_match);
        rationale.push({ type: "time_match", score: timeResult.score, detail: timeResult.detail });

        const trainerResult = calculateTrainerScore(slot, request, normalizedWeights.preferred_trainer);
        rationale.push({ type: "preferred_trainer", score: trainerResult.score, detail: trainerResult.detail });

        const levelResult = calculateLevelScore(
          slot, request, trainerProfile, existingPlayersInSlot,
          maxRatingSpread, ratingSpreadSystem, normalizedWeights.level_compatible
        );
        rationale.push({ type: "level_compatible", score: levelResult.score, detail: levelResult.detail });

        const priorityResult = calculatePriorityScore(i, sortedRequests.length, normalizedWeights.priority_bonus);
        rationale.push({ type: "priority_bonus", score: priorityResult.score, detail: priorityResult.detail });

        const currentBookings = bookingCounts[slot.id] || 0;
        const maxParticipants = slot.max_participants || 4;
        const capacityResult = calculateCapacityScore(currentBookings, maxParticipants, normalizedWeights.capacity_available);
        rationale.push({ type: "capacity_available", score: capacityResult.score, detail: capacityResult.detail });

        const sessionsResult = calculateSessionsScore(request.sessions_per_week || 1, normalizedWeights.sessions_per_week);
        rationale.push({ type: "sessions_per_week", score: sessionsResult.score, detail: sessionsResult.detail });

        // Group cohesion bonus: if this player is linked with others, boost slots where linked members are already placed
        const playerGroup = requestLinkGroup[request.id];
        if (playerGroup && linkStrategy !== 'ignore') {
          const groupMemberIds = linkGroupMembers[playerGroup] || [];
          const linkedInSlot = existingPlayersInSlot.filter(p => groupMemberIds.includes(p.id));
          if (linkedInSlot.length > 0) {
            const cohesionScore = linkStrategy === 'strict' ? 75 : 50;
            rationale.push({ type: "group_cohesion", score: cohesionScore, detail: `${linkedInSlot.length} linked player(s) already in this slot` });
          }
        }

        const totalScore = rationale.reduce((sum, r) => sum + r.score, 0);

        return { slot, score: Math.round(totalScore), rationale };
      });

      scoredSlots.sort((a, b) => b.score - a.score);

      // Assign player to multiple slots if sessions_per_week > 1
      const sessionsNeeded = request.sessions_per_week || 1;
      const assignedDays: Set<string> = new Set();
      let sessionAssigned = 0;

      // Build a list of candidates sorted by score (already sorted)
      const candidateSlots = [...scoredSlots];

      for (let session = 0; session < sessionsNeeded; session++) {
        // Find the best slot not on an already-assigned day and not full
        const pick = candidateSlots.find(s => {
          if (!s || s.score === 0) return false;
          // Get the day-of-week from the slot's start_time
          const slotDate = new Date(s.slot.start_time);
          const dayKey = slotDate.toLocaleDateString('en-US', { weekday: 'long' });
          if (assignedDays.has(dayKey)) return false;
          // Re-check capacity with updated slotAssignments
          const maxP = s.slot.max_participants || defaultMaxParticipantsIndiv;
          const currentBookings = bookingCounts[s.slot.id] || 0;
          const currentAssignments = slotAssignments[s.slot.id]?.length || 0;
          if (currentBookings + currentAssignments >= maxP) return false;
          return true;
        });

        if (!pick) {
          if (session === 0) {
            // No slot at all — skip this request
            skipped++;
            const allFull = scoredSlots.every(s =>
              s.rationale.find(r => r.type === 'capacity_available')?.score === 0
            );
            const ratingSpreadIssue = scoredSlots.every(s =>
              s.rationale.find(r => r.type === 'level_compatible')?.score === 0
            );
            let skipReason = "no_matching_slots";
            if (allFull) skipReason = "all_slots_full";
            else if (ratingSpreadIssue) skipReason = "rating_spread_exceeded";
            await supabase
              .from("intake_requests")
              .update({ skip_reason: skipReason })
              .eq("id", request.id);
          } else {
            // Partial fulfillment — some sessions assigned but not all
            console.log(`Request ${request.id}: placed ${sessionAssigned}/${sessionsNeeded} sessions (not enough different-day slots)`);
          }
          break;
        }

        const slotDate = new Date(pick.slot.start_time);
        const dayKey = slotDate.toLocaleDateString('en-US', { weekday: 'long' });

        const { error: insertError } = await supabase
          .from("proposed_assignments")
          .insert({
            intake_request_id: request.id,
            slot_id: pick.slot.id,
            trainer_id: pick.slot.trainer_id,
            confidence_score: pick.score,
            rationale: pick.rationale,
            status: "proposed",
          });

        if (insertError) {
          errors.push(`Failed to create proposal for ${request.id} session ${session + 1}: ${insertError.message}`);
          if (session === 0) skipped++;
          break;
        }

        if (!slotAssignments[pick.slot.id]) {
          slotAssignments[pick.slot.id] = [];
        }
        slotAssignments[pick.slot.id].push(request);
        assignedDays.add(dayKey);
        sessionAssigned++;
      }

      if (sessionAssigned > 0) {
        await supabase
          .from("intake_requests")
          .update({ status: "proposed" })
          .eq("id", request.id);
        generated++;
      }
    }

    // Step 3 (gap-filler) removed — Step 1 now creates full coverage with uniform 60-min slots

    return new Response(
      JSON.stringify({
        generated,
        skipped,
        slotsCreated: slotsCreated || 0,
        errors: errors.length > 0 ? errors : undefined,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error generating proposals:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
