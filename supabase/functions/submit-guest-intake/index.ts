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
