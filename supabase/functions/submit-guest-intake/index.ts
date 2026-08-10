import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { resolveRegistrationNameFields } from "../_shared/profileName.ts";
import { corsHeadersFor } from "../_shared/cors.ts";
import { resolveAnonymousIdentity } from "../_shared/identity-continuity.ts";
import { buildIntentKey } from "../_shared/identity-intent.ts";
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * Exported so the identity decisions below can be driven through the REAL handler by tests. The
 * previous version of those decisions was covered only by a source grep, and a grep cannot tell you
 * that a returning registrant is now attributed to the account whose address they happen to share.
 */
export async function handleRequest(
  req: Request,
  deps: { adminClient?: SupabaseClient } = {},
): Promise<Response> {
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
      creationRequestId,
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

    // CONTACT, not identity (U2, owner 2026-08-09). A registration confirmation and, for a paid
    // form, a pay link both go to this address, so the FLOW requires one. The PLAYER may still have
    // none — the create command below takes NULL — and no address selects, merges or reuses an
    // identity here: this endpoint resolves nobody, it creates.
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

    // The submitter's own id for THIS attempt, and the only thing that can make the Player create
    // idempotent. Required rather than minted here — see the create call below.
    if (typeof creationRequestId !== "string" || !UUID_RE.test(creationRequestId)) {
      // A page loaded before this shipped will not send one. Say what fixes it, rather than
      // "invalid payload" — the registrant did nothing wrong and a refresh is the whole remedy.
      return new Response(
        JSON.stringify({
          error: "stale_client",
          message: "Ververs de pagina en probeer het opnieuw.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const adminClient = deps.adminClient ?? createClient(supabaseUrl, supabaseServiceKey);

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

    // ── WHO IS REGISTERING ───────────────────────────────────────────────────────────────────────
    //
    // This block used to answer that question by looking the submitted address up in `profiles` and
    // attributing the registration to whatever account came back, provided the name agreed. Two
    // mutable attributes, typed by an anonymous stranger into a public form, deciding which existing
    // human a registration — and the invoice minted from it — belongs to. It then did the same thing
    // a second time against `guest_players`, overwriting the matched row's details with whatever had
    // just been typed. U2 removes both (owner, 2026-08-09): attributes may propose a candidate for a
    // human to judge; they may never select, merge or reuse an identity.
    //
    // Nothing replaces them, because nothing here can. This endpoint has no trustworthy signal
    // about WHICH existing Player a submission belongs to, and the flow is built so it never needs
    // one: a signed-in person registering THEMSELF does not arrive here at all — the form calls
    // `submitIntakeRequest` with their own profile id, which is the carried UUID. What arrives here
    // is an anonymous submission, or a signed-in person registering SOMEBODY ELSE (a parent filling
    // it in for a child). Both are a Player this endpoint has no id for, so both create one through
    // the UUID-keyed command, which files a duplicate proposal when the new Player looks like one
    // the owner already has. A returning registrant with an account is proposed for a claim by
    // `mint_person_for_guest`, and joins their records by making that claim — a decision, made by
    // them, instead of a guess made here.
    //
    // Deliberately NOT done: reading the caller's token and attributing the registration to that
    // account. It would be wrong precisely in the case the form routes here for — the parent — and
    // it is the same bug in a new costume: attribution decided by the submitter's identity rather
    // than the registrant's.
    // Always NULL from here on. This endpoint attributes a submission to no existing account,
    // because it has no id for one — see the block above. The spelling stays so every row this
    // function writes still says explicitly which column it is not filling.
    const playerId: string | null = null;
    let guestPlayerId: string | null = null;

    {
      // The form's owner comes from the registration, never from the submission. Typed as a plain
      // string and narrowed by the guard below, so the narrowing stays local — narrowing
      // `regRow.owner_type` itself would tell the compiler the club branches further down are dead,
      // and they are not: a club-owned form still notifies its managers and resolves its location.
      const ownerType: string = regRow.owner_type;

      // A CLUB-owned form has no Player to create: `guest_players` requires a trainer or an academy
      // (`guest_players_owner_check`, 2026-02) and has no club column. This endpoint has therefore
      // never been able to register a guest on one — the insert violated the constraint and came
      // back as a generic 500. That is a real product gap, not something this change introduces;
      // what changes is that it is now named, and that the academy hears about it instead of the
      // registrant seeing "something went wrong".
      if (ownerType !== "academy" && ownerType !== "trainer") {
        console.error(`Registration ${registrationId} is owned by ${ownerType}: no Player can be created for it`);
        await notifySlackEdgeError(
          "submit-guest-intake",
          `registration ${registrationId} is ${ownerType}-owned; guest_players has no such scope, so the sign-up cannot be recorded`,
          { registrationId },
        );
        return new Response(
          JSON.stringify({
            error: "registration_unsupported",
            message: "This registration form cannot accept sign-ups. Please contact the organiser.",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Identity — before the Player is created or any intake row is written, resolve or demand
      // verification (U2 identity continuity). A returning address that collides with existing
      // candidates must prove control of the address first; we return here with NO side effect and
      // the form shows a generic "check your email". Only a proven, explicitly chosen person (or
      // "someone new") carries on.
      const identity = await resolveAnonymousIdentity(adminClient, {
        creationRequestId,
        owner: ownerType === "academy"
          ? { academyProfileId: regRow.owner_id }
          : { trainerId: regRow.owner_id },
        workflow: "intake",
        email: email.toLowerCase(),
        // the COMPLETE material intent (Codex r3 f1): intake carries far more than contact — birth
        // date, rating, lesson/day/time/duration/frequency preferences, trainer/location, notes,
        // consent, payment method and price-driving metadata are all written or invoiced after the
        // selection, so all are bound. A verified selection cannot be reused with a changed
        // application under a kept creation_request_id.
        payloadKey: buildIntentKey("intake", {
          registrationId,
          email: email.toLowerCase(),
          name: nameFields.full_name,
          phone: phone || "",
          birthDate: birthDate || null,
          rating: rating ?? null,
          ratingSystem: ratingSystem || null,
          lessonTypes: lessonTypes || [],
          preferredDays: preferredDays || [],
          preferredTimeWindows: preferredTimeWindows || [],
          preferredDurationMinutes: preferredDurationMinutes || null,
          sessionsPerWeek: sessionsPerWeek || null,
          preferredTrainerIds: preferredTrainerIds || [],
          locationId: locationId || null,
          notes: notes || null,
          consentGiven: consentGiven ?? null,
          paymentMethod: paymentMethod || null,
          metadata: metadata || null,
        }),
      });
      if (identity.status === "verify_required") {
        return new Response(
          JSON.stringify({ status: "verification_required" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      let personId: string | null;
      if (identity.status === "proceed_person") {
        // A verified returning Player: use their canonical id, create nothing.
        personId = identity.personId;
      } else {
        const { data: created, error: createError } = await adminClient.rpc("player_create_command", {
          // The client mints one id per submission attempt, so a retry is the SAME attempt. Minting
          // one here instead would make every retry a NEW attempt — the first request creates the
          // Player, its response is lost, and the resubmission creates a second one. The 60-second
          // duplicate window above is keyed on the address, which is exactly the kind of key U2 says
          // may not stand in for identity or for idempotency; it suppresses a double-click and
          // nothing beyond its window.
          _creation_request_id: creationRequestId,
          _owner_type: ownerType,
          _owner_id: regRow.owner_id,
          _full_name: nameFields.full_name,
          _email: email.toLowerCase(),
          _phone: phone || null,
          _first_name: nameFields.first_name,
          _last_name: nameFields.last_name,
          _skill_rating: rating ?? null,
          _rating_system: ratingSystem || null,
          _birth_date: birthDate || null,
          _source: "intake_form",
          _select_person_id: null,
          // A self-signup has no operator: the registrant is the only party present, and this
          // endpoint's own gates (form open, CORS allow-list, per-IP and per-recipient throttles) are
          // what stand in for one.
          _actor_user_id: null,
          _origin: "self_signup",
        });

        if (createError) {
          // PII hygiene (E-22): Postgres error `details` can embed submitted values — code + message.
          console.error("Error creating player:", createError.code, createError.message);
          return new Response(
            JSON.stringify({ error: "registration_failed", message: "Could not process your registration. Please try again later." }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        personId = (created as { person_id: string | null }).person_id;
      }
      // `intake_requests` still physically carries the legacy columns, so the row this endpoint
      // writes derives them from the canonical person through the authorized adapter — the only
      // place in this function where a legacy id exists.
      const { data: legacyRef, error: refError } = await adminClient.rpc("player_legacy_ref", {
        _person_id: personId,
        _owner_type: ownerType,
        _owner_id: regRow.owner_id,
      });
      if (refError) {
        console.error("Error deriving the legacy player reference:", refError.code, refError.message);
        return new Response(
          JSON.stringify({ error: "registration_failed", message: "Could not process your registration. Please try again later." }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const ref = legacyRef as { player_id: string | null; guest_player_id: string | null } | null;
      guestPlayerId = ref?.guest_player_id ?? null;
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
    const { data: insertedIntake, error: intakeError } = await adminClient
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
        // Idempotency key for this submission attempt (U2): a resumed submission now resolves to a
        // STABLE person, so without this a replay after the 60s window would write a second intake
        // and mint a second invoice. The partial unique index (registration_id, creation_request_id)
        // makes the duplicate impossible; the conflict below is treated as "already submitted".
        creation_request_id: creationRequestId,
      })
      .select()
      .single();

    const intakeData = insertedIntake;
    if (intakeError) {
      // A unique-violation on (registration_id, creation_request_id) is a REPLAY of this exact
      // attempt (Codex r1 f9). Answer idempotently and DO NOTHING ELSE — the run that won the intake
      // index is the one that mints the invoice and sends the confirmation, exactly once. A previous
      // revision "continued" here to complete a missing invoice, but that let a CONCURRENT loser
      // reach invoice minting and produce a SECOND payable invoice (Codex r3 f2). Completing an
      // invoice that failed to mint on a partial first run is the pre-existing best-effort
      // invoice-repair concern, not this endpoint's job, and is out of scope here.
      if (intakeError.code === "23505") {
        return new Response(
          JSON.stringify({ success: true, already_submitted: true }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
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
    // The auto-follow that stood here upserted a `*_followers` row for `playerId`. It was reachable
    // only through the email-and-name attribution this change removed, so it is not a feature being
    // dropped — it is a branch that can no longer be entered, and leaving it would read as though a
    // public form still resolves accounts. Signed-in players registering themselves never reach
    // this endpoint; that flow keeps whatever following it already does.

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
            is_new_user: "yes (guest)",
          },
        }),
      });
    } catch (_) {
      // Non-blocking
    }

    // A SAFE projection, not the row. Echoing `intakeData` handed an anonymous caller the whole
    // inserted record — `guest_player_id`, `player_id` and the metadata (client IP included). The
    // form reads `payment.payUrl` and nothing else; the id is kept for support correlation. No
    // legacy id may appear in an HTTP response (U2, owner correction 2026-08-09).
    return new Response(
      JSON.stringify({ success: true, intakeRequestId: intakeData.id, payment: paymentInfo }),
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
}

// Only bind a port when run as the entrypoint — importing for tests must not serve.
if (import.meta.main) Deno.serve((req) => handleRequest(req));
