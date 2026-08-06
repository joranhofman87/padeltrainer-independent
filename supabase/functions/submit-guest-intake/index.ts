import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { resolveRegistrationNameFields } from "../_shared/profileName.ts";
import { corsHeadersFor } from "../_shared/cors.ts";
import { sendRegistrationConfirmationEmail } from "../_shared/registration-confirmation-email.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";
import {
  mintEventRegistrationInvoice,
  resolveEffectivePaymentMethod,
  buildPayUrl,
  type RegistrationInvoiceCycle,
} from "../_shared/event-registration-invoice.ts";

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
  admin: SupabaseClient,
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
      paymentMethod,
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

    // Phone is mandatory on every public sign-up (registrations AND events) — the client
    // CycleApplicationForm already blocks an empty phone; this is the server-side backstop,
    // matching the create-guest-{slot,cyclus}-payment guards.
    if (typeof phone !== "string" || phone.trim() === "") {
      return invalidPayload("Field 'phone' is required", corsHeaders);
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // Resolve the FORM (registrations is standalone post-decouple). `cycleId` is the registration's
    // own id; fall back to the legacy source_cycle_id alias so old /register links + QR codes work.
    // GUARD: only an OPEN registration/event form may collect a sign-up.
    type RegistrationRow = {
      id: string;
      source_cycle_id: string | null;
      owner_type: string;
      owner_id: string;
      format: string;
      status: string;
      name: string;
      total_price: number | null;
      price_table: RegistrationInvoiceCycle["price_table"];
      currency: string | null;
      settings: Record<string, unknown> | null;
      start_date: string | null;
      end_date: string | null;
      location_id: string | null;
    };
    const REG_COLS = "id, source_cycle_id, owner_type, owner_id, format, status, name, total_price, price_table, currency, settings, start_date, end_date, location_id";
    let regRow: RegistrationRow | null =
      ((await adminClient.from("registrations").select(REG_COLS).eq("id", cycleId).maybeSingle()).data as RegistrationRow | null) ?? null;
    if (!regRow) {
      regRow = ((await adminClient.from("registrations").select(REG_COLS).eq("source_cycle_id", cycleId).maybeSingle()).data as RegistrationRow | null) ?? null;
    }
    if (!regRow) {
      return new Response(
        JSON.stringify({ error: "registration_not_found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (regRow.status !== "open") {
      return new Response(
        JSON.stringify({ error: "registration_not_open", message: "This registration form is not open for sign-ups." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const registrationId = regRow.id;

    // Duplicate check: reject same email + form within 60 seconds (prevents double-clicks)
    const sixtySecondsAgo = new Date(Date.now() - 60 * 1000).toISOString();
    const { count: dupeCount } = await adminClient
      .from("intake_requests")
      .select("*", { count: "exact", head: true })
      .eq("email", email)
      .eq("registration_id", registrationId)
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
      .select("id, full_name")
      .eq("email", email.toLowerCase())
      .maybeSingle();

    // Family rule: an email can be shared (a parent registering a child uses
    // the parent's address). Only attribute the intake to the existing account
    // when the NAME matches that account; a different name is a different
    // person and gets their own guest record instead.
    const normalizeName = (s: string | null | undefined) =>
      (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    const matchesExistingProfile = existingProfile &&
      (!existingProfile.full_name ||
        normalizeName(existingProfile.full_name) === normalizeName(nameFields.full_name));

    if (existingProfile && matchesExistingProfile) {
      // Existing user with profile — use their profile ID
      playerId = existingProfile.id;
    } else {
      // Guest: create or find a guest_players record. The form's owner comes from the registration.
      const cycleForOwner = { owner_type: regRow.owner_type, owner_id: regRow.owner_id };

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

      // Try to find existing guest by email + owner context. Emails are shared
      // within families (unique indexes were dropped for that), so there can be
      // several guests on one address — only reuse the one whose NAME matches;
      // a different name (sibling) gets a new record instead of overwriting.
      let guestQuery = adminClient
        .from("guest_players")
        .select("id, full_name")
        .eq("email", email.toLowerCase());
      if (guestData.academy_profile_id) {
        guestQuery = guestQuery.eq("academy_profile_id", guestData.academy_profile_id as string);
      } else if (guestData.trainer_id) {
        guestQuery = guestQuery.eq("trainer_id", guestData.trainer_id as string);
      } else {
        guestQuery = guestQuery.is("academy_profile_id", null).is("trainer_id", null);
      }
      const { data: guestCandidates } = await guestQuery;
      const existingGuest = (guestCandidates ?? []).find((g) =>
        normalizeName(g.full_name) === normalizeName(nameFields.full_name)
      ) ?? null;

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

    // Resolve effective location: prefer explicit form value, fall back to the form's location,
    // then a club owner's location.
    let effectiveLocationId: string | null = locationId || regRow.location_id || null;
    if (!effectiveLocationId && regRow.owner_type === "club") {
      const { data: club } = await adminClient
        .from("club_profiles")
        .select("location_id")
        .eq("id", regRow.owner_id)
        .maybeSingle();
      effectiveLocationId = club?.location_id || null;
    }

    // Insert intake request
    const { data: intakeData, error: intakeError } = await adminClient
      .from("intake_requests")
      .insert({
        registration_id: registrationId,
        cycle_id: null,
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

    // Auto-follow (only for existing users with a profile). Owner comes from the form. cycleData
    // carries the fields the confirmation email + admin-notify block read.
    const cycleData = {
      name: regRow.name,
      settings: regRow.settings,
      owner_type: regRow.owner_type,
      owner_id: regRow.owner_id,
    };
    try {
      if (playerId) {
        if (regRow.owner_type === "trainer") {
          await adminClient.from("trainer_followers").upsert(
            { player_id: playerId, trainer_id: regRow.owner_id, notify_new_availability: true },
            { onConflict: "player_id,trainer_id" }
          );
        } else if (regRow.owner_type === "club") {
          await adminClient.from("club_followers").upsert(
            { player_id: playerId, club_profile_id: regRow.owner_id, notify_new_availability: true },
            { onConflict: "player_id,club_profile_id" }
          );
        } else if (regRow.owner_type === "academy") {
          await adminClient.from("academy_followers").upsert(
            { player_id: playerId, academy_profile_id: regRow.owner_id, notify_new_availability: true },
            { onConflict: "player_id,academy_profile_id" }
          );
        }
      }
    } catch (followErr) {
      console.error("Auto-follow failed (non-blocking):", followErr);
    }

    const registration = regRow;
    // The object the payment path reads pricing + payment_methods from — the standalone form.
    // Its `id` is the registration id (there is no cycle shell).
    const formForPayment: RegistrationInvoiceCycle | null = {
      id: registration.id,
      owner_type: registration.owner_type,
      owner_id: registration.owner_id,
      name: registration.name,
      type: registration.format,
      total_price: registration.total_price ?? null,
      price_per_session: null,
      price_table: registration.price_table ?? null,
      currency: registration.currency ?? null,
      settings: (registration.settings as Record<string, unknown> | null) ?? null,
      // The training span drives (price × weeks) per-lesson pricing — carried on the form.
      start_date: registration.start_date ?? null,
      end_date: registration.end_date ?? null,
    };

    // Mint a payable invoice for paid event registrations and reuse the existing
    // Mollie invoice flow. Non-blocking: a mint failure never fails the
    // registration (it stays saved, just unpaid). `paymentInfo` feeds the
    // response (redirect URL) and the confirmation email (pay-link).
    let paymentInfo:
      | { invoiceId: string; publicToken: string; method: "online" | "cash"; payUrl: string | null }
      | { error: string }
      | null = null;
    let emailPayUrl: string | undefined;
    try {
      const method = formForPayment
        ? resolveEffectivePaymentMethod(
            (formForPayment.settings as Record<string, unknown> | null)?.payment_methods as
              | "online" | "cash" | "both" | undefined,
            paymentMethod,
          )
        : null;
      if (formForPayment && (formForPayment.type === "event" || formForPayment.type === "registration") && method) {
        const md = (metadata ?? undefined) as Record<string, unknown> | undefined;
        const selectedOption = md?.selected_cyclus_option as Record<string, unknown> | undefined;
        const result = await mintEventRegistrationInvoice(
          adminClient,
          formForPayment,
          {
            player_id: playerId,
            guest_player_id: guestPlayerId,
            player_name: nameFields.full_name,
          },
          method,
          {
            lessonTypes: lessonTypes ?? [],
            cyclusOptionLabel: typeof selectedOption?.label === "string" ? selectedOption.label : undefined,
            durationWeeks: md?.preferred_number_of_weeks,
          },
          registration?.id ?? null,
        );
        if (result.ok) {
          await adminClient
            .from("intake_requests")
            .update({ payment_method: method, invoice_id: result.invoiceId })
            .eq("id", intakeData.id);
          const payUrl = method === "online" ? buildPayUrl(result.slug, result.publicToken, language || "nl") : null;
          if (payUrl) emailPayUrl = payUrl;
          paymentInfo = { invoiceId: result.invoiceId, publicToken: result.publicToken, method, payUrl };
        } else {
          // e.g. no_price_set / business_profile_incomplete — surface to the form
          // without failing the registration.
          console.error(`Registration invoice not minted for intake ${intakeData.id}: ${result.reason}`);
          paymentInfo = { error: result.reason };
        }
      }
    } catch (payErr) {
      console.error("Registration invoice minting failed (non-blocking):", payErr);
      // Enrolled-but-uninvoiced: the registrant is in but the invoice mint crashed.
      await notifySlackEdgeError("submit-guest-intake", `registration invoice mint failed (non-blocking): ${payErr instanceof Error ? payErr.message : String(payErr)}`, { intakeId: intakeData?.id });
    }

    // Send registration confirmation email (non-blocking). Every config value
    // (lesson count, prices, cycle name, dates, owner, location) is resolved
    // server-side from the cycle's CURRENT config via the shared composer, so the
    // email matches the invoice and reflects academy edits immediately.
    if (RESEND_API_KEY && cycleData && intakeData) {
      try {
        // Build the email from the SAME pricing source the invoice mint used (the standalone form),
        // so the quoted price/lesson-count can never diverge from the invoice. The pricing fields are
        // spelled out (null, not undefined) to satisfy RegistrationEmailCycle.
        await sendRegistrationConfirmationEmail(adminClient, {
          ...cycleData,
          ...formForPayment,
          price_table: formForPayment.price_table ?? null,
          start_date: formForPayment.start_date ?? null,
          end_date: formForPayment.end_date ?? null,
          location_id: effectiveLocationId,
        }, intakeData, {
          payUrl: emailPayUrl,
          language,
        });
      } catch (confErr) {
        console.error("Confirmation email failed (non-blocking):", confErr);
        await notifySlackEdgeError("submit-guest-intake", `registration confirmation email failed (non-blocking): ${confErr instanceof Error ? confErr.message : String(confErr)}`, { intakeId: intakeData?.id });
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
      JSON.stringify({ success: true, intakeRequest: intakeData, payment: paymentInfo }),
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
