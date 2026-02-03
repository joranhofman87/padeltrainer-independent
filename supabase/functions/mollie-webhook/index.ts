import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[MOLLIE-WEBHOOK] ${step}`, details ? JSON.stringify(details) : "");
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

    // Mollie sends payment ID in the body
    const formData = await req.formData();
    const paymentId = formData.get("id") as string;

    if (!paymentId) {
      logStep("No payment ID in webhook");
      return new Response("OK", { status: 200 });
    }

    logStep("Webhook received", { paymentId });

    // Fetch payment details from Mollie
    const mollieResponse = await fetch(`https://api.mollie.com/v2/payments/${paymentId}`, {
      headers: {
        "Authorization": `Bearer ${mollieApiKey}`,
      },
    });

    if (!mollieResponse.ok) {
      const errorText = await mollieResponse.text();
      throw new Error(`Failed to fetch payment: ${errorText}`);
    }

    const payment = await mollieResponse.json();
    logStep("Payment fetched", { 
      status: payment.status, 
      metadata: payment.metadata 
    });

    const bookingId = payment.metadata?.booking_id;
    if (!bookingId) {
      logStep("No booking_id in payment metadata");
      return new Response("OK", { status: 200 });
    }

    // Map Mollie status to our payment status
    let paymentStatus: string;
    let bookingStatus: string;

    switch (payment.status) {
      case "paid":
        paymentStatus = "paid";
        bookingStatus = "confirmed";
        break;
      case "failed":
      case "canceled":
      case "expired":
        paymentStatus = "failed";
        bookingStatus = "cancelled";
        break;
      case "pending":
      case "open":
        paymentStatus = "pending";
        bookingStatus = "pending";
        break;
      default:
        paymentStatus = "pending";
        bookingStatus = "pending";
    }

    logStep("Updating booking", { bookingId, paymentStatus, bookingStatus });

    // Update booking
    const updateData: Record<string, unknown> = {
      payment_status: paymentStatus,
      status: bookingStatus,
      mollie_transaction_id: payment.id,
    };

    if (payment.status === "paid") {
      updateData.paid_at = new Date().toISOString();
    }

    const { error: updateError } = await supabase
      .from("bookings")
      .update(updateData)
      .eq("id", bookingId);

    if (updateError) {
      logStep("Failed to update booking", { error: updateError.message });
      throw new Error(`Failed to update booking: ${updateError.message}`);
    }

    logStep("Booking updated successfully");

    // If payment is successful, send confirmation email
    if (payment.status === "paid") {
      try {
        // Fetch booking details for email
        const { data: booking } = await supabase
          .from("bookings")
          .select(`
            *,
            availability_slots!inner(
              start_time,
              end_time,
              trainer_id,
              locations(name, city)
            ),
            profiles!bookings_player_id_fkey(
              full_name,
              email
            )
          `)
          .eq("id", bookingId)
          .single();

        if (booking?.profiles?.email) {
          // Trigger confirmation email via send-email function
          await supabase.functions.invoke("send-email", {
            body: {
              to: booking.profiles.email,
              subject: "Booking Confirmed",
              template: "booking_confirmation",
              data: {
                playerName: booking.profiles.full_name,
                startTime: booking.availability_slots.start_time,
                location: booking.availability_slots.locations?.name,
              },
            },
          });
          logStep("Confirmation email sent");
        }
      } catch (emailError) {
        logStep("Failed to send confirmation email", { 
          error: emailError instanceof Error ? emailError.message : String(emailError) 
        });
        // Don't throw - email failure shouldn't fail the webhook
      }
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    // Return 200 to prevent Mollie from retrying (we've logged the error)
    return new Response("OK", { status: 200 });
  }
});
