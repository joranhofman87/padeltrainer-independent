import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { notifySlackEdge } from "../_shared/edge-slack.ts";
import {
  formatAnomalySlackDetails,
  isAllBookingsPaidMismatch,
  pushAnomaly,
  type InvoiceAnomaly,
} from "../_shared/invoice-health-checks.ts";

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

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

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
  }
});
