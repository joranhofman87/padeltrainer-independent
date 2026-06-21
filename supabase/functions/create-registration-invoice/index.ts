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

    const { intakeRequestId, paymentMethod } = await req.json();
    if (!intakeRequestId) return json({ error: "intakeRequestId is required" }, 400);

    const { data: profile } = await admin
      .from("profiles")
      .select("id, full_name")
      .eq("user_id", user.id)
      .single();
    if (!profile) return json({ error: "No profile for caller" }, 403);

    const { data: intake } = await admin
      .from("intake_requests")
      .select("id, cycle_id, player_id, full_name, invoice_id")
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
      .select("id, owner_type, owner_id, name, type, total_price, price_per_session, currency, settings")
      .eq("id", intake.cycle_id)
      .single<RegistrationInvoiceCycle>();
    if (!cycle) return json({ error: "Cycle not found" }, 404);

    const method = resolveEffectivePaymentMethod(
      (cycle.settings as Record<string, unknown> | null)?.payment_methods as
        | "online" | "cash" | "both" | undefined,
      paymentMethod,
    );
    if (!method) return json({ ok: false, reason: "no_payment_configured" });

    const result = await mintEventRegistrationInvoice(
      admin,
      cycle,
      { player_id: profile.id, guest_player_id: null, player_name: intake.full_name || profile.full_name || "Onbekend" },
      method,
    );

    if (!result.ok) return json({ ok: false, reason: result.reason, message: result.message });

    await admin
      .from("intake_requests")
      .update({ payment_method: method, invoice_id: result.invoiceId })
      .eq("id", intake.id);

    return json({
      ok: true,
      method,
      invoiceId: result.invoiceId,
      publicToken: result.publicToken,
      payUrl: method === "online" ? buildPayUrl(result.slug, result.publicToken) : null,
      status: result.status,
    });
  } catch (e) {
    return json({ error: "internal_error", message: String((e as Error)?.message ?? e) }, 500);
  }
});
