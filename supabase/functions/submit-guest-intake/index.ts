import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const {
      userId,
      email,
      fullName,
      phone,
      rating,
      ratingSystem,
      cycleId,
      lessonTypes,
      preferredDays,
      preferredTimeWindows,
      preferredDurationMinutes,
      sessionsPerWeek,
      preferredTrainerIds,
      locationId,
      notes,
      consentGiven,
    } = await req.json();

    if (!userId || !email || !fullName || !cycleId) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // Assign player role (upsert to avoid duplicates)
    await adminClient
      .from("user_roles")
      .upsert(
        { user_id: userId, role: "player" },
        { onConflict: "user_id,role" }
      );

    // Update profile with phone/rating if provided
    const profileUpdates: Record<string, unknown> = {};
    if (phone) profileUpdates.phone = phone;
    if (rating) {
      profileUpdates.skill_rating = rating;
      profileUpdates.rating_system = ratingSystem || "knltb";
    }
    if (Object.keys(profileUpdates).length > 0) {
      await adminClient
        .from("profiles")
        .update(profileUpdates)
        .eq("user_id", userId);
    }

    // Get profile ID
    const { data: profileData, error: profileError } = await adminClient
      .from("profiles")
      .select("id")
      .eq("user_id", userId)
      .single();

    if (profileError || !profileData) {
      return new Response(
        JSON.stringify({ error: "Profile not found" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const playerId = profileData.id;

    // Rate limiting: max 3 per hour per email
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await adminClient
      .from("intake_requests")
      .select("*", { count: "exact", head: true })
      .eq("email", email)
      .gte("created_at", oneHourAgo);

    if (count && count >= 3) {
      return new Response(
        JSON.stringify({ error: "Too many applications submitted. Please try again later." }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Insert intake request
    const { data: intakeData, error: intakeError } = await adminClient
      .from("intake_requests")
      .insert({
        cycle_id: cycleId,
        player_id: playerId,
        full_name: fullName,
        email,
        phone: phone || null,
        rating: rating || null,
        rating_system: ratingSystem || "knltb",
        lesson_type: lessonTypes || [],
        preferred_days: preferredDays || [],
        preferred_time_windows: preferredTimeWindows || [],
        preferred_duration_minutes: preferredDurationMinutes || 60,
        sessions_per_week: sessionsPerWeek || 1,
        preferred_trainer_ids: preferredTrainerIds || [],
        location_id: locationId || null,
        notes: notes || null,
        consent_given: consentGiven ?? true,
        status: "new",
      })
      .select()
      .single();

    if (intakeError) {
      console.error("Intake insert error:", intakeError);
      return new Response(
        JSON.stringify({ error: intakeError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Auto-follow and add to student list (non-blocking)
    try {
      const { data: cycle } = await adminClient
        .from("cycles")
        .select("owner_type, owner_id")
        .eq("id", cycleId)
        .single();

      if (cycle) {
        if (cycle.owner_type === "trainer") {
          await adminClient.from("trainer_followers").upsert(
            { player_id: playerId, trainer_id: cycle.owner_id, notify_new_availability: true },
            { onConflict: "player_id,trainer_id" }
          );
        } else if (cycle.owner_type === "club") {
          await adminClient.from("club_followers").upsert(
            { player_id: playerId, club_profile_id: cycle.owner_id, notify_new_availability: true },
            { onConflict: "player_id,club_profile_id" }
          );
        } else if (cycle.owner_type === "academy") {
          await adminClient.from("academy_followers").upsert(
            { player_id: playerId, academy_profile_id: cycle.owner_id, notify_new_availability: true },
            { onConflict: "player_id,academy_profile_id" }
          );
        }
      }
    } catch (followErr) {
      console.error("Auto-follow failed (non-blocking):", followErr);
    }

    return new Response(
      JSON.stringify({ success: true, intakeRequest: intakeData }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("submit-guest-intake error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
