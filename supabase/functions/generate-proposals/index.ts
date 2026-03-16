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
  created_at: string;
}

interface AvailabilitySlot {
  id: string;
  trainer_id: string;
  start_time: string;
  end_time: string;
  is_marked_full: boolean;
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

// Get slot duration in minutes
function slotDurationMinutes(slot: AvailabilitySlot): number {
  const start = new Date(slot.start_time).getTime();
  const end = new Date(slot.end_time).getTime();
  return Math.round((end - start) / 60000);
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
    const { cycleId, weights: inputWeights, ratingSpread, startDate, trainerAvailability, additionalCriteria } = body;

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

      for (const ta of trainerAvailability) {
        const trainerConflicts = conflictMap.get(ta.trainerId) || [];

        for (const window of ta.windows) {
          const dayIndex = WEEKDAYS.indexOf(window.day.toLowerCase());
          if (dayIndex === -1) continue;

          const [windowStartH, windowStartM] = window.start.split(":").map(Number);
          const [windowEndH, windowEndM] = window.end.split(":").map(Number);
          const windowStartMinutes = windowStartH * 60 + (windowStartM || 0);
          const windowEndMinutes = windowEndH * 60 + (windowEndM || 0);

          let current = new Date(effectiveStartDate);
          while (current.getDay() !== dayIndex) {
            current.setDate(current.getDate() + 1);
          }

          // Generate uniform 60-min slots for the FULL trainer availability window
          {
            let slotStartMinutes = windowStartMinutes;
            while (slotStartMinutes + SLOT_DURATION <= windowEndMinutes) {
              const startDateTime = new Date(current);
              startDateTime.setHours(Math.floor(slotStartMinutes / 60), slotStartMinutes % 60, 0, 0);

              const endMinutes = slotStartMinutes + SLOT_DURATION;
              const endDateTime = new Date(current);
              endDateTime.setHours(Math.floor(endMinutes / 60), endMinutes % 60, 0, 0);

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
                  is_marked_full: false,
                  is_public: false,
                  is_recurring: false,
                  cyclus_id: cycleId,
                  max_participants: cycle.settings?.max_group_size || 4,
                  min_participants: cycle.settings?.min_group_size || null,
                  academy_profile_id: cycle.owner_type === "academy" ? cycle.owner_id : null,
                  location_id: cycle.location_id || null,
                });
              }

              slotStartMinutes += SLOT_DURATION;
            }
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
      .eq("is_marked_full", false);

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

    // Process each request
    for (let i = 0; i < requests.length; i++) {
      const request = requests[i] as IntakeRequest;

      // All slots are now uniform 60-min; no duration filter needed

      // STRICT AVAILABILITY FILTER: Only consider slots that match player's time windows
      const matchingSlots = durationMatchedSlots.filter((slot) => {
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

      // Check if player's rating is compatible with any trainer's preferences
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

        const priorityResult = calculatePriorityScore(i, requests.length, normalizedWeights.priority_bonus);
        rationale.push({ type: "priority_bonus", score: priorityResult.score, detail: priorityResult.detail });

        const currentBookings = bookingCounts[slot.id] || 0;
        const maxParticipants = slot.max_participants || 4;
        const capacityResult = calculateCapacityScore(currentBookings, maxParticipants, normalizedWeights.capacity_available);
        rationale.push({ type: "capacity_available", score: capacityResult.score, detail: capacityResult.detail });

        const sessionsResult = calculateSessionsScore(request.sessions_per_week || 1, normalizedWeights.sessions_per_week);
        rationale.push({ type: "sessions_per_week", score: sessionsResult.score, detail: sessionsResult.detail });

        const totalScore = rationale.reduce((sum, r) => sum + r.score, 0);

        return { slot, score: Math.round(totalScore), rationale };
      });

      scoredSlots.sort((a, b) => b.score - a.score);
      const bestMatch = scoredSlots[0];

      if (!bestMatch || bestMatch.score === 0) {
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
        continue;
      }

      // Create proposed assignment
      const { error: insertError } = await supabase
        .from("proposed_assignments")
        .insert({
          intake_request_id: request.id,
          slot_id: bestMatch.slot.id,
          trainer_id: bestMatch.slot.trainer_id,
          confidence_score: bestMatch.score,
          rationale: bestMatch.rationale,
          status: "proposed",
        });

      if (insertError) {
        errors.push(`Failed to create proposal for ${request.id}: ${insertError.message}`);
        skipped++;
      } else {
        if (!slotAssignments[bestMatch.slot.id]) {
          slotAssignments[bestMatch.slot.id] = [];
        }
        slotAssignments[bestMatch.slot.id].push(request);

        await supabase
          .from("intake_requests")
          .update({ status: "proposed" })
          .eq("id", request.id);
        generated++;
      }
    }

    // ===== STEP 3: Fill gaps in trainer availability with empty 60-min slots =====
    if (trainerAvailability && trainerAvailability.length > 0) {
      console.log("Filling remaining trainer availability gaps with empty slots...");

      // Re-fetch cycle slots after matching to know which times are covered
      const { data: existingCycleSlots } = await supabase
        .from("availability_slots")
        .select("id, trainer_id, start_time, end_time")
        .eq("cyclus_id", cycleId);

      const fillerSlots: any[] = [];
      const DEFAULT_FILLER_DURATION = 60; // minutes

      for (const ta of trainerAvailability) {
        for (const window of ta.windows) {
          const dayIndex = WEEKDAYS.indexOf(window.day.toLowerCase());
          if (dayIndex === -1) continue;

          const [wStartH, wStartM] = window.start.split(":").map(Number);
          const [wEndH, wEndM] = window.end.split(":").map(Number);
          const windowStartMin = wStartH * 60 + (wStartM || 0);
          const windowEndMin = wEndH * 60 + (wEndM || 0);

          // Find the first occurrence of this weekday from effectiveStartDate
          let dayDate = new Date(effectiveStartDate);
          while (dayDate.getDay() !== dayIndex) {
            dayDate.setDate(dayDate.getDate() + 1);
          }

          // Get existing slots for this trainer on this day
          const trainerDaySlots = (existingCycleSlots || [])
            .filter(s => {
              if (s.trainer_id !== ta.trainerId) return false;
              const slotDate = new Date(s.start_time);
              return slotDate.getFullYear() === dayDate.getFullYear() &&
                     slotDate.getMonth() === dayDate.getMonth() &&
                     slotDate.getDate() === dayDate.getDate();
            })
            .map(s => ({
              startMin: new Date(s.start_time).getHours() * 60 + new Date(s.start_time).getMinutes(),
              endMin: new Date(s.end_time).getHours() * 60 + new Date(s.end_time).getMinutes(),
            }))
            .sort((a, b) => a.startMin - b.startMin);

          // Walk through the window in 60-min increments and fill gaps
          let cursor = windowStartMin;
          while (cursor + DEFAULT_FILLER_DURATION <= windowEndMin) {
            const cursorEnd = cursor + DEFAULT_FILLER_DURATION;

            // Check if this range overlaps with any existing slot
            const overlapsExisting = trainerDaySlots.some(s =>
              cursor < s.endMin && cursorEnd > s.startMin
            );

            if (!overlapsExisting) {
              const startDt = new Date(dayDate);
              startDt.setHours(Math.floor(cursor / 60), cursor % 60, 0, 0);
              const endDt = new Date(dayDate);
              endDt.setHours(Math.floor(cursorEnd / 60), cursorEnd % 60, 0, 0);

              fillerSlots.push({
                trainer_id: ta.trainerId,
                start_time: startDt.toISOString(),
                end_time: endDt.toISOString(),
                is_marked_full: false,
                is_public: false,
                is_recurring: false,
                cyclus_id: cycleId,
                max_participants: cycle.settings?.max_group_size || 4,
                min_participants: cycle.settings?.min_group_size || null,
                academy_profile_id: cycle.owner_type === "academy" ? cycle.owner_id : null,
                location_id: cycle.location_id || null,
              });
            }

            cursor += DEFAULT_FILLER_DURATION;
          }
        }
      }

      if (fillerSlots.length > 0) {
        const { error: fillerError } = await supabase
          .from("availability_slots")
          .insert(fillerSlots);

        if (fillerError) {
          console.error("Error creating filler slots:", fillerError);
        } else {
          console.log(`Created ${fillerSlots.length} empty filler slots to complete trainer agendas`);
          slotsCreated += fillerSlots.length;
        }
      }
    }

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
