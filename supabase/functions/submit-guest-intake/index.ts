import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveRegistrationNameFields } from "../_shared/profileName.ts";
import { corsHeadersFor } from "../_shared/cors.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

// Payload caps: this is a public endpoint, so reject oversized input before any DB work.
const MAX_SHORT_FIELD_LENGTH = 320;
const MAX_ARRAY_ITEMS = 50;
const MAX_NOTES_METADATA_BYTES = 10 * 1024;

const invalidPayload = (message: string, corsHeaders: Record<string, string>) =>
  new Response(
    JSON.stringify({ error: "invalid_payload", message }),
    { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );

/**
 * Best-effort per-key throttle on the shared rate_limits table (same pattern as
 * send-auth-email). Returns true when the call is allowed (under `max` within
 * `windowMin`), false otherwise. Fails OPEN on storage errors so a transient DB
 * hiccup never blocks a real registration.
 */
async function throttle(
  admin: ReturnType<typeof createClient>,
  identifier: string,
  max: number,
  windowMin: number,
): Promise<boolean> {
  const windowStart = new Date(Date.now() - windowMin * 60 * 1000);
  try {
    const { data: existing } = await admin
      .from("rate_limits")
      .select("id, request_count, window_start")
      .eq("identifier", identifier)
      .eq("endpoint", "submit-guest-intake")
      .maybeSingle();

    if (existing && new Date(existing.window_start) > windowStart) {
      if (existing.request_count >= max) return false;
      await admin
        .from("rate_limits")
        .update({ request_count: existing.request_count + 1 })
        .eq("id", existing.id);
      return true;
    }

    await admin
      .from("rate_limits")
      .upsert(
        { identifier, endpoint: "submit-guest-intake", request_count: 1, window_start: new Date().toISOString() },
        { onConflict: "identifier,endpoint" },
      );
    return true;
  } catch (_err) {
    return true; // fail open
  }
}

Deno.serve(async (req) => {
  // E-25: origin allow-list (defense in depth on this email-driving endpoint).
  // The intake form is an SPA route on the main domains — no custom academy
  // domains exist (DomainRouter: "No more hostname detection").
  const corsHeaders = corsHeadersFor(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const body = await req.json();
    const {
      email,
      firstName,
      lastName,
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
    } = body;

    // Type guards: a public caller can send any JSON shape; non-string name/email
    // fields would otherwise reach .trim()/.toLowerCase() and throw a raw 500.
    const shortTextFields: Record<string, unknown> = {
      email, firstName, lastName, fullName, phone, birthDate, ratingSystem, language, cycleId,
    };
    for (const [field, value] of Object.entries(shortTextFields)) {
      if (value != null && typeof value !== "string") {
        return invalidPayload(`Field '${field}' must be a string`, corsHeaders);
      }
      if (typeof value === "string" && value.length > MAX_SHORT_FIELD_LENGTH) {
        return invalidPayload(`Field '${field}' is too long`, corsHeaders);
      }
    }

    const arrayFields: Record<string, unknown> = {
      lessonTypes, preferredDays, preferredTimeWindows, preferredTrainerIds,
    };
    for (const [field, value] of Object.entries(arrayFields)) {
      if (value != null && !Array.isArray(value)) {
        return invalidPayload(`Field '${field}' must be an array`, corsHeaders);
      }
      if (Array.isArray(value) && value.length > MAX_ARRAY_ITEMS) {
        return invalidPayload(`Field '${field}' has too many items`, corsHeaders);
      }
    }

    if (notes != null && typeof notes !== "string") {
      return invalidPayload("Field 'notes' must be a string", corsHeaders);
    }
    if (metadata != null && (typeof metadata !== "object" || Array.isArray(metadata))) {
      return invalidPayload("Field 'metadata' must be an object", corsHeaders);
    }
    const notesMetadataBytes = JSON.stringify({ notes: notes ?? null, metadata: metadata ?? null }).length;
    if (notesMetadataBytes > MAX_NOTES_METADATA_BYTES) {
      return invalidPayload("Notes/metadata payload is too large", corsHeaders);
    }

    const nameFields = resolveRegistrationNameFields({
      firstName,
      lastName,
      fullName,
    });

    if (!email || !cycleId || !nameFields.full_name) {
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

    // IP-based rate limit: max 15 submissions per hour per IP (catches automated spam).
    // X-Forwarded-For: earlier hops are caller-controlled; the LAST entry is appended
    // by the trusted edge proxy, so key the throttle on that one.
    const forwardedHops = (req.headers.get("x-forwarded-for") || "")
      .split(",").map((hop) => hop.trim()).filter(Boolean);
    const clientIp = forwardedHops[forwardedHops.length - 1] || "unknown";
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

    // Recipient-based throttle: the IP key is spoofable, and each submission can
    // drive a confirmation email to a caller-supplied address — cap per recipient.
    const recipientOk = await throttle(adminClient, `recipient:${email.trim().toLowerCase()}`, 3, 60);
    if (!recipientOk) {
      return new Response(
        JSON.stringify({ error: "rate_limited", message: "Too many submissions for this email address. Please try again later." }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
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
        first_name: nameFields.first_name,
        last_name: nameFields.last_name,
        full_name: nameFields.full_name,
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
            first_name: nameFields.first_name,
            last_name: nameFields.last_name,
            full_name: nameFields.full_name,
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
          // PII hygiene (E-22): Postgres error `details` can embed inserted values
          // (e.g. the email in a unique-key violation) — log code + message only.
          console.error("Error creating guest player:", guestError.code, guestError.message);
          return new Response(
            JSON.stringify({ error: "registration_failed", message: "Could not process your registration. Please try again later." }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        guestPlayerId = newGuest.id;
      }
    }

    // Resolve effective location: prefer explicit form value, fall back to cycle's location
    let effectiveLocationId: string | null = locationId || null;
    if (!effectiveLocationId) {
      const { data: cycleLoc } = await adminClient
        .from("cycles")
        .select("location_id")
        .eq("id", cycleId)
        .maybeSingle();
      effectiveLocationId = cycleLoc?.location_id || null;
      // Fall back to club's location if cycle is owned by a club without its own location
      if (!effectiveLocationId) {
        const { data: cycleOwner } = await adminClient
          .from("cycles")
          .select("owner_type, owner_id")
          .eq("id", cycleId)
          .maybeSingle();
        if (cycleOwner?.owner_type === "club" && cycleOwner.owner_id) {
          const { data: club } = await adminClient
            .from("club_profiles")
            .select("location_id")
            .eq("id", cycleOwner.owner_id)
            .maybeSingle();
          effectiveLocationId = club?.location_id || null;
        }
      }
    }

    // Insert intake request
    const { data: intakeData, error: intakeError } = await adminClient
      .from("intake_requests")
      .insert({
        cycle_id: cycleId,
        player_id: playerId,
        guest_player_id: guestPlayerId,
        full_name: nameFields.full_name,
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
        location_id: effectiveLocationId,
        notes: notes || null,
        consent_given: consentGiven ?? true,
        metadata: { ...(metadata || {}), client_ip: clientIp },
        status: "new",
      })
      .select()
      .single();

    if (intakeError) {
      // PII hygiene (E-22): same as above — never log Postgres error `details`.
      console.error("Intake insert error:", intakeError.code, intakeError.message);
      return new Response(
        JSON.stringify({ error: "registration_failed", message: "Could not process your registration. Please try again later." }),
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

        // Compute price lines for the email.
        // E-21: `metadata` is caller-controlled JSON and cycle settings are free-form
        // JSONB — coerce every price/duration to a finite number within sane bounds
        // before any arithmetic or template interpolation; invalid values omit the
        // price line instead of mailing NaN/Infinity.
        const toBoundedNumber = (value: unknown, max = 10000): number | null => {
          const num = typeof value === "number" ? value
            : typeof value === "string" && value.trim() !== "" ? Number(value)
            : NaN;
          return Number.isFinite(num) && num >= 0 && num <= max ? num : null;
        };

        const settingsRecord = (cycleData.settings ?? {}) as Record<string, unknown>;
        const cyclePriceTable: { price?: unknown }[] = Array.isArray(settingsRecord.price_table)
          ? settingsRecord.price_table
          : [];
        const cyclePricePerSession = toBoundedNumber(cycleData.price_per_session);
        const selectedOption = metadata?.selected_cyclus_option;
        const selectedOptionPrice = toBoundedNumber(selectedOption?.price_per_session);
        const selectedOptionLabel = typeof selectedOption?.label === "string"
          ? selectedOption.label.slice(0, MAX_SHORT_FIELD_LENGTH)
          : undefined;
        const durationWeeks = toBoundedNumber(metadata?.preferred_number_of_weeks, 520) || (() => {
          if (!cycleData.start_date || !cycleData.end_date) return null;
          const weeks = Math.round(
            (new Date(cycleData.end_date).getTime() - new Date(cycleData.start_date).getTime()) / (7 * 24 * 60 * 60 * 1000)
          );
          return Number.isFinite(weeks) ? Math.max(1, weeks) : null;
        })();

        const standardAllowed = Array.isArray(settingsRecord.lesson_types)
          ? (settingsRecord.lesson_types as string[])
          : ['private', 'duo', 'group', 'group3', 'group4', 'kids'];
        const customLT = Array.isArray(settingsRecord.custom_lesson_types)
          ? (settingsRecord.custom_lesson_types as string[])
          : [];
        const orderedLT = [...standardAllowed, ...customLT];

        const emailPriceLines: { label: string; perLesson: string; total: string }[] = [];
        const fmtPrice = (v: number) => `€${v.toFixed(2)}`;
        for (const lt of (lessonTypes || [])) {
          // Array items are caller-controlled too; a non-string would throw on .charAt
          if (typeof lt !== "string") continue;
          let perLesson: number | null = null;
          if (selectedOption) {
            perLesson = selectedOptionPrice;
          } else if (cyclePriceTable.length > 0) {
            const idx = orderedLT.indexOf(lt);
            const row = idx >= 0 && idx < cyclePriceTable.length ? cyclePriceTable[idx] : null;
            if (row) perLesson = toBoundedNumber(row.price);
          }
          if (perLesson == null && cyclePricePerSession != null) perLesson = cyclePricePerSession;
          const total = perLesson != null && durationWeeks ? perLesson * durationWeeks : null;
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
              playerName: nameFields.full_name,
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
              selectedPackageLabel: selectedOptionLabel,
              selectedPackagePrice: selectedOptionPrice || undefined,
              selectedDurationWeeks: durationWeeks || undefined,
              priceLines: emailPriceLines.length > 0 ? emailPriceLines : undefined,
            },
          }),
        });

        if (!sendRes.ok) {
          // PII hygiene (E-22): the send-email error body can echo the recipient
          // address — log status + intake id only.
          console.error(`Registration confirmation email failed (status ${sendRes.status}) for intake ${intakeData?.id}`);
        } else {
          console.log(`Registration confirmation email sent for intake ${intakeData?.id}`);
        }
      } catch (confErr) {
        console.error("Confirmation email failed (non-blocking):", confErr);
      }
    }

    // Notify admins on new submission (opt-in via cycle settings; non-blocking)
    try {
      const settings = (cycleData?.settings || {}) as any;
      if (settings.notify_admin_on_submission && cycleData) {
        const recipients = new Set<string>();

        if (cycleData.owner_type === 'trainer') {
          const { data: trainer } = await adminClient
            .from('trainer_profiles').select('user_id').eq('id', cycleData.owner_id).single();
          if (trainer?.user_id) {
            const { data: prof } = await adminClient
              .from('profiles').select('email').eq('user_id', trainer.user_id).maybeSingle();
            if (prof?.email) recipients.add(prof.email.toLowerCase());
          }
        } else if (cycleData.owner_type === 'academy') {
          const { data: mgrs } = await adminClient
            .from('academy_managers').select('user_id').eq('academy_profile_id', cycleData.owner_id);
          const userIds = (mgrs || []).map((m: any) => m.user_id);
          if (userIds.length) {
            const { data: profs } = await adminClient
              .from('profiles').select('email').in('user_id', userIds);
            for (const p of profs || []) if (p.email) recipients.add(p.email.toLowerCase());
          }
        } else if (cycleData.owner_type === 'club') {
          const { data: mgrs } = await adminClient
            .from('club_managers').select('user_id').eq('club_profile_id', cycleData.owner_id);
          const userIds = (mgrs || []).map((m: any) => m.user_id);
          if (userIds.length) {
            const { data: profs } = await adminClient
              .from('profiles').select('email').in('user_id', userIds);
            for (const p of profs || []) if (p.email) recipients.add(p.email.toLowerCase());
          }
          if (recipients.size === 0) {
            const { data: club } = await adminClient
              .from('club_profiles').select('contact_email').eq('id', cycleData.owner_id).maybeSingle();
            if (club?.contact_email) recipients.add(club.contact_email.toLowerCase());
          }
        }

        const extra = String(settings.notify_admin_emails || '')
          .split(',').map((s) => s.trim().toLowerCase()).filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
        for (const e of extra) recipients.add(e);

        const recipientList = Array.from(recipients);
        if (recipientList.length > 0 && RESEND_API_KEY) {
          const detailPath = cycleData.owner_type === 'academy'
            ? `/app/academy/registrations/${cycleId}`
            : cycleData.owner_type === 'club'
              ? `/app/club/registrations/${cycleId}`
              : `/app/trainer/registrations/${cycleId}`;

          // E-22: allSettled so one failed send never drops the rest; log failures
          // by position, never by recipient address (PII hygiene).
          const sendResults = await Promise.allSettled(recipientList.map((to) =>
            fetch(`${supabaseUrl}/functions/v1/send-email`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${supabaseServiceKey}` },
              body: JSON.stringify({
                type: 'new_intake_registration_admin',
                to,
                language: 'en',
                data: {
                  playerName: nameFields.full_name,
                  playerEmail: email,
                  playerPhone: phone || undefined,
                  playerRating: rating || undefined,
                  ratingSystem: ratingSystem || undefined,
                  cycleName: cycleData.name,
                  lessonTypes: lessonTypes || [],
                  preferredDays: preferredDays || undefined,
                  preferredTimeWindows: preferredTimeWindows || undefined,
                  preferredDurationMinutes: preferredDurationMinutes || undefined,
                  sessionsPerWeek: sessionsPerWeek || undefined,
                  notes: notes || undefined,
                  detailUrl: detailPath,
                },
              }),
            }).then((res) => {
              if (!res.ok) throw new Error(`send-email responded ${res.status}`);
            })
          ));
          sendResults.forEach((result, idx) => {
            if (result.status === 'rejected') {
              console.error(`Admin notify send failed (recipient ${idx + 1}/${recipientList.length}):`, result.reason);
            }
          });
          const sentCount = sendResults.filter((r) => r.status === 'fulfilled').length;
          console.log(`Admin notification email sent to ${sentCount}/${recipientList.length} recipient(s)`);
        }
      }
    } catch (notifyErr) {
      console.error('Admin notification failed (non-blocking):', notifyErr);
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
            name: nameFields.full_name,
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

    // Public endpoint: never echo raw error text (full details stay in the logs above).
    return new Response(
      JSON.stringify({ error: "internal_error", message: "Something went wrong. Please try again later." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
