import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface EmailRequest {
  type: "booking_confirmation" | "booking_reminder" | "booking_cancelled" | "review_received";
  to: string;
  data: {
    playerName?: string;
    trainerName?: string;
    lessonTitle?: string;
    lessonDate?: string;
    lessonTime?: string;
    location?: string;
    price?: number;
    rating?: number;
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
            <p>Best regards,<br>TennisTrainer Team</p>
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
            <p>Don't forget your tennis gear!</p>
            <p>Best regards,<br>TennisTrainer Team</p>
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
            <p>Best regards,<br>TennisTrainer Team</p>
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
            <p>Best regards,<br>TennisTrainer Team</p>
          </div>
        `,
      };

    default:
      return {
        subject: "TennisTrainer Notification",
        html: "<p>You have a new notification from TennisTrainer.</p>",
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
        from: "TennisTrainer <onboarding@resend.dev>",
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
