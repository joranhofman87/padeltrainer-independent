/**
 * ABC-23 §4 — the ONE authenticated boundary for manual ("we received it out of band") invoice
 * settlement.
 *
 * It replaces browser-side settlement, which flipped `invoices.status='paid'` first and synced
 * bookings second, from a client that could be interrupted between the two writes — leaving a
 * paid invoice with unpaid seats and no retry that could repair it.
 *
 * Authorization is unchanged and is evaluated under the CALLER's JWT via
 * can_settle_invoice_manually, which mirrors the invoices UPDATE policies exactly. Only after
 * that check does this function use the service role, and then solely to invoke
 * settle_paid_bookings. The service role never stands in for the caller's authority.
 *
 * No Mollie id is invented: this settles with source 'manual', so no provider column is written.
 * Retries are stable — a second call finds the bookings already paid and returns zero first
 * transitions, so nothing fires twice and no authority is widened.
 */
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { corsHeaders, requireUser } from "../_shared/auth.ts";
import { settlePaidBookings, settlementLogContext, isHardRefusal } from "../_shared/settlement.ts";

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[SETTLE-INVOICE-MANUAL] ${step}`, details ? JSON.stringify(details) : "");
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authResult = await requireUser(req);
    if (authResult instanceof Response) return authResult;
    // A service-role token carries no user identity, so it cannot satisfy a user-scoped
    // authorization check. Manual settlement is an act by a person.
    if (authResult.isServiceRole) return json({ error: "Forbidden" }, 403);

    const body = await req.json().catch(() => ({})) as { invoiceId?: unknown };
    const invoiceId = typeof body.invoiceId === "string" ? body.invoiceId : "";
    if (!invoiceId) return json({ error: "invoiceId is required", settled: false }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) throw new Error("Supabase environment is not configured");

    // ── authorization: the caller's own JWT, the caller's own RLS-equivalent gate ───────────
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
      auth: { persistSession: false },
    });
    const { data: allowed, error: gateError } = await userClient.rpc("can_settle_invoice_manually", {
      _invoice_id: invoiceId,
    });
    if (gateError) {
      logStep("Authorization check failed", { error: gateError.message });
      return json({ error: "Authorization check failed", settled: false }, 500);
    }
    if (allowed !== true) {
      // Same answer for "not yours" and "does not exist" — the gate must not confirm that an
      // invoice id is real to someone who may not settle it.
      logStep("Refused", { invoiceId, userId: authResult.user.id });
      return json({ error: "Forbidden", settled: false }, 403);
    }

    // ── settlement: service role, single authority, one transaction ─────────────────────────
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const { data: invoice, error: readError } = await admin
      .from("invoices")
      .select("booking_ids")
      .eq("id", invoiceId)
      .single();
    if (readError) {
      logStep("Invoice read failed", { error: readError.message });
      return json({ error: "Invoice read failed", settled: false }, 500);
    }
    const bookingIds = ((invoice?.booking_ids ?? []) as string[]).filter(Boolean);

    const outcome = await settlePaidBookings(admin, {
      source: "manual_invoice",
      bookingIds,
      // Manual settlement has no provider payment. The empty string is not an identifier and is
      // never written anywhere: settlement source 'manual' suppresses every provider column.
      providerPaymentId: "",
      providerTransactionId: null,
      invoiceId,
      settlementSource: "manual",
    });
    logStep("Settlement applied", { invoiceId, ...settlementLogContext(outcome) });

    if (outcome.refusalReason) {
      const terminal = isHardRefusal(outcome.refusalReason);
      return json(
        { settled: false, refusalReason: outcome.refusalReason, invoicePaid: false },
        terminal ? 409 : 500,
      );
    }

    return json({
      settled: true,
      invoicePaid: true,
      invoicePaidNow: outcome.invoicePaidNow,
      confirmedPaid: outcome.confirmedPaid,
      paidNoSeat: outcome.paidNoSeat,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    return json({ error: message, settled: false }, 500);
  }
});
