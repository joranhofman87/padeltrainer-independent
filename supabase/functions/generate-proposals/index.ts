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
}

interface TimeWindow {
  day?: string;
  preset?: "morning" | "afternoon" | "evening" | "weekend";
  start?: string;
  end?: string;
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
  preferred_trainer_id: string | null;
  location_id: string | null;
  created_at: string;
}

interface AvailabilitySlot {
  id: string;
  trainer_id: string;
  start_time: string;
  end_time: string;
  lesson_type: string;
  max_participants: number;
  location_id: string | null;
}

interface RequestBody {
  cycleId: string;
  weights?: ScoringWeights;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  time_match: 40,
  preferred_trainer: 20,
  level_compatible: 20,
  priority_bonus: 10,
  capacity_available: 10,
};

// Time window presets in hours (24h format) - for backward compatibility
const TIME_PRESETS = {
  morning: { start: 8, end: 12 },
  afternoon: { start: 12, end: 17 },
  evening: { start: 17, end: 21 },
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

  // New format: day + start + end (granular per-day availability)
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

  // Legacy format: preset (morning/afternoon/evening/weekend)
  if (timeWindow.preset) {
    if (timeWindow.preset === "weekend") {
      return isWeekend(slotStart);
    }
    const preset = TIME_PRESETS[timeWindow.preset];
    if (preset) {
      const slotHour = getHour(slotStart);
      return slotHour >= preset.start && slotHour < preset.end;
    }
  }

  // Legacy format: just day without specific times
  if (timeWindow.day && !timeWindow.start && !timeWindow.end) {
    return slotDay === timeWindow.day.toLowerCase();
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
    
    // If using new format with specific times
    if (matchingWindow.start && matchingWindow.end) {
      return {
        score: maxScore,
        detail: `${slotDay.charAt(0).toUpperCase() + slotDay.slice(1)} ${timeStr} within ${matchingWindow.start}-${matchingWindow.end}`,
      };
    }
    
    // Legacy format
    return {
      score: maxScore,
      detail: `${slotDay.charAt(0).toUpperCase() + slotDay.slice(1)} at ${timeStr} matches preferences`,
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
  if (!request.preferred_trainer_id) {
    // No preference, give partial score
    return { score: maxScore * 0.5, detail: "No trainer preference specified" };
  }

  if (slot.trainer_id === request.preferred_trainer_id) {
    return { score: maxScore, detail: "Matched with preferred trainer" };
  }

  return { score: 0, detail: "Not the preferred trainer" };
}

function calculateLevelScore(
  _slot: AvailabilitySlot,
  request: IntakeRequest,
  maxScore: number
): { score: number; detail: string } {
  // For now, we give full score as level matching requires additional slot metadata
  // In a full implementation, we'd check if the player's rating fits the slot's level range
  if (request.rating) {
    return {
      score: maxScore,
      detail: `Player rating ${request.rating} considered`,
    };
  }
  return { score: maxScore * 0.5, detail: "No rating provided" };
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { cycleId, weights: inputWeights }: RequestBody = await req.json();

    if (!cycleId) {
      return new Response(
        JSON.stringify({ error: "cycleId is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Use provided weights or defaults
    const weights = inputWeights || DEFAULT_WEIGHTS;

    // Normalize weights to percentages
    const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
    const normalizedWeights: ScoringWeights = totalWeight > 0
      ? {
          time_match: (weights.time_match / totalWeight) * 100,
          preferred_trainer: (weights.preferred_trainer / totalWeight) * 100,
          level_compatible: (weights.level_compatible / totalWeight) * 100,
          priority_bonus: (weights.priority_bonus / totalWeight) * 100,
          capacity_available: (weights.capacity_available / totalWeight) * 100,
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
      .select("*")
      .gte("start_time", cycle.start_date)
      .lte("start_time", cycle.end_date)
      .eq("is_booked", false);

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

    // Process each request
    for (let i = 0; i < requests.length; i++) {
      const request = requests[i] as IntakeRequest;

      // Skip if already has a proposal
      if (existingProposalRequestIds.has(request.id)) {
        skipped++;
        continue;
      }

      // Filter slots by lesson type match
      const lessonTypeSlots = slots.filter(
        (s) => s.lesson_type === request.lesson_type
      );

      if (lessonTypeSlots.length === 0) {
        skipped++;
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
        errors.push(`No slots match player availability for request ${request.id}`);
        continue;
      }

      // Score each slot
      const scoredSlots = matchingSlots.map((slot) => {
        const rationale: RationaleItem[] = [];

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

        // Level compatibility
        const levelResult = calculateLevelScore(
          slot,
          request,
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
        const capacityResult = calculateCapacityScore(
          currentBookings,
          slot.max_participants || 1,
          normalizedWeights.capacity_available
        );
        rationale.push({
          type: "capacity_available",
          score: capacityResult.score,
          detail: capacityResult.detail,
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
