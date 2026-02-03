import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
// Note: Resend is used directly via fetch API for emails

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: any) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[VERIFY-PAYMENT] ${step}${detailsStr}`);
};

const formatDate = (dateStr: string): string => {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
};

const formatTime = (dateStr: string): string => {
  const date = new Date(dateStr);
  return date.toLocaleTimeString('en-US', { 
    hour: '2-digit', 
    minute: '2-digit',
    hour12: false 
  });
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    logStep("Function started");

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY is not set");

    const resendKey = Deno.env.get("RESEND_API_KEY");

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user) throw new Error("User not authenticated");
    logStep("User authenticated", { userId: user.id });

    const { sessionId, bookingId, connectedAccountId } = await req.json();
    logStep("Request payload", { sessionId, bookingId, connectedAccountId });

    if (!sessionId || !bookingId) {
      throw new Error("Missing required fields: sessionId and bookingId");
    }

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

    // Retrieve the checkout session from the connected account (direct charges)
    // If connectedAccountId is provided, retrieve from that account
    let session;
    if (connectedAccountId) {
      session = await stripe.checkout.sessions.retrieve(
        sessionId,
        { stripeAccount: connectedAccountId }
      );
    } else {
      // Fallback: try to get connected account from booking metadata
      const { data: bookingMeta } = await supabaseClient
        .from('bookings')
        .select('trainer_id')
        .eq('id', bookingId)
        .single();
      
      if (bookingMeta?.trainer_id) {
        const { data: mollieAccount } = await supabaseClient
          .from('trainer_mollie_accounts')
          .select('mollie_organization_id')
          .eq('trainer_id', bookingMeta.trainer_id)
          .single();
        
        if (mollieAccount?.mollie_organization_id) {
          session = await stripe.checkout.sessions.retrieve(
            sessionId,
            { stripeAccount: mollieAccount.mollie_organization_id }
          );
        }
      }
      
      if (!session) {
        throw new Error('Could not retrieve Stripe session');
      }
    }
    logStep("Session retrieved", { status: session.payment_status, paymentIntent: session.payment_intent });

    if (session.payment_status === 'paid') {
      const amount = (session.amount_total || 0) / 100;

      // Update booking status
      const { error: updateError } = await supabaseClient
        .from('bookings')
        .update({
          payment_status: 'paid',
          status: 'confirmed',
          mollie_transaction_id: session.payment_intent as string,
          payment_amount: amount,
          paid_at: new Date().toISOString(),
        })
        .eq('id', bookingId);

      if (updateError) {
        logStep("Error updating booking", { error: updateError });
        throw new Error("Failed to update booking status");
      }

      logStep("Booking updated successfully", { bookingId });

      // Fetch booking details for email
      const { data: bookingData } = await supabaseClient
        .from('bookings')
        .select(`
          id,
          notes,
          availability_slots!inner(
            start_time,
            end_time,
            trainer_id,
            lessons(title, price, location)
          ),
          player:profiles!bookings_player_id_fkey(full_name, email)
        `)
        .eq('id', bookingId)
        .single();

      if (bookingData && resendKey) {
        logStep("Fetched booking for emails", { bookingData });

        const slot = bookingData.availability_slots as any;
        const trainerId = slot?.trainer_id;

        // Get trainer info
        const { data: trainerData } = await supabaseClient
          .from('trainer_profiles')
          .select('id, user_id, profiles(full_name, email)')
          .eq('id', trainerId)
          .single();

        const lesson = slot?.lessons as any;
        const player = bookingData.player as any;
        const trainer = (trainerData?.profiles as any);

        const lessonTitle = lesson?.title || 'Training Session';
        const lessonDate = formatDate(slot?.start_time);
        const lessonTime = formatTime(slot?.start_time);
        const location = lesson?.location || 'TBD';
        
        // Use actual platform fee from session metadata (tier-based)
        const platformFeePercent = parseFloat(session.metadata?.platform_fee_percent || '10');
        const platformFee = amount * (platformFeePercent / 100);
        const netAmount = amount - platformFee;

        // Helper function to send email via Resend API
        const sendEmail = async (to: string, subject: string, html: string) => {
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${resendKey}`,
            },
            body: JSON.stringify({
              from: "PadelTrainer <onboarding@resend.dev>",
              to: [to],
              subject,
              html,
            }),
          });
          return res.json();
        };

        // Send email to player
        if (player?.email) {
          try {
            const playerHtml = `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h1 style="color: #16a34a;">Payment Successful! 💳</h1>
                <p>Hi ${player.full_name || 'there'},</p>
                <p>Your payment has been confirmed and your lesson is booked!</p>
                <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
                  <h3 style="margin-top: 0;">${lessonTitle}</h3>
                  <p><strong>Trainer:</strong> ${trainer?.full_name || 'Your trainer'}</p>
                  <p><strong>Date:</strong> ${lessonDate}</p>
                  <p><strong>Time:</strong> ${lessonTime}</p>
                  <p><strong>Location:</strong> ${location}</p>
                  <p style="font-size: 18px; color: #16a34a;"><strong>Amount Paid:</strong> €${amount.toFixed(2)}</p>
                </div>
                <p>Get ready for your lesson! 🎾</p>
                <p>Best regards,<br>PadelTrainer Team</p>
              </div>
            `;
            await sendEmail(player.email, `Payment Confirmed: ${lessonTitle} ✅`, playerHtml);
            logStep("Player email sent", { to: player.email });
          } catch (emailError) {
            logStep("Failed to send player email", { error: emailError });
          }
        }

        // Send email to trainer
        if (trainer?.email) {
          try {
            const trainerHtml = `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h1 style="color: #16a34a;">You've Got a New Booking! 🎉</h1>
                <p>Hi ${trainer.full_name || 'there'},</p>
                <p>Great news! <strong>${player?.full_name || 'A player'}</strong> has just paid for a lesson with you.</p>
                <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
                  <h3 style="margin-top: 0;">${lessonTitle}</h3>
                  <p><strong>Player:</strong> ${player?.full_name || 'Player'}</p>
                  <p><strong>Date:</strong> ${lessonDate}</p>
                  <p><strong>Time:</strong> ${lessonTime}</p>
                  <p><strong>Location:</strong> ${location}</p>
                  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 15px 0;" />
                  <p><strong>Lesson Price:</strong> €${amount.toFixed(2)}</p>
                  <p><strong>Platform Fee (${platformFeePercent}%):</strong> -€${platformFee.toFixed(2)}</p>
                  <p style="font-size: 18px; color: #16a34a;"><strong>Your Earnings:</strong> €${netAmount.toFixed(2)}</p>
                </div>
                <p>The payment will be transferred to your connected bank account automatically.</p>
                <p>Best regards,<br>PadelTrainer Team</p>
              </div>
            `;
            await sendEmail(trainer.email, `New Paid Booking: ${lessonTitle} 💰`, trainerHtml);
            logStep("Trainer email sent", { to: trainer.email });
          } catch (emailError) {
            logStep("Failed to send trainer email", { error: emailError });
          }
        }

        // Trigger calendar sync for both player and trainer
        try {
          logStep("Triggering calendar sync", { bookingId });
          await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/sync-calendar-event`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
            },
            body: JSON.stringify({ booking_id: bookingId, action: 'create' }),
          });
          logStep("Calendar sync triggered");
        } catch (calendarError) {
          logStep("Failed to trigger calendar sync (non-blocking)", { error: calendarError });
        }
      }

      return new Response(JSON.stringify({ 
        success: true, 
        paid: true,
        bookingId,
        amount,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    } else {
      return new Response(JSON.stringify({ 
        success: true, 
        paid: false,
        status: session.payment_status,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
