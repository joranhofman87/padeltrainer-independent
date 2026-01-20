import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface EmailRequest {
  type: "booking_confirmation" | "booking_reminder" | "booking_cancelled" | "review_received" | "payment_confirmed_player" | "payment_confirmed_trainer" | "new_booking_trainer" | "new_availability" | "manual_booking_confirmation" | "slot_reopened" | "booking_request" | "booking_approved_payment" | "booking_approved_invoice" | "booking_rejected" | "club_claim_approved" | "club_claim_rejected" | "club_trainer_invitation" | "club_trainer_invitation_accepted" | "partner_inquiry";
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
    slotDate?: string;
    slotTime?: string;
    paymentLink?: string;
    reason?: string;
    bookingUrl?: string;
    clubName?: string;
    ownerName?: string;
    inviterName?: string;
    inviteMessage?: string;
    inviteLink?: string;
    locationName?: string;
    // Partner inquiry fields
    name?: string;
    companyName?: string;
    email?: string;
    phone?: string;
    message?: string;
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

    case "slot_reopened":
      return {
        subject: `Slot Available: ${data.trainerName} has an opening! 🎾`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #16a34a;">Slot Just Opened! 📅</h1>
            <p>Hi ${data.playerName},</p>
            <p>A training slot with <strong>${data.trainerName}</strong> just became available!</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <p><strong>Date:</strong> ${data.slotDate}</p>
              <p><strong>Time:</strong> ${data.slotTime}</p>
            </div>
            <p>Book now before someone else does!</p>
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

    case "booking_request":
      return {
        subject: `New Booking Request from ${data.playerName} 📬`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #2563eb;">New Booking Request! 📬</h1>
            <p>Hi ${data.trainerName},</p>
            <p><strong>${data.playerName}</strong> has requested to book a lesson with you.</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0;">${data.lessonTitle}</h3>
              <p><strong>Player:</strong> ${data.playerName}</p>
              <p><strong>Contact:</strong> ${data.playerEmail}</p>
              <p><strong>Date:</strong> ${data.lessonDate}</p>
              <p><strong>Time:</strong> ${data.lessonTime}</p>
              ${data.location ? `<p><strong>Location:</strong> ${data.location}</p>` : ''}
              <p><strong>Price:</strong> €${data.price}</p>
            </div>
            <p>Please review this request in your dashboard and approve or decline it.</p>
            <p style="margin-top: 24px;">
              <a href="${data.bookingUrl || 'https://padeltrainer.lovable.app/trainer-bookings'}" style="background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Review Request</a>
            </p>
            <p>Best regards,<br>PadelTrainer.ai Team</p>
          </div>
        `,
      };

    case "booking_approved_payment":
      return {
        subject: `Booking Approved! Complete Your Payment 🎾`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #16a34a;">Booking Approved! 🎉</h1>
            <p>Hi ${data.playerName},</p>
            <p>Great news! <strong>${data.trainerName}</strong> has approved your booking request.</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0;">${data.lessonTitle}</h3>
              <p><strong>Date:</strong> ${data.lessonDate}</p>
              <p><strong>Time:</strong> ${data.lessonTime}</p>
              ${data.location ? `<p><strong>Location:</strong> ${data.location}</p>` : ''}
              <p style="font-size: 18px; color: #16a34a;"><strong>Price:</strong> €${data.price}</p>
            </div>
            <p style="background: #fef3c7; padding: 12px; border-radius: 6px; color: #92400e;">
              <strong>Action Required:</strong> Complete your payment to confirm the booking.
            </p>
            <p style="margin-top: 24px;">
              <a href="${data.paymentLink}" style="background: #16a34a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Pay Now</a>
            </p>
            <p style="color: #6b7280; font-size: 14px;">This payment link expires in 24 hours.</p>
            <p>Best regards,<br>PadelTrainer.ai Team</p>
          </div>
        `,
      };

    case "booking_approved_invoice":
      return {
        subject: `Booking Confirmed: ${data.lessonTitle} 🎾`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #16a34a;">Booking Confirmed! 🎉</h1>
            <p>Hi ${data.playerName},</p>
            <p>Great news! <strong>${data.trainerName}</strong> has approved and confirmed your booking.</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0;">${data.lessonTitle}</h3>
              <p><strong>Date:</strong> ${data.lessonDate}</p>
              <p><strong>Time:</strong> ${data.lessonTime}</p>
              ${data.location ? `<p><strong>Location:</strong> ${data.location}</p>` : ''}
              ${data.price ? `<p><strong>Price:</strong> €${data.price}</p>` : ''}
            </div>
            <p style="background: #fef3c7; padding: 12px; border-radius: 6px; color: #92400e;">
              <strong>Payment:</strong> You'll receive an invoice from your trainer for payment.
            </p>
            <p>See you on the court!</p>
            <p>Best regards,<br>PadelTrainer.ai Team</p>
          </div>
        `,
      };

    case "booking_rejected":
      return {
        subject: `Booking Request Declined`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #dc2626;">Booking Request Declined</h1>
            <p>Hi ${data.playerName},</p>
            <p>Unfortunately, <strong>${data.trainerName}</strong> was unable to accept your booking request.</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0;">${data.lessonTitle}</h3>
              <p><strong>Date:</strong> ${data.lessonDate}</p>
              <p><strong>Time:</strong> ${data.lessonTime}</p>
              ${data.reason ? `<p style="color: #6b7280;"><strong>Reason:</strong> ${data.reason}</p>` : ''}
            </div>
            <p>Don't worry – you can browse other available slots or trainers.</p>
            <p style="margin-top: 24px;">
              <a href="https://padeltrainer.lovable.app/trainers" style="background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Find Another Lesson</a>
            </p>
            <p>Best regards,<br>PadelTrainer.ai Team</p>
          </div>
        `,
      };

    case "club_claim_approved":
      return {
        subject: `Club Claim Approved: ${data.clubName} ✅`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #16a34a;">Club Claim Approved! 🎉</h1>
            <p>Hi ${data.ownerName || "Club Manager"},</p>
            <p>Great news! Your claim to manage <strong>${data.clubName}</strong> has been verified and approved.</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0;">${data.clubName}</h3>
              <p>You now have full access to:</p>
              <ul style="margin: 0; padding-left: 20px;">
                <li>View and manage club trainers</li>
                <li>Manage player roster</li>
                <li>View aggregated trainer calendars</li>
                <li>Edit club profile and settings</li>
                <li>Invite other club managers</li>
              </ul>
            </div>
            <p style="margin-top: 24px;">
              <a href="https://padeltrainer.lovable.app/club" style="background: #16a34a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Go to Club Dashboard</a>
            </p>
            <p>Best regards,<br>PadelTrainer.ai Team</p>
          </div>
        `,
      };

    case "club_claim_rejected":
      return {
        subject: `Club Claim Update: ${data.clubName}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #dc2626;">Club Claim Not Approved</h1>
            <p>Hi ${data.ownerName || "there"},</p>
            <p>Unfortunately, we were unable to verify your claim to manage <strong>${data.clubName}</strong>.</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <p>This could be due to:</p>
              <ul style="margin: 0; padding-left: 20px;">
                <li>Unable to verify your ownership or management role</li>
                <li>Duplicate or conflicting claim</li>
                <li>Incomplete information provided</li>
              </ul>
            </div>
            <p>If you believe this was an error, please contact us with additional verification documents or information.</p>
            <p style="margin-top: 24px;">
              <a href="mailto:support@padeltrainer.ai" style="background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Contact Support</a>
            </p>
            <p>Best regards,<br>PadelTrainer.ai Team</p>
          </div>
        `,
      };

    case "club_trainer_invitation":
      return {
        subject: `${data.clubName} invites you to join as a trainer 🎾`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #16a34a;">You're Invited! 🎾</h1>
            <p>Hi${data.trainerName ? ` ${data.trainerName}` : ""},</p>
            <p><strong>${data.clubName}</strong> would like you to join as an official club trainer!</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0;">${data.clubName}</h3>
              <p><strong>Location:</strong> ${data.locationName || "Not specified"}</p>
              <p><strong>Invited by:</strong> ${data.inviterName}</p>
              ${data.inviteMessage ? `<p style="color: #6b7280; font-style: italic;">"${data.inviteMessage}"</p>` : ''}
            </div>
            <p>As a club trainer, you'll be:</p>
            <ul style="margin: 0; padding-left: 20px;">
              <li>Listed as an official trainer for ${data.clubName}</li>
              <li>Visible on the club's trainer roster</li>
              <li>Able to manage bookings through the club's calendar</li>
            </ul>
            <p style="margin-top: 24px;">
              <a href="${data.inviteLink}" style="background: #16a34a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; margin-right: 12px;">View Invitation</a>
            </p>
            <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">
              If you're not interested, you can decline this invitation through the link above.
            </p>
            <p>Best regards,<br>PadelTrainer.ai Team</p>
          </div>
        `,
      };

    case "club_trainer_invitation_accepted":
      return {
        subject: `${data.trainerName} accepted your invitation! 🎉`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #16a34a;">Trainer Joined Your Club! 🎉</h1>
            <p>Hi ${data.ownerName || "Club Manager"},</p>
            <p>Great news! <strong>${data.trainerName}</strong> has accepted your invitation to join <strong>${data.clubName}</strong> as a club trainer.</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <p><strong>Trainer:</strong> ${data.trainerName}</p>
              <p><strong>Email:</strong> ${data.trainerEmail}</p>
            </div>
            <p>You can now see their availability in your club calendar and they'll appear in your trainers list.</p>
            <p style="margin-top: 24px;">
              <a href="https://padeltrainer.lovable.app/club/trainers" style="background: #16a34a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">View Club Trainers</a>
            </p>
            <p>Best regards,<br>PadelTrainer.ai Team</p>
          </div>
        `,
      };

    case "partner_inquiry":
      return {
        subject: `New Partner Inquiry from ${data.name}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #2563eb;">New Partner Inquiry 🤝</h1>
            <p>A new partnership inquiry has been submitted via the website.</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0;">Contact Details</h3>
              <p><strong>Name:</strong> ${data.name}</p>
              <p><strong>Company:</strong> ${data.companyName}</p>
              <p><strong>Email:</strong> <a href="mailto:${data.email}">${data.email}</a></p>
              <p><strong>Phone:</strong> <a href="tel:${data.phone}">${data.phone}</a></p>
            </div>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0;">Message</h3>
              <p style="white-space: pre-wrap;">${data.message}</p>
            </div>
            <p style="color: #6b7280; font-size: 14px;">This inquiry was submitted at ${new Date().toISOString()}</p>
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
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    
    // Verify authentication (except for partner_inquiry which is public)
    const authHeader = req.headers.get("Authorization");
    const { type, to, data }: EmailRequest = await req.json();
    
    // Allow partner_inquiry without auth (public contact form)
    const isPartnerInquiry = type === "partner_inquiry";
    
    if (!isPartnerInquiry) {
      if (!authHeader) {
        console.error("No authorization header provided");
        return new Response(
          JSON.stringify({ error: "Authentication required" }),
          { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }

      // Create client to verify user token
      const supabase = createClient(supabaseUrl, supabaseServiceKey);
      const token = authHeader.replace("Bearer ", "");
      
      // Allow service role key to bypass user auth check (for internal calls)
      const isServiceRole = token === supabaseServiceKey;
      
      if (!isServiceRole) {
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        
        if (authError || !user) {
          console.error("Authentication failed:", authError?.message);
          return new Response(
            JSON.stringify({ error: "Unauthorized" }),
            { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }
        
        console.log("Email request from authenticated user:", user.id);
      } else {
        console.log("Email request from service role (internal call)");
      }
    } else {
      console.log("Partner inquiry email (public form submission)");
    }

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
