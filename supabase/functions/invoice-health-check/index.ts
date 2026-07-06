import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { notifySlackEdge } from "../_shared/edge-slack.ts";
import {
  formatAnomalySlackDetails,
  isAllBookingsPaidMismatch,
  pushAnomaly,
  type InvoiceAnomaly,
} from "../_shared/invoice-health-checks.ts";
import { collectStuckCandidates, isPaidAtMollie, type StuckCandidateRow } from "../_shared/stuck-payments.ts";
import { resolveAccessToken } from "../_shared/mollie-token-resolution.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const log = (step: string, details?: Record<string, unknown>) => {
  console.log(`[INVOICE-HEALTH] ${step}`, details ? JSON.stringify(details) : "");
};

const thirtyMinutesAgo = () => new Date(Date.now() - 30 * 60 * 1000).toISOString();
const twentyFourHoursAgo = () => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  let cronLockHeld = false;

  try {
    // CRON-SF-02: single-flight — bail if another run holds the lock so two
    // overlapping firings don't re-run the anomaly scan and double-post the
    // Slack alert (read-only, so the gap is duplicate work + alert noise only).
    const { data: cronLocked } = await supabase.rpc("try_lock_cron_job", { p_job_name: "invoice-health-check" });
    if (cronLocked === false) {
      // Another run holds the lock → skip this duplicate firing.
      return new Response(
        JSON.stringify({ status: "skipped", reason: "locked" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    // Fail-open: only release if we actually acquired it (RPC error / not-yet-deployed
    // → proceed without the guard rather than halt the health check).
    cronLockHeld = cronLocked === true;

    const anomalies: InvoiceAnomaly[] = [];

    // 1. Invoices with total = 0 but not cancelled
    log("Checking zero-total invoices");
    const { data: zeroInvoices } = await supabase
      .from("invoices")
      .select("id, invoice_number")
      .eq("total", 0)
      .not("status", "eq", "cancelled")
      .not("status", "eq", "draft")
      .limit(50);
    pushAnomaly(anomalies, "zero_total_active", zeroInvoices ?? []);

    // 2. Invoices with empty booking_ids but status is sent/pending
    log("Checking empty booking_ids");
    const { data: emptyBookings } = await supabase
      .from("invoices")
      .select("id, invoice_number")
      .in("status", ["sent", "pending"])
      .or("booking_ids.is.null,booking_ids.eq.{}");
    pushAnomaly(anomalies, "empty_booking_ids", emptyBookings ?? []);

    // 3. Overdue drafts (due_date in past, still draft)
    log("Checking overdue drafts");
    const { data: overdueDrafts } = await supabase
      .from("invoices")
      .select("id, invoice_number")
      .eq("status", "draft")
      .lt("due_date", new Date().toISOString().split("T")[0])
      .limit(50);
    pushAnomaly(anomalies, "overdue_drafts", overdueDrafts ?? []);

    // 4. Negative totals
    log("Checking negative totals");
    const { data: negativeInvoices } = await supabase
      .from("invoices")
      .select("id, invoice_number")
      .lt("total", 0)
      .not("status", "eq", "cancelled")
      .limit(50);
    pushAnomaly(anomalies, "negative_total", negativeInvoices ?? []);

    // A. Mollie payment id present but invoice not paid after 30 minutes
    log("Checking mollie_payment_stuck");
    const { data: mollieStuck } = await supabase
      .from("invoices")
      .select("id, invoice_number")
      .not("mollie_payment_id", "is", null)
      .neq("status", "paid")
      .lt("updated_at", thirtyMinutesAgo())
      .limit(50);
    pushAnomaly(anomalies, "mollie_payment_stuck", mollieStuck ?? []);

    // B. Paid invoice missing paid_at
    log("Checking paid_missing_paid_at");
    const { data: paidMissingPaidAt } = await supabase
      .from("invoices")
      .select("id, invoice_number")
      .eq("status", "paid")
      .is("paid_at", null)
      .limit(50);
    pushAnomaly(anomalies, "paid_missing_paid_at", paidMissingPaidAt ?? []);

    // C. Sent invoice missing public_token
    log("Checking sent_missing_public_token");
    const { data: sentMissingToken } = await supabase
      .from("invoices")
      .select("id, invoice_number")
      .eq("status", "sent")
      .is("public_token", null)
      .limit(50);
    pushAnomaly(anomalies, "sent_missing_public_token", sentMissingToken ?? []);

    // D. Sent invoice missing sent_at after 24 hours
    log("Checking sent_missing_sent_at");
    const { data: sentMissingSentAt } = await supabase
      .from("invoices")
      .select("id, invoice_number")
      .eq("status", "sent")
      .is("sent_at", null)
      .lt("updated_at", twentyFourHoursAgo())
      .limit(50);
    pushAnomaly(anomalies, "sent_missing_sent_at", sentMissingSentAt ?? []);

    // E. All linked bookings paid but invoice not paid
    log("Checking bookings_paid_invoice_unpaid");
    const { data: unpaidWithBookings } = await supabase
      .from("invoices")
      .select("id, invoice_number, booking_ids")
      .neq("status", "paid")
      .not("status", "eq", "cancelled")
      .not("booking_ids", "is", null)
      .limit(100);

    const bookingsPaidMismatch: { id: string; invoice_number?: string | null }[] = [];
    for (const inv of unpaidWithBookings ?? []) {
      const bookingIds = inv.booking_ids as string[] | null;
      if (!bookingIds?.length) continue;
      const { data: bookings } = await supabase
        .from("bookings")
        .select("id, payment_status")
        .in("id", bookingIds);
      if (isAllBookingsPaidMismatch(bookingIds, bookings)) {
        bookingsPaidMismatch.push({ id: inv.id, invoice_number: inv.invoice_number });
        if (bookingsPaidMismatch.length >= 50) break;
      }
    }
    pushAnomaly(anomalies, "bookings_paid_invoice_unpaid", bookingsPaidMismatch);

    // F. LOST-WEBHOOK detector for DIRECT booking payments (guest slot/cart/cyclus +
    // BookLesson): a payment that Mollie says is PAID while NO local booking is.
    // Locally this state is indistinguishable from an abandoned checkout (the hold
    // sweep cancels both), so we ask Mollie — bounded to 25 payments/run, using the
    // SAME org-token resolution the webhook uses. Isolated: a failure here must not
    // kill the invoice checks above.
    try {
      log("Checking paid_at_mollie_not_locally");
      const fortyFiveMinAgo = new Date(Date.now() - 45 * 60 * 1000).toISOString();
      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      const { data: recent } = await supabase
        .from("bookings")
        .select("id, mollie_payment_id, payment_status, status, slot_id")
        .not("mollie_payment_id", "is", null)
        .gte("created_at", twoDaysAgo)
        .lt("created_at", fortyFiveMinAgo)
        .limit(1000);
      const candidates = collectStuckCandidates((recent ?? []) as StuckCandidateRow[], 25);
      const lostPaid: { id: string; detail: string }[] = [];
      let fetchFailures = 0;
      for (const cand of candidates) {
        // Resolve the org token off the first booking's slot (charge-org == confirm-org).
        if (!cand.slotId) continue;
        const { data: slot } = await supabase
          .from("availability_slots")
          .select("trainer_id, academy_profile_id")
          .eq("id", cand.slotId)
          .maybeSingle();
        if (!slot?.trainer_id) continue;
        const token = await resolveAccessToken(supabase, slot.trainer_id, slot.academy_profile_id);
        if (!token) continue;
        try {
          const resp = await fetch(`https://api.mollie.com/v2/payments/${cand.molliePaymentId}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!resp.ok) {
            fetchFailures++;
            continue;
          }
          const payment = await resp.json();
          if (isPaidAtMollie(payment?.status)) {
            lostPaid.push({
              id: cand.molliePaymentId,
              detail: `bookings ${cand.bookingIds.join(", ")} — Mollie says ${payment.status}, no local booking paid`,
            });
          }
        } catch (_) {
          fetchFailures++;
        }
      }
      if (fetchFailures > 0) log("Mollie fetches failed (skipped candidates)", { fetchFailures });
      // deliberately reuses the anomaly pipe: any hit is a P0 "money captured, guest
      // has nothing" — the alert names the payment ids for a manual verify/refund.
      pushAnomaly(anomalies, "paid_at_mollie_not_locally", lostPaid);
    } catch (stuckErr) {
      log("paid_at_mollie_not_locally check failed (non-fatal)", { error: String(stuckErr) });
    }

    // G. Fold in the payment reconciler (read-only report RPC, service-role callable
    // since 20260712100000). Graceful pre-migration: gate refusal / missing fn → skip.
    try {
      log("Running reconcile_payments");
      const { data: findings, error: reconcileErr } = await supabase.rpc("reconcile_payments", {
        _since: "7 days",
      });
      if (reconcileErr) {
        log("reconcile_payments unavailable (non-fatal)", { error: reconcileErr.message });
      } else {
        const rows = (findings ?? []) as Array<{ check_name: string; severity: string; entity_kind: string; entity_id: string; detail: unknown }>;
        const byCheck = new Map<string, { id: string; detail: string }[]>();
        for (const f of rows) {
          const list = byCheck.get(f.check_name) ?? [];
          list.push({ id: f.entity_id, detail: `${f.severity} ${f.entity_kind}: ${JSON.stringify(f.detail)}` });
          byCheck.set(f.check_name, list);
        }
        for (const [check, list] of byCheck) {
          pushAnomaly(anomalies, `reconcile:${check}`, list.slice(0, 50));
        }
      }
    } catch (reconcileErr) {
      log("reconcile_payments check failed (non-fatal)", { error: String(reconcileErr) });
    }

    log("Health check complete", {
      totalAnomalyChecks: anomalies.length,
      totalRows: anomalies.reduce((s, a) => s + a.count, 0),
      checks: anomalies.map((a) => `${a.check}: ${a.count}`),
    });

    if (anomalies.length > 0) {
      await notifySlackEdge("edge_function_error", {
        function: "invoice-health-check",
        message: `Found ${anomalies.reduce((s, a) => s + a.count, 0)} invoice anomalies`,
        details: formatAnomalySlackDetails(anomalies),
      });
    }

    return new Response(
      JSON.stringify({
        status: anomalies.length === 0 ? "healthy" : "anomalies_found",
        anomalies,
        checked_at: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("ERROR", { message });
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } finally {
    if (cronLockHeld) {
      try { await supabase.rpc("unlock_cron_job", { p_job_name: "invoice-health-check" }); } catch { /* best-effort; auto-releases on connection recycle */ }
    }
  }
});
