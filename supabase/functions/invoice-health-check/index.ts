import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const log = (step: string, details?: Record<string, unknown>) => {
  console.log(`[INVOICE-HEALTH] ${step}`, details ? JSON.stringify(details) : "");
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const anomalies: { check: string; count: number; ids: string[] }[] = [];

    // 1. Invoices with total = 0 but not cancelled
    log("Checking zero-total invoices");
    const { data: zeroInvoices } = await supabase
      .from("invoices")
      .select("id")
      .eq("total", 0)
      .not("status", "eq", "cancelled")
      .not("status", "eq", "draft")
      .limit(50);

    if (zeroInvoices && zeroInvoices.length > 0) {
      anomalies.push({
        check: "zero_total_active",
        count: zeroInvoices.length,
        ids: zeroInvoices.map((i) => i.id),
      });
    }

    // 2. Invoices with empty booking_ids but status is sent/pending
    log("Checking empty booking_ids");
    const { data: emptyBookings } = await supabase
      .from("invoices")
      .select("id")
      .in("status", ["sent", "pending"])
      .or("booking_ids.is.null,booking_ids.eq.{}");

    if (emptyBookings && emptyBookings.length > 0) {
      anomalies.push({
        check: "empty_booking_ids",
        count: emptyBookings.length,
        ids: emptyBookings.map((i) => i.id),
      });
    }

    // 3. Overdue drafts (due_date in past, still draft)
    log("Checking overdue drafts");
    const { data: overdueDrafts } = await supabase
      .from("invoices")
      .select("id")
      .eq("status", "draft")
      .lt("due_date", new Date().toISOString().split("T")[0])
      .limit(50);

    if (overdueDrafts && overdueDrafts.length > 0) {
      anomalies.push({
        check: "overdue_drafts",
        count: overdueDrafts.length,
        ids: overdueDrafts.map((i) => i.id),
      });
    }

    // 4. Negative totals
    log("Checking negative totals");
    const { data: negativeInvoices } = await supabase
      .from("invoices")
      .select("id")
      .lt("total", 0)
      .not("status", "eq", "cancelled")
      .limit(50);

    if (negativeInvoices && negativeInvoices.length > 0) {
      anomalies.push({
        check: "negative_total",
        count: negativeInvoices.length,
        ids: negativeInvoices.map((i) => i.id),
      });
    }

    log("Health check complete", {
      totalAnomalies: anomalies.length,
      checks: anomalies.map((a) => `${a.check}: ${a.count}`),
    });

    // Send Slack alert if anomalies found
    if (anomalies.length > 0) {
      try {
        await supabase.functions.invoke("slack-notify", {
          body: {
            event: "edge_function_error",
            data: {
              function: "invoice-health-check",
              message: `Found ${anomalies.reduce((s, a) => s + a.count, 0)} invoice anomalies`,
              details: anomalies
                .map((a) => `${a.check}: ${a.count} (${a.ids.slice(0, 3).join(", ")}${a.count > 3 ? "..." : ""})`)
                .join("\n"),
            },
          },
          headers: {
            Authorization: `Bearer ${supabaseServiceKey}`,
          },
        });
      } catch (slackErr) {
        log("Failed to send Slack alert", { error: String(slackErr) });
      }
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
      }
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
