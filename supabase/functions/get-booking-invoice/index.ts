import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const log = (step: string, details?: Record<string, unknown>) =>
  console.log(`[GET-BOOKING-INVOICE] ${step}`, details ? JSON.stringify(details) : "");

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const { bookingId } = await req.json();
    if (!bookingId || typeof bookingId !== "string") {
      return new Response(JSON.stringify({ error: "Missing bookingId" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify booking is paid
    const { data: booking, error: bookingErr } = await supabase
      .from("bookings")
      .select("id, payment_status")
      .eq("id", bookingId)
      .maybeSingle();

    if (bookingErr || !booking) {
      log("Booking not found", { bookingId, err: bookingErr?.message });
      return new Response(JSON.stringify({ error: "Booking not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (booking.payment_status !== "paid") {
      return new Response(JSON.stringify({ error: "Booking not paid", ready: false }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Find the invoice linked to this booking (booking_ids is uuid[])
    const { data: invoices, error: invErr } = await supabase
      .from("invoices")
      .select("id, invoice_number, pdf_url, status")
      .contains("booking_ids", [bookingId])
      .neq("status", "draft")
      .order("created_at", { ascending: false })
      .limit(1);

    if (invErr) {
      log("Invoice lookup failed", { err: invErr.message });
      return new Response(JSON.stringify({ error: "Invoice lookup failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const invoice = invoices?.[0];
    if (!invoice) {
      return new Response(JSON.stringify({ ready: false }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Always regenerate to get a fresh signed URL (existing pdf_url may be expired)
    const { data: genData, error: genErr } = await supabase.functions.invoke("generate-invoice", {
      body: { invoiceId: invoice.id },
      headers: { Authorization: `Bearer ${serviceKey}` },
    });

    if (genErr || !genData?.pdfUrl) {
      log("generate-invoice failed", { err: genErr?.message, hasPdf: !!genData?.pdfUrl });
      // Fallback: return stored pdf_url if any
      if (invoice.pdf_url) {
        return new Response(
          JSON.stringify({
            ready: true,
            pdfUrl: invoice.pdf_url,
            invoiceNumber: invoice.invoice_number,
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ error: "Failed to generate invoice PDF" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        ready: true,
        pdfUrl: genData.pdfUrl,
        invoiceNumber: invoice.invoice_number,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
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
