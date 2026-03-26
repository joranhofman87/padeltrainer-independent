import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const {
      email,
      fullName,
      phone,
      birthDate,
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
      language,
      metadata,
    } = await req.json();

    if (!email || !fullName || !cycleId) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // Duplicate check: reject same email + cycle within 60 seconds (prevents double-clicks)
    const sixtySecondsAgo = new Date(Date.now() - 60 * 1000).toISOString();
    const { count: dupeCount } = await adminClient
      .from("intake_requests")
      .select("*", { count: "exact", head: true })
      .eq("email", email)
      .eq("cycle_id", cycleId)
      .gte("created_at", sixtySecondsAgo);

    if (dupeCount && dupeCount >= 1) {
      return new Response(
        JSON.stringify({ error: "duplicate_submission", message: "This registration was already submitted. Please wait a moment before trying again." }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // IP-based rate limit: max 15 submissions per hour per IP (catches automated spam)
    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (clientIp !== "unknown") {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count: ipCount } = await adminClient
        .from("intake_requests")
        .select("*", { count: "exact", head: true })
        .eq("metadata->>client_ip", clientIp)
        .gte("created_at", oneHourAgo);

      if (ipCount && ipCount >= 15) {
        return new Response(
          JSON.stringify({ error: "rate_limited", message: "Too many submissions. Please try again later." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Check if user already has a profile (existing user)
    let playerId: string | null = null;
    let guestPlayerId: string | null = null;

    const { data: existingProfile } = await adminClient
      .from("profiles")
      .select("id")
      .eq("email", email.toLowerCase())
      .maybeSingle();

    if (existingProfile) {
      // Existing user with profile — use their profile ID
      playerId = existingProfile.id;
    } else {
      // Guest: create or find a guest_players record
      // First get the cycle to determine the owner (academy/trainer/club)
      const { data: cycleForOwner } = await adminClient
        .from("cycles")
        .select("owner_type, owner_id")
        .eq("id", cycleId)
        .single();

      const guestData: Record<string, unknown> = {
        full_name: fullName,
        email: email.toLowerCase(),
        phone: phone || null,
        skill_rating: rating || null,
        rating_system: ratingSystem || "knltb",
        source: "intake_form",
      };

      // Link to academy or trainer based on cycle owner
      if (cycleForOwner) {
        if (cycleForOwner.owner_type === "academy") {
          guestData.academy_profile_id = cycleForOwner.owner_id;
        } else if (cycleForOwner.owner_type === "trainer") {
          guestData.trainer_id = cycleForOwner.owner_id;
        }
      }

      // Try to find existing guest by email + owner context
      let existingGuest = null;
      if (guestData.academy_profile_id) {
        const { data } = await adminClient
          .from("guest_players")
          .select("id")
          .eq("email", email.toLowerCase())
          .eq("academy_profile_id", guestData.academy_profile_id as string)
          .maybeSingle();
        existingGuest = data;
      } else if (guestData.trainer_id) {
        const { data } = await adminClient
          .from("guest_players")
          .select("id")
          .eq("email", email.toLowerCase())
          .eq("trainer_id", guestData.trainer_id as string)
          .maybeSingle();
        existingGuest = data;
      } else {
        const { data } = await adminClient
          .from("guest_players")
          .select("id")
          .eq("email", email.toLowerCase())
          .is("academy_profile_id", null)
          .is("trainer_id", null)
          .maybeSingle();
        existingGuest = data;
      }

      if (existingGuest) {
        guestPlayerId = existingGuest.id;
        // Update guest record with latest info
        await adminClient
          .from("guest_players")
          .update({
            full_name: fullName,
            phone: phone || null,
            skill_rating: rating || null,
            rating_system: ratingSystem || "knltb",
          })
          .eq("id", guestPlayerId);
      } else {
        const { data: newGuest, error: guestError } = await adminClient
          .from("guest_players")
          .insert(guestData)
          .select("id")
          .single();

        if (guestError) {
          console.error("Error creating guest player:", guestError);
          return new Response(
            JSON.stringify({ error: guestError.message }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        guestPlayerId = newGuest.id;
      }
    }

    // Insert intake request
    const { data: intakeData, error: intakeError } = await adminClient
      .from("intake_requests")
      .insert({
        cycle_id: cycleId,
        player_id: playerId,
        guest_player_id: guestPlayerId,
        full_name: fullName,
        email,
        phone: phone || null,
        birth_date: birthDate || null,
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
        metadata: { ...(metadata || {}), client_ip: clientIp },
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

    // Auto-follow (only for existing users with a profile)
    let cycleData: any = null;
    try {
      const { data: cycle } = await adminClient
        .from("cycles")
        .select("owner_type, owner_id, name, settings, start_date, end_date, enrollment_deadline, location_id")
        .eq("id", cycleId)
        .single();

      cycleData = cycle;

      if (cycle && playerId) {
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

    // Send registration confirmation email (non-blocking)
    if (RESEND_API_KEY && cycleData) {
      try {
        // Resolve owner name
        let ownerName = '';
        if (cycleData.owner_type === 'academy') {
          const { data: academy } = await adminClient
            .from("academy_profiles")
            .select("name")
            .eq("id", cycleData.owner_id)
            .single();
          ownerName = academy?.name || '';
        } else if (cycleData.owner_type === 'club') {
          const { data: club } = await adminClient
            .from("club_profiles")
            .select("location_id")
            .eq("id", cycleData.owner_id)
            .single();
          if (club?.location_id) {
            const { data: location } = await adminClient
              .from("locations")
              .select("name")
              .eq("id", club.location_id)
              .single();
            ownerName = location?.name || '';
          }
        } else if (cycleData.owner_type === 'trainer') {
          const { data: trainer } = await adminClient
            .from("trainer_profiles")
            .select("user_id")
            .eq("id", cycleData.owner_id)
            .single();
          if (trainer?.user_id) {
            const { data: profile } = await adminClient
              .from("profiles")
              .select("full_name")
              .eq("user_id", trainer.user_id)
              .single();
            ownerName = profile?.full_name || '';
          }
        }

        const settings = cycleData.settings || {};
        const confirmationText = settings.confirmation_email_text || '';

        // Resolve location name
        let cycleLocationName = '';
        if (cycleData.location_id) {
          const { data: locData } = await adminClient
            .from("locations")
            .select("name")
            .eq("id", cycleData.location_id)
            .single();
          cycleLocationName = locData?.name || '';
        }

        // Compute price lines for the email
        const cycleSettings = cycleData.settings || {};
        const cyclePriceTable = (cycleSettings as any).price_table || [];
        const cyclePricePerSession = (cycleData as any).price_per_session;
        const selectedOption = metadata?.selected_cyclus_option;
        const durationWeeks = metadata?.preferred_number_of_weeks || (() => {
          if (!cycleData.start_date || !cycleData.end_date) return null;
          return Math.max(1, Math.round(
            (new Date(cycleData.end_date).getTime() - new Date(cycleData.start_date).getTime()) / (7 * 24 * 60 * 60 * 1000)
          ));
        })();

        const standardAllowed = ((cycleSettings as any).lesson_types as string[] | undefined) || ['private', 'duo', 'group', 'group3', 'group4', 'kids'];
        const customLT = ((cycleSettings as any).custom_lesson_types as string[] | undefined) || [];
        const orderedLT = [...standardAllowed, ...customLT];

        const emailPriceLines: { label: string; perLesson: string; total: string }[] = [];
        const fmtPrice = (v: number) => `€${v.toFixed(2)}`;
        for (const lt of (lessonTypes || [])) {
          let perLesson: number | null = null;
          if (selectedOption) {
            perLesson = selectedOption.price_per_session;
          } else if (cyclePriceTable.length > 0) {
            const idx = orderedLT.indexOf(lt);
            const row = idx >= 0 && idx < cyclePriceTable.length ? cyclePriceTable[idx] : null;
            if (row) perLesson = row.price;
          }
          if (perLesson == null && cyclePricePerSession) perLesson = cyclePricePerSession;
          const total = perLesson && durationWeeks ? perLesson * durationWeeks : null;
          if (perLesson != null && perLesson > 0) {
            emailPriceLines.push({
              label: lt.charAt(0).toUpperCase() + lt.slice(1),
              perLesson: fmtPrice(perLesson),
              total: total != null ? fmtPrice(total) : '',
            });
          }
        }

        const sendRes = await fetch(`${supabaseUrl}/functions/v1/send-email`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({
            type: "intake_registration_confirmation",
            to: email,
            language: language || 'en',
            data: {
              playerName: fullName,
              cycleName: cycleData.name,
              ownerName,
              confirmationText,
              startDate: cycleData.start_date,
              endDate: cycleData.end_date,
              enrollmentDeadline: cycleData.enrollment_deadline,
              locationName: cycleLocationName || undefined,
              lessonTypes: lessonTypes || [],
              preferredDurationMinutes: preferredDurationMinutes || undefined,
              sessionsPerWeek: sessionsPerWeek || undefined,
              rating: rating || undefined,
              ratingSystem: ratingSystem || undefined,
              notes: notes || undefined,
              phone: phone || undefined,
              birthDate: birthDate || undefined,
              selectedPackageLabel: selectedOption?.label || undefined,
              selectedPackagePrice: selectedOption?.price_per_session || undefined,
              selectedDurationWeeks: durationWeeks || undefined,
              priceLines: emailPriceLines.length > 0 ? emailPriceLines : undefined,
            },
          }),
        });

        if (!sendRes.ok) {
          console.error("Registration confirmation email failed:", await sendRes.text());
        } else {
          console.log(`Registration confirmation email sent to ${email}`);
        }
      } catch (confErr) {
        console.error("Confirmation email failed (non-blocking):", confErr);
      }
    }

    // Non-blocking Slack notification
    try {
      await fetch(`${supabaseUrl}/functions/v1/slack-notify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${supabaseServiceKey}`,
        },
        body: JSON.stringify({
          event: "new_registration",
          data: {
            name: fullName,
            email,
            cycle: cycleData?.name || cycleId,
            flow: "guest",
            is_new_user: playerId ? "no" : "yes (guest)",
          },
        }),
      });
    } catch (_) {
      // Non-blocking
    }

    return new Response(
      JSON.stringify({ success: true, intakeRequest: intakeData }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("submit-guest-intake error:", err);

    // Non-blocking Slack error alert
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      await fetch(`${supabaseUrl}/functions/v1/slack-notify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${supabaseServiceKey}`,
        },
        body: JSON.stringify({
          event: "registration_error",
          data: {
            email: "unknown",
            error: err instanceof Error ? err.message : String(err),
            flow: "guest",
          },
        }),
      });
    } catch (_) {
      // Non-blocking
    }

    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
