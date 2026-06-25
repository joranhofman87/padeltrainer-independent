// Mint (or re-fetch) the payable invoice for a LOGGED-IN player's event
// registration. The guest path mints inline in submit-guest-intake; this is the
// authenticated mirror. Both call the shared minter so behaviour is identical.
//
// Security: the caller may only pay for their OWN intake_request (player_id must
// resolve to the caller's profile). Service-role minting happens after that gate.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  mintEventRegistrationInvoice,
  resolveEffectivePaymentMethod,
  buildPayUrl,
  type RegistrationInvoiceCycle,
} from "../_shared/event-registration-invoice.ts";
import { sendRegistrationConfirmationEmail } from "../_shared/registration-confirmation-email.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Authentication required" }, 401);

    const admin = createClient(supabaseUrl, serviceKey);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await admin.auth.getUser(token);
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const { intakeRequestId, paymentMethod, language } = await req.json();
    if (!intakeRequestId) return json({ error: "intakeRequestId is required" }, 400);

    const { data: profile } = await admin
      .from("profiles")
      .select("id, full_name")
      .eq("user_id", user.id)
      .single();
    if (!profile) return json({ error: "No profile for caller" }, 403);

    const { data: intake } = await admin
      .from("intake_requests")
      .select("id, cycle_id, player_id, full_name, email, phone, birth_date, rating, rating_system, preferred_duration_minutes, sessions_per_week, location_id, notes, invoice_id, lesson_type, metadata")
      .eq("id", intakeRequestId)
      .single();
    if (!intake) return json({ error: "Registration not found" }, 404);
    if (intake.player_id !== profile.id) return json({ error: "Not your registration" }, 403);

    // Idempotent: if already minted, return that invoice's pay URL (if still payable).
    if (intake.invoice_id) {
      const { data: existing } = await admin
        .from("invoices")
        .select("id, public_token, status, academy_profile_id")
        .eq("id", intake.invoice_id)
        .single();
      if (existing) {
        let slug: string | null = null;
        if (existing.academy_profile_id) {
          const { data: a } = await admin
            .from("academy_profiles").select("slug").eq("id", existing.academy_profile_id).single();
          slug = a?.slug ?? null;
        }
        const payable = existing.status !== "paid" && existing.status !== "cancelled";
        return json({
          ok: true,
          alreadyMinted: true,
          invoiceId: existing.id,
          publicToken: existing.public_token,
          payUrl: payable ? buildPayUrl(slug, existing.public_token) : null,
          status: existing.status,
        });
      }
    }

    const { data: cycle } = await admin
      .from("cycles")
      .select("id, owner_type, owner_id, name, type, total_price, price_per_session, price_table, start_date, end_date, enrollment_deadline, location_id, currency, settings")
      .eq("id", intake.cycle_id)
      .single<RegistrationInvoiceCycle>();
    if (!cycle) return json({ error: "Cycle not found" }, 404);

    // Registration↔cycle split: prefer the canonical `registrations` form (resolved by
    // source_cycle_id) for pricing + payment config so paid registrations keep minting after the
    // source cycle becomes type='cyclus'; fall back to the legacy cycle pre-backfill.
    type RegistrationRow = {
      id: string;
      source_cycle_id: string;
      owner_type: string;
      owner_id: string;
      format: string;
      name: string;
      total_price: number | null;
      price_table: RegistrationInvoiceCycle["price_table"];
      currency: string | null;
      settings: Record<string, unknown> | null;
      start_date: string | null;
      end_date: string | null;
    };
    let registration: RegistrationRow | null = null;
    try {
      const { data } = await admin
        .from("registrations")
        .select("id, source_cycle_id, owner_type, owner_id, format, name, total_price, price_table, currency, settings, start_date, end_date")
        .eq("source_cycle_id", intake.cycle_id)
        .maybeSingle();
      registration = (data as RegistrationRow | null) ?? null;
    } catch (regErr) {
      console.error("registration lookup failed (non-blocking):", regErr);
    }
    const formForPayment: RegistrationInvoiceCycle = registration
      ? {
          id: registration.source_cycle_id,
          owner_type: registration.owner_type,
          owner_id: registration.owner_id,
          name: registration.name,
          type: registration.format,
          total_price: registration.total_price ?? null,
          price_per_session: null,
          price_table: registration.price_table ?? null,
          currency: registration.currency ?? null,
          settings: (registration.settings as Record<string, unknown> | null) ?? null,
          // The training span drives (price × weeks) per-lesson pricing — carried on the
          // registration so the charge stays correct after the source cycle becomes type='cyclus'.
          start_date: registration.start_date ?? null,
          end_date: registration.end_date ?? null,
        }
      : cycle;

    const method = resolveEffectivePaymentMethod(
      (formForPayment.settings as Record<string, unknown> | null)?.payment_methods as
        | "online" | "cash" | "both" | undefined,
      paymentMethod,
    );

    // Mint the payable invoice when the cycle is configured for payment. Selections
    // come from the stored intake (server-side); the pricing helper re-validates
    // them against the cycle's config before pricing.
    const md = (intake.metadata ?? undefined) as Record<string, unknown> | undefined;
    const selectedOption = md?.selected_cyclus_option as Record<string, unknown> | undefined;
    let result: Awaited<ReturnType<typeof mintEventRegistrationInvoice>> | null = null;
    let payUrl: string | null = null;
    if (method) {
      result = await mintEventRegistrationInvoice(
        admin,
        formForPayment,
        { player_id: profile.id, guest_player_id: null, player_name: intake.full_name || profile.full_name || "Onbekend" },
        method,
        {
          lessonTypes: Array.isArray(intake.lesson_type) ? intake.lesson_type : [],
          cyclusOptionLabel: typeof selectedOption?.label === "string" ? selectedOption.label : undefined,
          durationWeeks: md?.preferred_number_of_weeks,
        },
        registration?.id ?? null,
      );
      if (result.ok) {
        await admin
          .from("intake_requests")
          .update({ payment_method: method, invoice_id: result.invoiceId })
          .eq("id", intake.id);
        payUrl = method === "online" ? buildPayUrl(result.slug, result.publicToken) : null;
      }
    }

    // Server-authoritative confirmation email (non-blocking), sent once here for
    // EVERY outcome — free cycle, paid, or a mint hiccup — so a logged-in registrant
    // always gets an email built from the cycle's CURRENT config. An idempotent retry
    // returned earlier (intake.invoice_id set), so this never double-sends.
    try {
      await sendRegistrationConfirmationEmail(admin, cycle, intake, { payUrl, language });
    } catch (e) {
      console.error("Registration confirmation email failed (non-blocking):", String((e as Error)?.message ?? e));
    }

    if (!method) return json({ ok: false, reason: "no_payment_configured" });
    if (!result || !result.ok) return json({ ok: false, reason: result?.reason ?? "error", message: result?.message });

    return json({
      ok: true,
      method,
      invoiceId: result.invoiceId,
      publicToken: result.publicToken,
      payUrl,
      status: result.status,
    });
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    // Reachable from the public registration flow with no client to surface the failure —
    // alert so a money-path break (invoice never minted) is never silent.
    await notifySlackEdgeError("create-registration-invoice", message);
    return json({ error: "internal_error", message }, 500);
  }
});
