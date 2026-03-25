import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const EMAIL_LOGO = `<div style="text-align: center; margin-bottom: 24px;"><img src="https://padeltrainer.ai/logo-dark.png" alt="PadelTrainer.ai" width="220" height="40" style="max-width: 220px; height: auto;" /></div>`;
const BRAND_ORANGE = "#f45d25";

function getWelcomeEmailTemplate(userName: string, actionLink: string) {
  const baseStyle = `font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;`;
  const buttonStyle = `background: ${BRAND_ORANGE}; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;`;

  return {
    subject: "Complete your account - PadelTrainer 🎾",
    html: `
      <div style="${baseStyle}">
        ${EMAIL_LOGO}
        <h2 style="color: #333;">Thanks for registering!</h2>
        <p>Hi ${userName},</p>
        <p>Your registration has been submitted successfully. Set a password to access your account and track your registration status.</p>
        <p style="text-align: center; margin: 30px 0;">
          <a href="${actionLink}" style="${buttonStyle}">Set Your Password</a>
        </p>
        <p style="color: #666; font-size: 14px;">
          If you didn't register for a padel training, you can safely ignore this email.
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
        <p style="color: #999; font-size: 12px; text-align: center;">
          © ${new Date().getFullYear()} PadelTrainer.ai - Find your perfect padel trainer
        </p>
      </div>
    `,
  };
}

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

    // Check if user already exists
    let userId: string;
    let isNewUser = false;
    const { data: existingUsers } = await adminClient.auth.admin.listUsers();
    const existingUser = existingUsers?.users?.find(
      (u: any) => u.email?.toLowerCase() === email.toLowerCase()
    );

    if (existingUser) {
      userId = existingUser.id;
    } else {
      // Create user with random password (user will set their own via email)
      const randomPassword = crypto.randomUUID() + crypto.randomUUID();
      const { data: newUser, error: createError } = await adminClient.auth.admin.createUser({
        email,
        password: randomPassword,
        email_confirm: true,
        user_metadata: { full_name: fullName },
      });

      if (createError) {
        console.error("Error creating user:", createError);
        return new Response(
          JSON.stringify({ error: createError.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      userId = newUser.user.id;
      isNewUser = true;

      // Wait briefly for the profile trigger to fire
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Assign player role (upsert to avoid duplicates)
    await adminClient
      .from("user_roles")
      .upsert(
        { user_id: userId, role: "player" },
        { onConflict: "user_id,role" }
      );

    // Update profile with phone/rating/birth_date if provided
    const profileUpdates: Record<string, unknown> = {};
    if (phone) profileUpdates.phone = phone;
    if (birthDate) profileUpdates.birth_date = birthDate;
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

    // Insert intake request
    const { data: intakeData, error: intakeError } = await adminClient
      .from("intake_requests")
      .insert({
        cycle_id: cycleId,
        player_id: playerId,
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
        metadata: metadata || {},
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
    let cycleData: any = null;
    try {
      const { data: cycle } = await adminClient
        .from("cycles")
        .select("owner_type, owner_id, name, settings, start_date, end_date, enrollment_deadline, location_id")
        .eq("id", cycleId)
        .single();

      cycleData = cycle;

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

    // Send "Complete your account" email for new users (non-blocking)
    if (isNewUser && RESEND_API_KEY) {
      try {
        // Generate a password recovery link so user can set their password
        const { data: linkData, error: linkError } = await adminClient.auth.admin.generateLink({
          type: "recovery",
          email,
          options: {
            redirectTo: "https://padeltrainer.ai/app/auth",
          },
        });

        if (linkError) {
          console.error("Error generating recovery link:", linkError);
        } else {
          const actionLink = linkData.properties.action_link;
          const emailContent = getWelcomeEmailTemplate(fullName, actionLink);

          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${RESEND_API_KEY}`,
            },
            body: JSON.stringify({
              from: "PadelTrainer.ai <noreply@app.padeltrainer.ai>",
              to: [email],
              subject: emailContent.subject,
              html: emailContent.html,
            }),
          });

          if (!res.ok) {
            console.error("Resend API error:", await res.text());
          } else {
            console.log(`Welcome email sent to ${email}`);
          }
        }
      } catch (emailErr) {
        console.error("Welcome email failed (non-blocking):", emailErr);
      }
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

        // Invoke send-email edge function using service role
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

    // Non-blocking Slack notification for successful guest registration
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
          event: "new_registration",
          data: {
            name: fullName,
            email,
            cycle: cycleData?.name || cycleId,
            flow: "guest",
            is_new_user: isNewUser ? "yes" : "no",
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
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
