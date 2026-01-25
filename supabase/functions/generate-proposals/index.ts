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
  rating: number | null;
  rating_system: string;
  lesson_type: string;
  preferred_days: string[];
  preferred_time_windows: TimeWindow[];
  preferred_trainer_ids: string[];
  location_id: string | null;
  sessions_per_week: number;
  created_at: string;
}

interface AvailabilitySlot {
  id: string;
  trainer_id: string;
  start_time: string;
  end_time: string;
  lesson_id: string | null;
  is_marked_full: boolean;
  location_id: string | null;
  cyclus_id: string | null;
  lessons?: {
    id: string;
    title: string;
    max_participants: number;
  } | null;
}

interface RequestBody {
  cycleId: string;
  weights?: ScoringWeights;
  ratingSpread?: RatingSpreadSettings;
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

function isWeekend(dateString: string): boolean {
  const day = getDayOfWeek(dateString);
  return day === "saturday" || day === "sunday";
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
  // Find the matching time window (should exist due to pre-filtering)
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

  // Should not reach here if pre-filtering is done correctly
  return { score: 0, detail: "No availability match" };
}

function calculateTrainerScore(
  slot: AvailabilitySlot,
  request: IntakeRequest,
  maxScore: number
): { score: number; detail: string } {
  const preferredIds = request.preferred_trainer_ids || [];
  
  if (preferredIds.length === 0) {
    // No preference, give partial score
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
  let trainerRangeScore = maxScore * 0.5; // Half for trainer range
  let groupSpreadScore = maxScore * 0.5; // Half for group spread
  const details: string[] = [];

  // If player has no rating, give partial score
  if (!request.rating) {
    return { 
      score: maxScore * 0.5, 
      detail: "No rating provided",
      breakdown: { trainerRange: trainerRangeScore * 0.5, groupSpread: groupSpreadScore * 0.5 }
    };
  }

  // Check 1: Trainer preference match
  if (trainerProfile?.preferred_min_rating !== null && 
      trainerProfile?.preferred_max_rating !== null &&
      trainerProfile?.preferred_rating_system === request.rating_system) {
    const inRange = request.rating >= trainerProfile.preferred_min_rating && 
                   request.rating <= trainerProfile.preferred_max_rating;
    if (inRange) {
      details.push(`Rating ${request.rating} in trainer range (${trainerProfile.preferred_min_rating}-${trainerProfile.preferred_max_rating})`);
    } else {
      // Player rating outside trainer's preferred range - significant penalty
      trainerRangeScore = 0;
      details.push(`Rating ${request.rating} outside trainer range (${trainerProfile.preferred_min_rating}-${trainerProfile.preferred_max_rating})`);
    }
  } else {
    // Trainer has no preference or different rating system
    details.push("Trainer has no rating preference");
  }

  // Check 2: Group compatibility (max spread) - only for group lessons
  if (maxRatingSpread !== null && 
      ratingSpreadSystem === request.rating_system &&
      request.lesson_type !== 'private' &&
      existingPlayersInSlot.length > 0) {
    
    // Get ratings from players in the same rating system
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
        // Spread exceeded - give zero score for group compatibility
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
  // Earlier registrations get higher scores
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
  // Players wanting fewer sessions get higher scores
  // 1 session = 100%, 7 sessions = ~14%
  const score = Math.round(maxScore * (1 / sessionsPerWeek));
  return {
    score,
    detail: `${sessionsPerWeek}× per week`,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { cycleId, weights: inputWeights, ratingSpread }: RequestBody = await req.json();

    if (!cycleId) {
      return new Response(
        JSON.stringify({ error: "cycleId is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Use provided weights or defaults
    const weights = inputWeights || DEFAULT_WEIGHTS;
    const maxRatingSpread = ratingSpread?.maxSpread ?? null;
    const ratingSpreadSystem = ratingSpread?.ratingSystem ?? null;

    // Normalize weights to percentages
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

    // Fetch intake requests with status 'new'
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

    // Get trainer IDs to include (from cycle settings or owner)
    const trainerIds: string[] = cycle.settings?.applicable_trainer_ids || [];
    if (cycle.owner_type === "trainer" && !trainerIds.includes(cycle.owner_id)) {
      trainerIds.push(cycle.owner_id);
    }

    // Fetch availability slots within cycle date range
    let slotsQuery = supabase
      .from("availability_slots")
      .select("*, lessons(id, title, max_participants)")
      .gte("start_time", cycle.start_date)
      .lte("start_time", cycle.end_date)
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

    // Fetch trainer profiles for rating preference checks
    const slotTrainerIds = [...new Set(slots.map(s => s.trainer_id))];
    const { data: trainerProfiles } = await supabase
      .from("trainer_profiles")
      .select("id, preferred_min_rating, preferred_max_rating, preferred_rating_system")
      .in("id", slotTrainerIds);

    // Create a map for quick lookup
    const trainerProfileMap: Record<string, TrainerProfile> = {};
    (trainerProfiles || []).forEach((tp) => {
      trainerProfileMap[tp.id] = tp as TrainerProfile;
    });

    // Fetch existing bookings to check capacity
    const slotIds = slots.map((s) => s.id);
    const { data: existingBookings, error: bookingsError } = await supabase
      .from("bookings")
      .select("slot_id")
      .in("slot_id", slotIds)
      .in("status", ["pending", "confirmed"]);

    if (bookingsError) throw bookingsError;

    // Count bookings per slot
    const bookingCounts: Record<string, number> = {};
    (existingBookings || []).forEach((b) => {
      bookingCounts[b.slot_id] = (bookingCounts[b.slot_id] || 0) + 1;
    });

    // Check for existing proposals to avoid duplicates
    const requestIds = requests.map((r) => r.id);
    const { data: existingProposals } = await supabase
      .from("proposed_assignments")
      .select("intake_request_id")
      .in("intake_request_id", requestIds)
      .eq("status", "proposed");

    const existingProposalRequestIds = new Set(
      (existingProposals || []).map((p) => p.intake_request_id)
    );

    let generated = 0;
    let skipped = 0;
    const errors: string[] = [];

    // Track which requests have been assigned to which slots (for group spread calculation)
    const slotAssignments: Record<string, IntakeRequest[]> = {};

    // Clear old skip reasons before regenerating
    const requestIdsToProcess = requests.map(r => r.id);
    await supabase
      .from("intake_requests")
      .update({ skip_reason: null })
      .in("id", requestIdsToProcess);

    // Process each request
    for (let i = 0; i < requests.length; i++) {
      const request = requests[i] as IntakeRequest;

      // Skip if already has a proposal
      if (existingProposalRequestIds.has(request.id)) {
        skipped++;
        continue;
      }

      // Filter slots - all available slots can be considered
      // Lesson type matching is flexible since slots may be generic
      const lessonTypeSlots = slots;

      if (lessonTypeSlots.length === 0) {
        skipped++;
        await supabase
          .from("intake_requests")
          .update({ skip_reason: "no_available_trainers" })
          .eq("id", request.id);
        errors.push(`No slots matching lesson type for request ${request.id}`);
        continue;
      }

      // STRICT AVAILABILITY FILTER: Only consider slots that match player's time windows
      const matchingSlots = lessonTypeSlots.filter((slot) => {
        // At least one time window must match
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
      // This is a pre-filter to detect rating_outside_trainer_range early
      if (request.rating && maxRatingSpread !== null) {
        const hasCompatibleTrainer = matchingSlots.some((slot) => {
          const trainerProfile = trainerProfileMap[slot.trainer_id];
          if (!trainerProfile?.preferred_min_rating || !trainerProfile?.preferred_max_rating) {
            return true; // Trainer has no preference, compatible
          }
          if (trainerProfile.preferred_rating_system !== request.rating_system) {
            return true; // Different rating systems, compatible
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

        // Time match
        const timeResult = calculateTimeScore(
          slot,
          request,
          normalizedWeights.time_match
        );
        rationale.push({
          type: "time_match",
          score: timeResult.score,
          detail: timeResult.detail,
        });

        // Trainer preference
        const trainerResult = calculateTrainerScore(
          slot,
          request,
          normalizedWeights.preferred_trainer
        );
        rationale.push({
          type: "preferred_trainer",
          score: trainerResult.score,
          detail: trainerResult.detail,
        });

        // Level compatibility - enhanced with trainer range and group spread checks
        const levelResult = calculateLevelScore(
          slot,
          request,
          trainerProfile,
          existingPlayersInSlot,
          maxRatingSpread,
          ratingSpreadSystem,
          normalizedWeights.level_compatible
        );
        rationale.push({
          type: "level_compatible",
          score: levelResult.score,
          detail: levelResult.detail,
        });

        // Priority bonus
        const priorityResult = calculatePriorityScore(
          i,
          requests.length,
          normalizedWeights.priority_bonus
        );
        rationale.push({
          type: "priority_bonus",
          score: priorityResult.score,
          detail: priorityResult.detail,
        });

        // Capacity
        const currentBookings = bookingCounts[slot.id] || 0;
        const maxParticipants = slot.lessons?.max_participants || 4;
        const capacityResult = calculateCapacityScore(
          currentBookings,
          maxParticipants,
          normalizedWeights.capacity_available
        );
        rationale.push({
          type: "capacity_available",
          score: capacityResult.score,
          detail: capacityResult.detail,
        });

        // Sessions per week scoring - players wanting fewer sessions get higher scores
        const sessionsResult = calculateSessionsScore(
          request.sessions_per_week || 1,
          normalizedWeights.sessions_per_week
        );
        rationale.push({
          type: "sessions_per_week",
          score: sessionsResult.score,
          detail: sessionsResult.detail,
        });

        const totalScore = rationale.reduce((sum, r) => sum + r.score, 0);

        return {
          slot,
          score: Math.round(totalScore),
          rationale,
        };
      });

      // Sort by score descending and pick the best
      scoredSlots.sort((a, b) => b.score - a.score);
      const bestMatch = scoredSlots[0];

      if (!bestMatch || bestMatch.score === 0) {
        skipped++;
        // Check specific skip reasons
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
        // Track this assignment for group spread calculations
        if (!slotAssignments[bestMatch.slot.id]) {
          slotAssignments[bestMatch.slot.id] = [];
        }
        slotAssignments[bestMatch.slot.id].push(request);

        // Update intake request status
        await supabase
          .from("intake_requests")
          .update({ status: "proposed" })
          .eq("id", request.id);
        generated++;
      }
    }

    return new Response(
      JSON.stringify({
        generated,
        skipped,
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
