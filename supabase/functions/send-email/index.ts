import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface EmailRequest {
  type: "booking_confirmation" | "booking_reminder" | "booking_cancelled" | "review_received" | "payment_confirmed_player" | "payment_confirmed_trainer" | "new_booking_trainer" | "new_availability" | "manual_booking_confirmation" | "slot_reopened" | "booking_request" | "booking_approved_payment" | "booking_approved_invoice" | "booking_rejected" | "club_claim_approved" | "club_claim_rejected" | "club_trainer_invitation" | "club_trainer_invitation_accepted" | "partner_inquiry" | "location_request" | "password_reset_admin" | "payment_reminder" | "intake_registration_confirmation";
  to: string;
  userId?: string;
  language?: string;
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
    // Location request fields
    city?: string;
    country?: string;
    streetAddress?: string;
    websiteUrl?: string;
    additionalNotes?: string;
    requestedBy?: string;
    requestedByEmail?: string;
    // Password reset admin fields
    resetLink?: string;
    userName?: string;
    // Payment reminder fields
    totalAmount?: number;
    unpaidSessions?: string;
    cycleName?: string;
    // Intake registration confirmation fields
    confirmationText?: string;
    isNewUser?: boolean;
    startDate?: string;
    endDate?: string;
    enrollmentDeadline?: string;
    lessonTypes?: string[];
    preferredDurationMinutes?: number;
    sessionsPerWeek?: number;
    locationName?: string;
    rating?: number;
    ratingSystem?: string;
    notes?: string;
  };
}

const EMAIL_LOGO = `<div style="text-align: center; margin-bottom: 24px;"><img src="https://padeltrainer.ai/logo-dark.png" alt="PadelTrainer.ai" width="220" height="40" style="max-width: 220px; height: auto;" /></div>`;
const BRAND_ORANGE = "#f45d25";

const getEmailContent = (type: string, data: EmailRequest["data"], language?: string) => {
  switch (type) {
    case "booking_confirmation":
      return {
        subject: `Booking Confirmed: ${data.lessonTitle}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            ${EMAIL_LOGO}
            <h1 style="color: ${BRAND_ORANGE};">Booking Confirmed! 🎾</h1>
            <p>Hi ${data.playerName},</p>
            <p>Your training session has been successfully booked!</p>
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
        subject: `Reminder: Training Session Tomorrow - ${data.lessonTitle}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            ${EMAIL_LOGO}
            <h1 style="color: ${BRAND_ORANGE};">Session Reminder 🎾</h1>
            <p>Hi ${data.playerName},</p>
            <p>This is a reminder that you have a training session scheduled for tomorrow!</p>
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
            ${EMAIL_LOGO}
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
            ${EMAIL_LOGO}
            <h1 style="color: #f59e0b;">New Review! ⭐</h1>
            <p>Hi ${data.trainerName},</p>
            <p>You've received a new ${data.rating}-star review from ${data.playerName}!</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <p><strong>Session:</strong> ${data.lessonTitle}</p>
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
            ${EMAIL_LOGO}
            <h1 style="color: ${BRAND_ORANGE};">Payment Successful! 💳</h1>
            <p>Hi ${data.playerName},</p>
            <p>Your payment has been confirmed and your training session is booked!</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0;">${data.lessonTitle}</h3>
              <p><strong>Trainer:</strong> ${data.trainerName}</p>
              <p><strong>Date:</strong> ${data.lessonDate}</p>
              <p><strong>Time:</strong> ${data.lessonTime}</p>
              <p><strong>Location:</strong> ${data.location || "TBD"}</p>
              <p style="font-size: 18px; color: ${BRAND_ORANGE};"><strong>Amount Paid:</strong> €${data.price}</p>
            </div>
            <p>Get ready for your session! 🎾</p>
            <p>Best regards,<br>PadelTrainer.ai Team</p>
          </div>
        `,
      };

    case "payment_confirmed_trainer":
      return {
        subject: `New Paid Booking: ${data.lessonTitle} 💰`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            ${EMAIL_LOGO}
            <h1 style="color: ${BRAND_ORANGE};">You've Got a New Booking! 🎉</h1>
            <p>Hi ${data.trainerName},</p>
            <p>Great news! <strong>${data.playerName}</strong> has just paid for a training session with you.</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0;">${data.lessonTitle}</h3>
              <p><strong>Player:</strong> ${data.playerName}</p>
              <p><strong>Date:</strong> ${data.lessonDate}</p>
              <p><strong>Time:</strong> ${data.lessonTime}</p>
              <p><strong>Location:</strong> ${data.location || "TBD"}</p>
              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 15px 0;" />
              <p><strong>Session Price:</strong> €${data.price}</p>
              <p><strong>Platform Fee:</strong> -€${data.platformFee?.toFixed(2) || '1.00'}</p>
              <p style="font-size: 18px; color: ${BRAND_ORANGE};"><strong>Your Earnings:</strong> €${data.netAmount?.toFixed(2) || (data.price ? (data.price - (data.platformFee || 1.00)).toFixed(2) : '0.00')}</p>
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
            ${EMAIL_LOGO}
            <h1 style="color: ${BRAND_ORANGE};">New Booking Request! 📅</h1>
            <p>Hi ${data.trainerName},</p>
            <p><strong>${data.playerName}</strong> wants to book a training session with you.</p>
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
            ${EMAIL_LOGO}
            <h1 style="color: ${BRAND_ORANGE};">New Availability Alert! 📅</h1>
            <p>Hi ${data.playerName},</p>
            <p>Great news! <strong>${data.trainerName}</strong> has just added new training slots.</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <p style="font-size: 24px; font-weight: bold; color: ${BRAND_ORANGE}; margin: 0;">${data.slotCount} New Slots</p>
              <p style="color: #6b7280; margin-top: 8px;">Available: ${data.dateRange}</p>
            </div>
            <p>Don't miss out – book your spot before they fill up!</p>
            <p style="margin-top: 24px;">
              <a href="https://padeltrainer.ai/nl/trainers" style="background: ${BRAND_ORANGE}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Book Now</a>
            </p>
            <p style="margin-top: 24px; color: #6b7280; font-size: 14px;">
              You're receiving this because you follow ${data.trainerName}. 
              <a href="https://padeltrainer.ai/app/player/settings/notifications">Manage notification preferences</a>
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
            ${EMAIL_LOGO}
            <h1 style="color: ${BRAND_ORANGE};">Slot Just Opened! 📅</h1>
            <p>Hi ${data.playerName},</p>
            <p>A training slot with <strong>${data.trainerName}</strong> just became available!</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <p><strong>Date:</strong> ${data.slotDate}</p>
              <p><strong>Time:</strong> ${data.slotTime}</p>
            </div>
            <p>Book now before someone else does!</p>
            <p style="margin-top: 24px;">
              <a href="https://padeltrainer.ai/nl/trainers" style="background: ${BRAND_ORANGE}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Book Now</a>
            </p>
            <p style="margin-top: 24px; color: #6b7280; font-size: 14px;">
              You're receiving this because you follow ${data.trainerName}. 
              <a href="https://padeltrainer.ai/app/player/settings/notifications">Manage notification preferences</a>
            </p>
            <p>Best regards,<br>PadelTrainer.ai Team</p>
          </div>
        `,
      };

    case "manual_booking_confirmation":
      return {
        subject: `Session Booked: ${data.lessonTitle} 🎾`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            ${EMAIL_LOGO}
            <h1 style="color: ${BRAND_ORANGE};">You're Booked! 🎾</h1>
            <p>Hi ${data.playerName},</p>
            <p>Your trainer has booked a training session for you!</p>
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
            ${EMAIL_LOGO}
            <h1 style="color: ${BRAND_ORANGE};">New Booking Request! 📬</h1>
            <p>Hi ${data.trainerName},</p>
            <p><strong>${data.playerName}</strong> has requested to book a training session with you.</p>
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
              <a href="${data.bookingUrl || 'https://padeltrainer.ai/app/trainer/schedule-overview'}" style="background: ${BRAND_ORANGE}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Review Request</a>
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
            ${EMAIL_LOGO}
            <h1 style="color: ${BRAND_ORANGE};">Booking Approved! 🎉</h1>
            <p>Hi ${data.playerName},</p>
            <p>Great news! <strong>${data.trainerName}</strong> has approved your booking request.</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0;">${data.lessonTitle}</h3>
              <p><strong>Date:</strong> ${data.lessonDate}</p>
              <p><strong>Time:</strong> ${data.lessonTime}</p>
              ${data.location ? `<p><strong>Location:</strong> ${data.location}</p>` : ''}
              <p style="font-size: 18px; color: ${BRAND_ORANGE};"><strong>Price:</strong> €${data.price}</p>
            </div>
            <p style="background: #fef3c7; padding: 12px; border-radius: 6px; color: #92400e;">
              <strong>Action Required:</strong> Complete your payment to confirm the booking.
            </p>
            <p style="margin-top: 24px;">
              <a href="${data.paymentLink}" style="background: ${BRAND_ORANGE}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Pay Now</a>
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
            ${EMAIL_LOGO}
            <h1 style="color: ${BRAND_ORANGE};">Booking Confirmed! 🎉</h1>
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
            ${EMAIL_LOGO}
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
              <a href="https://padeltrainer.ai/nl/trainers" style="background: ${BRAND_ORANGE}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Find Another Lesson</a>
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
            ${EMAIL_LOGO}
            <h1 style="color: ${BRAND_ORANGE};">Club Claim Approved! 🎉</h1>
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
              <a href="https://padeltrainer.ai/app/club" style="background: ${BRAND_ORANGE}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Go to Club Dashboard</a>
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
            ${EMAIL_LOGO}
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
              <a href="mailto:support@padeltrainer.ai" style="background: ${BRAND_ORANGE}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Contact Support</a>
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
            ${EMAIL_LOGO}
            <h1 style="color: ${BRAND_ORANGE};">You're Invited! 🎾</h1>
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
              <a href="${data.inviteLink}" style="background: ${BRAND_ORANGE}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; margin-right: 12px;">View Invitation</a>
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
            ${EMAIL_LOGO}
            <h1 style="color: ${BRAND_ORANGE};">Trainer Joined Your Club! 🎉</h1>
            <p>Hi ${data.ownerName || "Club Manager"},</p>
            <p>Great news! <strong>${data.trainerName}</strong> has accepted your invitation to join <strong>${data.clubName}</strong> as a club trainer.</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <p><strong>Trainer:</strong> ${data.trainerName}</p>
              <p><strong>Email:</strong> ${data.trainerEmail}</p>
            </div>
            <p>You can now see their availability in your club calendar and they'll appear in your trainers list.</p>
            <p style="margin-top: 24px;">
              <a href="https://padeltrainer.ai/app/club/trainers" style="background: ${BRAND_ORANGE}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">View Club Trainers</a>
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
            ${EMAIL_LOGO}
            <h1 style="color: ${BRAND_ORANGE};">New Partner Inquiry 🤝</h1>
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

    case "location_request":
      return {
        subject: `New Club Request: ${data.clubName} (${data.city})`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            ${EMAIL_LOGO}
            <h1 style="color: ${BRAND_ORANGE};">New Club Request 📍</h1>
            <p>A trainer has requested a new club to be added to the platform.</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0;">Club Details</h3>
              <p><strong>Club Name:</strong> ${data.clubName}</p>
              <p><strong>City:</strong> ${data.city}</p>
              <p><strong>Country:</strong> ${data.country}</p>
              ${data.streetAddress ? `<p><strong>Address:</strong> ${data.streetAddress}</p>` : ''}
              ${data.websiteUrl ? `<p><strong>Website:</strong> <a href="${data.websiteUrl}">${data.websiteUrl}</a></p>` : ''}
            </div>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0;">Requested By</h3>
              <p><strong>Trainer:</strong> ${data.requestedBy}</p>
              <p><strong>Email:</strong> <a href="mailto:${data.requestedByEmail}">${data.requestedByEmail}</a></p>
            </div>
            ${data.additionalNotes ? `<div style="background: #fef3c7; padding: 20px; border-radius: 8px; margin: 20px 0;"><h3 style="margin-top: 0;">Additional Notes</h3><p style="white-space: pre-wrap;">${data.additionalNotes}</p></div>` : ''}
            <p style="color: #6b7280; font-size: 14px;">This request was submitted at ${new Date().toISOString()}</p>
          </div>
        `,
      };

    case "password_reset_admin":
      return {
        subject: `Password Reset Request - PadelTrainer.ai`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            ${EMAIL_LOGO}
            <h1 style="color: ${BRAND_ORANGE};">Password Reset 🔐</h1>
            <p>Hi ${data.userName},</p>
            <p>An administrator has requested a password reset for your account.</p>
            <p style="margin-top: 24px;">
              <a href="${data.resetLink}" style="background: ${BRAND_ORANGE}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Reset Password</a>
            </p>
            <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">
              If you did not expect this email, you can safely ignore it. Your password will remain unchanged.
            </p>
            <p style="color: #6b7280; font-size: 14px;">
              This link will expire in 24 hours.
            </p>
            <p>Best regards,<br>PadelTrainer.ai Team</p>
          </div>
        `,
      };

    case "payment_reminder":
      return {
        subject: `Payment Reminder: Outstanding Training Sessions 💳`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            ${EMAIL_LOGO}
            <h1 style="color: #f59e0b;">Payment Reminder 💳</h1>
            <p>Hi ${data.playerName},</p>
            <p>This is a friendly reminder from <strong>${data.trainerName}</strong> that you have outstanding payments for training sessions.</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0;">Unpaid Sessions</h3>
              ${data.unpaidSessions || ''}
              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 15px 0;" />
              <p style="font-size: 18px; color: #f59e0b;"><strong>Total Outstanding:</strong> €${data.totalAmount?.toFixed(2) || '0.00'}</p>
            </div>
            <p>Please arrange payment at your earliest convenience. If you've already paid, please disregard this message.</p>
            <p>For questions, contact your trainer directly.</p>
            <p>Best regards,<br>PadelTrainer.ai Team</p>
          </div>
        `,
      };

    case "intake_registration_confirmation": {
      const lang = language || 'en';
      const translations: Record<string, {
        subject: string; greeting: string; intro: string; footer: string; regards: string;
        detailsTitle: string; startDate: string; endDate: string; deadline: string;
        yourRegistration: string; lessonType: string; duration: string; sessionsWeek: string;
        location: string; level: string; notes: string; min: string;
        phone: string; birthDate: string; package_: string; durationWeeks: string;
        pricePerLesson: string; totalPrice: string; priceSummary: string; weeks: string;
      }> = {
        en: {
          subject: `Registration Confirmed: ${data.cycleName || 'Training'} 🎾`,
          greeting: `Hi ${data.playerName},`,
          intro: `Your registration for <strong>${data.cycleName || 'training'}</strong>${data.ownerName ? ` at <strong>${data.ownerName}</strong>` : ''} has been received.`,
          footer: `If you have any questions, ${data.ownerName ? `contact ${data.ownerName} directly` : 'contact your trainer or academy directly'}.`,
          regards: 'Best regards,',
          detailsTitle: 'Registration Details',
          startDate: 'Start Date',
          endDate: 'End Date',
          deadline: 'Registration Deadline',
          yourRegistration: 'What You Registered For',
          lessonType: 'Lesson Type',
          duration: 'Duration',
          sessionsWeek: 'Sessions/Week',
          location: 'Location',
          level: 'Level',
          notes: 'Notes',
          min: 'min',
          phone: 'Phone',
          birthDate: 'Date of Birth',
          package_: 'Package',
          durationWeeks: 'Duration',
          pricePerLesson: 'Per lesson',
          totalPrice: 'Total',
          priceSummary: 'Price Indication',
          weeks: 'weeks',
        },
        nl: {
          subject: `Inschrijving bevestigd: ${data.cycleName || 'Training'} 🎾`,
          greeting: `Hoi ${data.playerName},`,
          intro: `Je inschrijving voor <strong>${data.cycleName || 'training'}</strong>${data.ownerName ? ` bij <strong>${data.ownerName}</strong>` : ''} is ontvangen.`,
          footer: `Heb je vragen? ${data.ownerName ? `Neem dan contact op met ${data.ownerName}` : 'Neem contact op met je trainer of academy'}.`,
          regards: 'Met sportieve groet,',
          detailsTitle: 'Registratiegegevens',
          startDate: 'Startdatum',
          endDate: 'Einddatum',
          deadline: 'Inschrijfdeadline',
          yourRegistration: 'Jouw inschrijving',
          lessonType: 'Lestype',
          duration: 'Duur',
          sessionsWeek: 'Sessies/week',
          location: 'Locatie',
          level: 'Niveau',
          notes: 'Opmerkingen',
          min: 'min',
          phone: 'Telefoon',
          birthDate: 'Geboortedatum',
          package_: 'Pakket',
          durationWeeks: 'Duur',
          pricePerLesson: 'Per les',
          totalPrice: 'Totaal',
          priceSummary: 'Prijsindicatie',
          weeks: 'weken',
        },
        es: {
          subject: `Inscripción confirmada: ${data.cycleName || 'Entrenamiento'} 🎾`,
          greeting: `Hola ${data.playerName},`,
          intro: `Tu inscripción para <strong>${data.cycleName || 'entrenamiento'}</strong>${data.ownerName ? ` en <strong>${data.ownerName}</strong>` : ''} ha sido recibida.`,
          footer: `Si tienes preguntas, ${data.ownerName ? `contacta con ${data.ownerName} directamente` : 'contacta con tu entrenador o academia'}.`,
          regards: 'Un saludo,',
          detailsTitle: 'Detalles de registro',
          startDate: 'Fecha de inicio',
          endDate: 'Fecha de fin',
          deadline: 'Fecha límite',
          yourRegistration: 'Tu registro',
          lessonType: 'Tipo de clase',
          duration: 'Duración',
          sessionsWeek: 'Sesiones/semana',
          location: 'Ubicación',
          level: 'Nivel',
          notes: 'Notas',
          min: 'min',
          phone: 'Teléfono',
          birthDate: 'Fecha de nacimiento',
          package_: 'Paquete',
          durationWeeks: 'Duración',
          pricePerLesson: 'Por clase',
          totalPrice: 'Total',
          priceSummary: 'Indicación de precio',
          weeks: 'semanas',
        },
        de: {
          subject: `Anmeldung bestätigt: ${data.cycleName || 'Training'} 🎾`,
          greeting: `Hallo ${data.playerName},`,
          intro: `Deine Anmeldung für <strong>${data.cycleName || 'Training'}</strong>${data.ownerName ? ` bei <strong>${data.ownerName}</strong>` : ''} wurde empfangen.`,
          footer: `Bei Fragen ${data.ownerName ? `wende dich direkt an ${data.ownerName}` : 'wende dich an deinen Trainer oder deine Akademie'}.`,
          regards: 'Sportliche Grüße,',
          detailsTitle: 'Anmeldedetails',
          startDate: 'Startdatum',
          endDate: 'Enddatum',
          deadline: 'Anmeldefrist',
          yourRegistration: 'Deine Anmeldung',
          lessonType: 'Unterrichtsart',
          duration: 'Dauer',
          sessionsWeek: 'Sitzungen/Woche',
          location: 'Standort',
          level: 'Niveau',
          notes: 'Anmerkungen',
          min: 'Min',
          phone: 'Telefon',
          birthDate: 'Geburtsdatum',
          package_: 'Paket',
          durationWeeks: 'Dauer',
          pricePerLesson: 'Pro Lektion',
          totalPrice: 'Gesamt',
          priceSummary: 'Preisindikation',
          weeks: 'Wochen',
        },
        fr: {
          subject: `Inscription confirmée : ${data.cycleName || 'Entraînement'} 🎾`,
          greeting: `Bonjour ${data.playerName},`,
          intro: `Votre inscription pour <strong>${data.cycleName || 'entraînement'}</strong>${data.ownerName ? ` chez <strong>${data.ownerName}</strong>` : ''} a été reçue.`,
          footer: `Si vous avez des questions, ${data.ownerName ? `contactez ${data.ownerName} directement` : 'contactez votre entraîneur ou académie'}.`,
          regards: 'Cordialement,',
          detailsTitle: 'Détails d\'inscription',
          startDate: 'Date de début',
          endDate: 'Date de fin',
          deadline: 'Date limite',
          yourRegistration: 'Votre inscription',
          lessonType: 'Type de cours',
          duration: 'Durée',
          sessionsWeek: 'Séances/semaine',
          location: 'Lieu',
          level: 'Niveau',
          notes: 'Remarques',
          min: 'min',
          phone: 'Téléphone',
          birthDate: 'Date de naissance',
          package_: 'Forfait',
          durationWeeks: 'Durée',
          pricePerLesson: 'Par cours',
          totalPrice: 'Total',
          priceSummary: 'Indication de prix',
          weeks: 'semaines',
        },
      };
      const t = translations[lang] || translations.en;

      // Confirmation text from the academy/club (shown first, above details)
      const confirmationSection = data.confirmationText
        ? `<div style="background: #fff7ed; padding: 16px; border-radius: 8px; margin: 16px 0; border-left: 4px solid ${BRAND_ORANGE};">
             <p style="margin: 0; white-space: pre-line;">${data.confirmationText}</p>
           </div>`
        : '';

      // Format dates nicely
      const formatDate = (dateStr?: string) => {
        if (!dateStr) return null;
        try {
          // Append T12:00:00 to date-only strings to avoid timezone shift (UTC midnight → previous day in CET)
          const safe = dateStr.length === 10 ? `${dateStr}T12:00:00` : dateStr;
          const d = new Date(safe);
          return d.toLocaleDateString(lang === 'nl' ? 'nl-NL' : lang === 'de' ? 'de-DE' : lang === 'fr' ? 'fr-FR' : lang === 'es' ? 'es-ES' : 'en-GB', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
          });
        } catch { return dateStr; }
      };

      // Localized lesson type labels
      const lessonTypeLabels: Record<string, Record<string, string>> = {
        en: { private: 'Private (1:1)', duo: 'Duo (2 players)', group: 'Group (3 or 4 players)', group3: 'Group (3 players)', group4: 'Group (4 players)', kids: 'Kids Training' },
        nl: { private: 'Privé (1:1)', duo: 'Duo (2 spelers)', group: 'Groep (3 of 4 spelers)', group3: 'Groep (3 spelers)', group4: 'Groep (4 spelers)', kids: 'Kindertraining' },
        es: { private: 'Privado (1:1)', duo: 'Dúo (2 jugadores)', group: 'Grupo (3 o 4 jugadores)', group3: 'Grupo (3 jugadores)', group4: 'Grupo (4 jugadores)', kids: 'Entrenamiento infantil' },
        de: { private: 'Privat (1:1)', duo: 'Duo (2 Spieler)', group: 'Gruppe (3 oder 4 Spieler)', group3: 'Gruppe (3 Spieler)', group4: 'Gruppe (4 Spieler)', kids: 'Kindertraining' },
        fr: { private: 'Privé (1:1)', duo: 'Duo (2 joueurs)', group: 'Groupe (3 ou 4 joueurs)', group3: 'Groupe (3 joueurs)', group4: 'Groupe (4 joueurs)', kids: 'Entraînement enfants' },
      };
      const ltLabels = lessonTypeLabels[lang] || lessonTypeLabels.en;

      // Build cycle info rows
      const infoRows: string[] = [];
      if (data.startDate) infoRows.push(`<p style="margin: 4px 0;"><strong>${t.startDate}:</strong> ${formatDate(data.startDate)}</p>`);
      if (data.endDate) infoRows.push(`<p style="margin: 4px 0;"><strong>${t.endDate}:</strong> ${formatDate(data.endDate)}</p>`);
      if (data.enrollmentDeadline) infoRows.push(`<p style="margin: 4px 0;"><strong>${t.deadline}:</strong> ${formatDate(data.enrollmentDeadline)}</p>`);
      if (data.locationName) infoRows.push(`<p style="margin: 4px 0;"><strong>${t.location}:</strong> ${data.locationName}</p>`);

      const detailsBlock = infoRows.length > 0
        ? `<div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 16px 0;">
             <h3 style="margin-top: 0; margin-bottom: 12px;">${t.detailsTitle}</h3>
             ${data.cycleName ? `<p style="margin: 4px 0; font-size: 16px; font-weight: bold;">${data.cycleName}</p>` : ''}
             ${data.ownerName ? `<p style="margin: 4px 0; color: #6b7280;">${data.ownerName}</p>` : ''}
             <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 12px 0;" />
             ${infoRows.join('')}
           </div>`
        : `<div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 16px 0;">
             ${data.cycleName ? `<h3 style="margin-top: 0;">${data.cycleName}</h3>` : ''}
             ${data.ownerName ? `<p><strong>${data.ownerName}</strong></p>` : ''}
           </div>`;

      // Build registration summary (what they filled out)
      const summaryRows: string[] = [];
      if (data.phone) summaryRows.push(`<p style="margin: 4px 0;"><strong>${t.phone}:</strong> ${data.phone}</p>`);
      if (data.birthDate) summaryRows.push(`<p style="margin: 4px 0;"><strong>${t.birthDate}:</strong> ${formatDate(data.birthDate) || data.birthDate}</p>`);
      if (data.lessonTypes && data.lessonTypes.length > 0) summaryRows.push(`<p style="margin: 4px 0;"><strong>${t.lessonType}:</strong> ${data.lessonTypes.join(', ')}</p>`);
      if (data.preferredDurationMinutes) summaryRows.push(`<p style="margin: 4px 0;"><strong>${t.duration}:</strong> ${data.preferredDurationMinutes} ${t.min}</p>`);
      if (data.sessionsPerWeek) summaryRows.push(`<p style="margin: 4px 0;"><strong>${t.sessionsWeek}:</strong> ${data.sessionsPerWeek}</p>`);
      if (data.selectedPackageLabel) summaryRows.push(`<p style="margin: 4px 0;"><strong>${t.package_}:</strong> ${data.selectedPackageLabel}</p>`);
      if (data.selectedDurationWeeks) summaryRows.push(`<p style="margin: 4px 0;"><strong>${t.durationWeeks}:</strong> ${data.selectedDurationWeeks} ${t.weeks}</p>`);
      if (data.rating) summaryRows.push(`<p style="margin: 4px 0;"><strong>${t.level}:</strong> ${data.rating}${data.ratingSystem ? ` (${data.ratingSystem.toUpperCase()})` : ''}</p>`);
      if (data.notes) summaryRows.push(`<p style="margin: 4px 0;"><strong>${t.notes}:</strong> ${data.notes}</p>`);

      const summaryBlock = summaryRows.length > 0
        ? `<div style="background: #f9fafb; padding: 16px; border-radius: 8px; margin: 16px 0; border: 1px solid #e5e7eb;">
             <h4 style="margin-top: 0; margin-bottom: 8px; color: #374151;">${t.yourRegistration}</h4>
             ${summaryRows.join('')}
           </div>`
        : '';

      // Build price summary block
      const priceRows = (data.priceLines || []) as Array<{ label: string; perLesson: string; total: string }>;
      const priceBlock = priceRows.length > 0
        ? `<div style="background: #fff7ed; padding: 16px; border-radius: 8px; margin: 16px 0; border: 1px solid #fed7aa;">
             <h4 style="margin-top: 0; margin-bottom: 12px; color: #374151;">💰 ${t.priceSummary}</h4>
             <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
               <thead>
                 <tr style="border-bottom: 1px solid #fdba74;">
                   <th style="text-align: left; padding: 6px 0; color: #6b7280;">${t.lessonType}</th>
                   <th style="text-align: right; padding: 6px 0; color: #6b7280;">${t.pricePerLesson}</th>
                   ${data.selectedDurationWeeks ? `<th style="text-align: right; padding: 6px 0; color: #6b7280;">${t.totalPrice} (${data.selectedDurationWeeks} ${t.weeks})</th>` : ''}
                 </tr>
               </thead>
               <tbody>
                 ${priceRows.map(row => `
                   <tr style="border-bottom: 1px solid #f3f4f6;">
                     <td style="padding: 6px 0;">${row.label}</td>
                     <td style="text-align: right; padding: 6px 0; font-weight: 600;">${row.perLesson}</td>
                     ${data.selectedDurationWeeks && row.total ? `<td style="text-align: right; padding: 6px 0; font-weight: 600;">${row.total}</td>` : ''}
                   </tr>
                 `).join('')}
               </tbody>
             </table>
           </div>`
        : '';

      return {
        subject: t.subject,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            ${EMAIL_LOGO}
            <p>${t.greeting}</p>
            <p>${t.intro}</p>
            ${confirmationSection}
            ${detailsBlock}
            ${summaryBlock}
            ${priceBlock}
            <p>${t.footer}</p>
            <p>${t.regards}<br><a href="https://padeltrainer.ai" style="color: ${BRAND_ORANGE}; text-decoration: none;">PadelTrainer.ai</a> Team</p>
          </div>
        `,
      };
    }

    default:
      return {
        subject: "PadelTrainer.ai Notification",
        html: "<p>You have a new notification from PadelTrainer.ai.</p>",
      };
  }
};

// Rate limiting configuration per endpoint
const RATE_LIMITS: Record<string, { max: number; windowMinutes: number }> = {
  partner_inquiry: { max: 3, windowMinutes: 60 },
  location_request: { max: 5, windowMinutes: 60 },
};

// Database-backed rate limiting for persistence across cold starts
async function checkRateLimitDb(
  supabaseClient: any,
  identifier: string,
  endpoint: string
): Promise<{ allowed: boolean; remaining: number }> {
  const config = RATE_LIMITS[endpoint] || { max: 5, windowMinutes: 60 };
  const windowStart = new Date(Date.now() - config.windowMinutes * 60 * 1000);

  try {
    // Check existing record
    const { data: existing } = await supabaseClient
      .from('rate_limits')
      .select('*')
      .eq('identifier', identifier)
      .eq('endpoint', endpoint)
      .single();

    if (existing) {
      const recordWindowStart = new Date(existing.window_start);
      
      // Check if within current window
      if (recordWindowStart > windowStart) {
        if (existing.request_count >= config.max) {
          return { allowed: false, remaining: 0 };
        }
        
        // Increment counter
        await supabaseClient
          .from('rate_limits')
          .update({ request_count: existing.request_count + 1 })
          .eq('id', existing.id);
        
        return { allowed: true, remaining: config.max - existing.request_count - 1 };
      }
      
      // Window expired - reset
      await supabaseClient
        .from('rate_limits')
        .update({ request_count: 1, window_start: new Date().toISOString() })
        .eq('id', existing.id);
      
      return { allowed: true, remaining: config.max - 1 };
    }

    // Create new record
    await supabaseClient
      .from('rate_limits')
      .insert({
        identifier,
        endpoint,
        request_count: 1,
        window_start: new Date().toISOString(),
      });

    return { allowed: true, remaining: config.max - 1 };
  } catch (error) {
    console.error('Rate limit check error:', error);
    // Fail open - allow request if rate limiting fails
    return { allowed: true, remaining: 1 };
  }
}

// Server-side validation for partner inquiry
function validatePartnerInquiry(data: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // Validate name
  if (!data.name || typeof data.name !== 'string') {
    errors.push('Name is required');
  } else if (data.name.trim().length < 2) {
    errors.push('Name must be at least 2 characters');
  } else if (data.name.length > 100) {
    errors.push('Name must be less than 100 characters');
  }
  
  // Validate company name
  if (!data.companyName || typeof data.companyName !== 'string') {
    errors.push('Company name is required');
  } else if (data.companyName.trim().length < 2) {
    errors.push('Company name must be at least 2 characters');
  } else if (data.companyName.length > 100) {
    errors.push('Company name must be less than 100 characters');
  }
  
  // Validate email
  if (!data.email || typeof data.email !== 'string') {
    errors.push('Email is required');
  } else if (data.email.length > 255) {
    errors.push('Email must be less than 255 characters');
  } else {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(data.email)) {
      errors.push('Invalid email address');
    }
  }
  
  // Validate phone
  if (!data.phone || typeof data.phone !== 'string') {
    errors.push('Phone is required');
  } else if (data.phone.length < 6) {
    errors.push('Phone must be at least 6 characters');
  } else if (data.phone.length > 20) {
    errors.push('Phone must be less than 20 characters');
  }
  
  // Validate message
  if (!data.message || typeof data.message !== 'string') {
    errors.push('Message is required');
  } else if (data.message.trim().length < 10) {
    errors.push('Message must be at least 10 characters');
  } else if (data.message.length > 2000) {
    errors.push('Message must be less than 2000 characters');
  }
  
  return { valid: errors.length === 0, errors };
}

// Basic HTML sanitization for email content
function sanitizeForHtml(str: string): string {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    
    // Verify authentication (except for partner_inquiry which is public)
    const authHeader = req.headers.get("Authorization");
    const { type, to, data, language }: EmailRequest = await req.json();
    
    // Allow partner_inquiry and location_request without auth (public forms)
    const isPublicForm = type === "partner_inquiry" || type === "location_request";
    
    // Create supabase client for rate limiting (service role needed for rate_limits table)
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    
    if (isPublicForm) {
      // Get client IP for rate limiting
      const clientIp = req.headers.get("x-forwarded-for")?.split(',')[0]?.trim() || 
                       req.headers.get("cf-connecting-ip") || 
                       "unknown";
      
      // Check rate limit using database for persistence
      const rateLimit = await checkRateLimitDb(supabaseAdmin, clientIp, type);
      if (!rateLimit.allowed) {
        console.log(`Rate limit exceeded for IP: ${clientIp}, endpoint: ${type}`);
        return new Response(
          JSON.stringify({ error: "Too many requests. Please try again later." }),
          { 
            status: 429, 
            headers: { 
              "Content-Type": "application/json", 
              "Retry-After": "3600",
              ...corsHeaders 
            } 
          }
        );
      }
      
      // Validate partner inquiry data server-side
      const validation = validatePartnerInquiry(data);
      if (!validation.valid) {
        console.log("Partner inquiry validation failed:", validation.errors);
        return new Response(
          JSON.stringify({ error: "Validation failed", details: validation.errors }),
          { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
      
      // For partner_inquiry, only allow sending to the designated email
      if (to !== "info@padeltrainer.ai") {
        console.error("Partner inquiry attempted to send to unauthorized address:", to);
        return new Response(
          JSON.stringify({ error: "Invalid recipient" }),
          { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
      
      // Sanitize user input before using in HTML email
      data.name = sanitizeForHtml(data.name || '');
      data.companyName = sanitizeForHtml(data.companyName || '');
      data.email = sanitizeForHtml(data.email || '');
      data.phone = sanitizeForHtml(data.phone || '');
      data.message = sanitizeForHtml(data.message || '');
      
      console.log("Partner inquiry email (public form submission) - validated and rate limited");
    } else {
      if (!authHeader) {
        console.error("No authorization header provided");
        return new Response(
          JSON.stringify({ error: "Authentication required" }),
          { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }

      const token = authHeader.replace("Bearer ", "");
      
      // Allow service role key to bypass user auth check (for internal calls)
      const isServiceRole = token === supabaseServiceKey;
      
      if (!isServiceRole) {
        const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
        
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

    // Map email type to notification preference column
    const TYPE_TO_PREF_COLUMN: Record<string, string> = {
      booking_confirmation: "booking_confirmation",
      manual_booking_confirmation: "booking_confirmation",
      booking_reminder: "booking_reminder",
      booking_cancelled: "booking_cancelled",
      review_received: "new_review",
      payment_confirmed_player: "payment_receipt",
      payment_confirmed_trainer: "payment_received",
      new_booking_trainer: "new_booking",
      booking_request: "new_booking",
      new_availability: "open_slots_digest",
      slot_reopened: "open_slots_digest",
      payment_reminder: "payment_receipt",
    };

    // System emails that should never be filtered
    const SYSTEM_EMAIL_TYPES = [
      "password_reset_admin", "club_claim_approved", "club_claim_rejected",
      "club_trainer_invitation", "club_trainer_invitation_accepted",
      "partner_inquiry", "location_request",
      "booking_approved_payment", "booking_approved_invoice", "booking_rejected",
      "intake_registration_confirmation",
    ];

    const prefColumn = TYPE_TO_PREF_COLUMN[type];
    const isSystemEmail = SYSTEM_EMAIL_TYPES.includes(type);

    // Check notification preferences if applicable
    if (prefColumn && !isSystemEmail) {
      const recipientId = (data as any).userId || null;
      let recipientUserId = recipientId;

      // Try to look up user by email if no userId provided
      if (!recipientUserId) {
        const { data: profile } = await supabaseAdmin
          .from("profiles")
          .select("user_id")
          .eq("email", to)
          .maybeSingle();
        recipientUserId = profile?.user_id;
      }

      if (recipientUserId) {
        const { data: prefs } = await supabaseAdmin
          .from("notification_preferences")
          .select(prefColumn)
          .eq("user_id", recipientUserId)
          .maybeSingle();

        const frequency = (prefs as Record<string, string> | null)?.[prefColumn] || "instant";

        if (frequency === "off") {
          console.log(`Notification ${type} suppressed for user ${recipientUserId} (preference: off)`);
          return new Response(JSON.stringify({ skipped: true, reason: "notification_disabled" }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        if (frequency === "daily" || frequency === "weekly") {
          // Queue for digest instead of sending immediately
          const { error: queueErr } = await supabaseAdmin
            .from("notification_queue")
            .insert({
              user_id: recipientUserId,
              notification_type: prefColumn,
              payload: { type, to, data, language, subject: getEmailContent(type, data, language).subject },
              scheduled_for: frequency,
            });

          if (queueErr) {
            console.error("Error queuing notification:", queueErr);
            // Fall through to send immediately on queue error
          } else {
            console.log(`Notification ${type} queued for ${frequency} digest for user ${recipientUserId}`);
            return new Response(JSON.stringify({ queued: true, frequency }), {
              status: 200,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            });
          }
        }
      }
    }

    const { subject, html: emailHtml } = getEmailContent(type, data, language);

    // Add manage notifications footer (except for system emails)
    let finalHtml = emailHtml;
    if (!isSystemEmail) {
      const notifPath = type.startsWith("new_booking") || type === "booking_request" || type === "review_received" || type === "payment_confirmed_trainer"
        ? "/app/trainer/settings/notifications"
        : "/app/player/settings/notifications";

      finalHtml += `
        <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb;">
          <p style="color: #6b7280; font-size: 12px; text-align: center;">
            You're receiving this email from PadelTrainer.ai.<br/>
            <a href="https://padeltrainer.ai${notifPath}" style="color: #6b7280; text-decoration: underline;">Manage email notifications</a>
          </p>
        </div>
      `;
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: "PadelTrainer.ai <noreply@app.padeltrainer.ai>",
        to: [to],
        subject,
        html: finalHtml,
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
