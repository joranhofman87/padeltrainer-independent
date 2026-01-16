import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface EmailRequest {
  type: "booking_confirmation" | "booking_reminder" | "booking_cancelled" | "review_received" | "payment_confirmed_player" | "payment_confirmed_trainer" | "new_booking_trainer" | "new_availability" | "manual_booking_confirmation";
  to: string;
  data: {
    playerName?: string;
    playerEmail?: string;
    playerPhone?: string;
    trainerName?: string;
    trainerEmail?: string;
    trainerPhone?: string;
    lessonTitle?: string;
    lessonDate?: string;
    lessonTime?: string;
    location?: string;
    price?: number;
    rating?: number;
    platformFee?: number;
    netAmount?: number;
    slotCount?: number;
    dateRange?: string;
  };
}

const getEmailContent = (type: string, data: EmailRequest["data"]) => {
  switch (type) {
    case "booking_confirmation":
      return {
        subject: `Booking Confirmed: ${data.lessonTitle}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #16a34a;">Booking Confirmed! 🎾</h1>
            <p>Hi ${data.playerName},</p>
            <p>Your lesson has been successfully booked!</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0;">${data.lessonTitle}</h3>
              <p><strong>Trainer:</strong> ${data.trainerName}</p>
              <p><strong>Date:</strong> ${data.lessonDate}</p>
              <p><strong>Time:</strong> ${data.lessonTime}</p>
              <p><strong>Location:</strong> ${data.location || "TBD"}</p>
              <p><strong>Price:</strong> €${data.price}</p>
            </div>
            <p>See you on the court!</p>
            <p>Best regards,<br>PadelTrainer.ai Team</p>
          </div>
        `,
      };

    case "booking_reminder":
      return {
        subject: `Reminder: Lesson Tomorrow - ${data.lessonTitle}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #2563eb;">Lesson Reminder 🎾</h1>
            <p>Hi ${data.playerName},</p>
            <p>This is a reminder that you have a lesson scheduled for tomorrow!</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0;">${data.lessonTitle}</h3>
              <p><strong>Trainer:</strong> ${data.trainerName}</p>
              <p><strong>Date:</strong> ${data.lessonDate}</p>
              <p><strong>Time:</strong> ${data.lessonTime}</p>
              <p><strong>Location:</strong> ${data.location || "TBD"}</p>
            </div>
            <p>Don't forget your padel gear!</p>
            <p>Best regards,<br>PadelTrainer.ai Team</p>
          </div>
        `,
      };

    case "booking_cancelled":
      return {
        subject: `Booking Cancelled: ${data.lessonTitle}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #dc2626;">Booking Cancelled</h1>
            <p>Hi ${data.playerName},</p>
            <p>Your booking has been cancelled.</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0;">${data.lessonTitle}</h3>
              <p><strong>Trainer:</strong> ${data.trainerName}</p>
              <p><strong>Date:</strong> ${data.lessonDate}</p>
              <p><strong>Time:</strong> ${data.lessonTime}</p>
            </div>
            <p>If you have any questions, please contact the trainer.</p>
            <p>Best regards,<br>PadelTrainer.ai Team</p>
          </div>
        `,
      };

    case "review_received":
      return {
        subject: `New Review Received! ⭐`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #f59e0b;">New Review! ⭐</h1>
            <p>Hi ${data.trainerName},</p>
            <p>You've received a new ${data.rating}-star review from ${data.playerName}!</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <p><strong>Lesson:</strong> ${data.lessonTitle}</p>
              <p><strong>Rating:</strong> ${"⭐".repeat(data.rating || 0)}</p>
            </div>
            <p>Keep up the great work!</p>
            <p>Best regards,<br>PadelTrainer.ai Team</p>
          </div>
        `,
      };

    case "payment_confirmed_player":
      return {
        subject: `Payment Confirmed: ${data.lessonTitle} ✅`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #16a34a;">Payment Successful! 💳</h1>
            <p>Hi ${data.playerName},</p>
            <p>Your payment has been confirmed and your lesson is booked!</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0;">${data.lessonTitle}</h3>
              <p><strong>Trainer:</strong> ${data.trainerName}</p>
              <p><strong>Date:</strong> ${data.lessonDate}</p>
              <p><strong>Time:</strong> ${data.lessonTime}</p>
              <p><strong>Location:</strong> ${data.location || "TBD"}</p>
              <p style="font-size: 18px; color: #16a34a;"><strong>Amount Paid:</strong> €${data.price}</p>
            </div>
            <p>Get ready for your lesson! 🎾</p>
            <p>Best regards,<br>PadelTrainer.ai Team</p>
          </div>
        `,
      };

    case "payment_confirmed_trainer":
      return {
        subject: `New Paid Booking: ${data.lessonTitle} 💰`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #16a34a;">You've Got a New Booking! 🎉</h1>
            <p>Hi ${data.trainerName},</p>
            <p>Great news! <strong>${data.playerName}</strong> has just paid for a lesson with you.</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0;">${data.lessonTitle}</h3>
              <p><strong>Player:</strong> ${data.playerName}</p>
              <p><strong>Date:</strong> ${data.lessonDate}</p>
              <p><strong>Time:</strong> ${data.lessonTime}</p>
              <p><strong>Location:</strong> ${data.location || "TBD"}</p>
              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 15px 0;" />
              <p><strong>Lesson Price:</strong> €${data.price}</p>
              <p><strong>Platform Fee (10%):</strong> -€${data.platformFee?.toFixed(2) || (data.price ? (data.price * 0.1).toFixed(2) : '0.00')}</p>
              <p style="font-size: 18px; color: #16a34a;"><strong>Your Earnings:</strong> €${data.netAmount?.toFixed(2) || (data.price ? (data.price * 0.9).toFixed(2) : '0.00')}</p>
            </div>
            <p>The payment will be transferred to your connected bank account automatically.</p>
            <p>Best regards,<br>PadelTrainer.ai Team</p>
          </div>
        `,
      };

    case "new_booking_trainer":
      return {
        subject: `New Booking Request: ${data.lessonTitle}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #2563eb;">New Booking Request! 📅</h1>
            <p>Hi ${data.trainerName},</p>
            <p><strong>${data.playerName}</strong> wants to book a lesson with you.</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0;">${data.lessonTitle}</h3>
              <p><strong>Player:</strong> ${data.playerName}</p>
              <p><strong>Contact:</strong> ${data.playerEmail}</p>
              <p><strong>Date:</strong> ${data.lessonDate}</p>
              <p><strong>Time:</strong> ${data.lessonTime}</p>
              <p><strong>Location:</strong> ${data.location || "TBD"}</p>
              <p><strong>Price:</strong> €${data.price}</p>
            </div>
            <p>Payment is pending - you'll be notified once payment is confirmed.</p>
            <p>Best regards,<br>PadelTrainer.ai Team</p>
          </div>
        `,
      };

    case "new_availability":
      return {
        subject: `New Training Slots Available from ${data.trainerName}! 🎾`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #16a34a;">New Availability Alert! 📅</h1>
            <p>Hi ${data.playerName},</p>
            <p>Great news! <strong>${data.trainerName}</strong> has just added new training slots.</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <p style="font-size: 24px; font-weight: bold; color: #16a34a; margin: 0;">${data.slotCount} New Slots</p>
              <p style="color: #6b7280; margin-top: 8px;">Available: ${data.dateRange}</p>
            </div>
            <p>Don't miss out – book your spot before they fill up!</p>
            <p style="margin-top: 24px;">
              <a href="https://padeltrainer.ai/trainers" style="background: #16a34a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Book Now</a>
            </p>
            <p style="margin-top: 24px; color: #6b7280; font-size: 14px;">
              You're receiving this because you follow ${data.trainerName}. 
              <a href="https://padeltrainer.ai/settings/notifications">Manage notification preferences</a>
            </p>
            <p>Best regards,<br>PadelTrainer.ai Team</p>
          </div>
        `,
      };

    case "manual_booking_confirmation":
      return {
        subject: `Lesson Booked: ${data.lessonTitle} 🎾`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #16a34a;">You're Booked! 🎾</h1>
            <p>Hi ${data.playerName},</p>
            <p>Your trainer has booked a lesson for you!</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0;">${data.lessonTitle}</h3>
              <p><strong>Date:</strong> ${data.lessonDate}</p>
              <p><strong>Time:</strong> ${data.lessonTime}</p>
              ${data.location ? `<p><strong>Location:</strong> ${data.location}</p>` : ''}
              ${data.price ? `<p><strong>Price:</strong> €${data.price}</p>` : ''}
            </div>
            <p style="background: #fef3c7; padding: 12px; border-radius: 6px; color: #92400e;">
              <strong>Payment:</strong> Please arrange payment directly with your trainer.
            </p>
            <p>See you on the court!</p>
            <p>Best regards,<br>PadelTrainer.ai Team</p>
          </div>
        `,
      };

    default:
      return {
        subject: "PadelTrainer.ai Notification",
        html: "<p>You have a new notification from PadelTrainer.ai.</p>",
      };
  }
};

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { type, to, data }: EmailRequest = await req.json();

    if (!to || !type) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: to, type" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    if (!RESEND_API_KEY) {
      console.error("RESEND_API_KEY is not set");
      return new Response(
        JSON.stringify({ error: "Email service not configured" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const { subject, html } = getEmailContent(type, data);

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: "PadelTrainer.ai <noreply@padeltrainer.ai>",
        to: [to],
        subject,
        html,
      }),
    });

    const emailResponse = await res.json();

    if (!res.ok) {
      console.error("Resend API error:", emailResponse);
      return new Response(
        JSON.stringify({ error: emailResponse.message || "Failed to send email" }),
        { status: res.status, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    console.log("Email sent successfully:", emailResponse);

    return new Response(JSON.stringify(emailResponse), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error: any) {
    console.error("Error in send-email function:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
};

serve(handler);
