import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[VERIFY-MOLLIE-PAYMENT] ${step}`, details ? JSON.stringify(details) : "");
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const mollieApiKey = Deno.env.get("MOLLIE_API_KEY");
    if (!mollieApiKey) throw new Error("MOLLIE_API_KEY is not set");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { bookingId, paymentId } = await req.json();
    logStep("Verifying payment", { bookingId, paymentId });

    if (!bookingId && !paymentId) {
      throw new Error("Either bookingId or paymentId is required");
    }

    let molliePaymentId = paymentId;

    // If we have a booking ID but no payment ID, fetch from database
    if (bookingId && !paymentId) {
      const { data: booking, error: bookingError } = await supabase
        .from("bookings")
        .select("mollie_payment_id, payment_status")
        .eq("id", bookingId)
        .single();

      if (bookingError) {
        throw new Error(`Booking not found: ${bookingError.message}`);
      }

      // If already paid, return success immediately
      if (booking.payment_status === "paid") {
        logStep("Booking already marked as paid");
        return new Response(
          JSON.stringify({ paid: true, status: "paid" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      molliePaymentId = booking.mollie_payment_id;
    }

    if (!molliePaymentId) {
      throw new Error("No payment ID found for booking");
    }

    // Fetch payment status from Mollie
    const mollieResponse = await fetch(
      `https://api.mollie.com/v2/payments/${molliePaymentId}`,
      {
        headers: {
          "Authorization": `Bearer ${mollieApiKey}`,
        },
      }
    );

    if (!mollieResponse.ok) {
      const errorText = await mollieResponse.text();
      throw new Error(`Mollie API error: ${errorText}`);
    }

    const payment = await mollieResponse.json();
    logStep("Mollie payment status", { 
      paymentId: molliePaymentId, 
      status: payment.status 
    });

    const isPaid = payment.status === "paid";

    // Update booking if paid and we have a booking ID
    if (isPaid && bookingId) {
      const { error: updateError } = await supabase
        .from("bookings")
        .update({
          payment_status: "paid",
          status: "confirmed",
          mollie_transaction_id: payment.id,
          paid_at: new Date().toISOString(),
        })
        .eq("id", bookingId);

      if (updateError) {
        logStep("Warning: Failed to update booking", { error: updateError.message });
      } else {
        logStep("Booking updated to paid");
      }
    }

    return new Response(
      JSON.stringify({
        paid: isPaid,
        status: payment.status,
        amount: payment.amount,
        paidAt: payment.paidAt,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    return new Response(
      JSON.stringify({ error: message, paid: false }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
