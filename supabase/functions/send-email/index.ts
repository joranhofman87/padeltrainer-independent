import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface EmailRequest {
  type: "booking_confirmation" | "booking_reminder" | "booking_cancelled" | "review_received" | "payment_confirmed_player" | "payment_confirmed_trainer" | "new_booking_trainer" | "new_availability" | "manual_booking_confirmation" | "slot_reopened" | "booking_request" | "booking_approved_payment" | "booking_approved_invoice" | "booking_rejected" | "club_claim_approved" | "club_claim_rejected" | "club_trainer_invitation" | "club_trainer_invitation_accepted" | "partner_inquiry" | "location_request" | "password_reset_admin";
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
            <h1 style="color: #2563eb;">Session Reminder 🎾</h1>
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
            <h1 style="color: #16a34a;">Payment Successful! 💳</h1>
            <p>Hi ${data.playerName},</p>
            <p>Your payment has been confirmed and your training session is booked!</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0;">${data.lessonTitle}</h3>
              <p><strong>Trainer:</strong> ${data.trainerName}</p>
              <p><strong>Date:</strong> ${data.lessonDate}</p>
              <p><strong>Time:</strong> ${data.lessonTime}</p>
              <p><strong>Location:</strong> ${data.location || "TBD"}</p>
              <p style="font-size: 18px; color: #16a34a;"><strong>Amount Paid:</strong> €${data.price}</p>
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
            <h1 style="color: #16a34a;">You've Got a New Booking! 🎉</h1>
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
              <p style="font-size: 18px; color: #16a34a;"><strong>Your Earnings:</strong> €${data.netAmount?.toFixed(2) || (data.price ? (data.price - (data.platformFee || 1.00)).toFixed(2) : '0.00')}</p>
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
            <h1 style="color: #16a34a;">New Availability Alert! 📅</h1>
            <p>Hi ${data.playerName},</p>
            <p>Great news! <strong>${data.trainerName}</strong> has just added new training slots.</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <p style="font-size: 24px; font-weight: bold; color: #16a34a; margin: 0;">${data.slotCount} New Slots</p>
              <p style="color: #6b7280; margin-top: 8px;">Available: ${data.dateRange}</p>
            </div>
            <p>Don't miss out – book your spot before they fill up!</p>
            <p style="margin-top: 24px;">
              <a href="https://padeltrainer.ai/nl/trainers" style="background: #16a34a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Book Now</a>
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
            <h1 style="color: #16a34a;">Slot Just Opened! 📅</h1>
            <p>Hi ${data.playerName},</p>
            <p>A training slot with <strong>${data.trainerName}</strong> just became available!</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <p><strong>Date:</strong> ${data.slotDate}</p>
              <p><strong>Time:</strong> ${data.slotTime}</p>
            </div>
            <p>Book now before someone else does!</p>
            <p style="margin-top: 24px;">
              <a href="https://padeltrainer.ai/nl/trainers" style="background: #16a34a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Book Now</a>
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
            <h1 style="color: #16a34a;">You're Booked! 🎾</h1>
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
            <h1 style="color: #2563eb;">New Booking Request! 📬</h1>
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
              <a href="${data.bookingUrl || 'https://padeltrainer.ai/app/trainer/bookings'}" style="background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Review Request</a>
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
              <a href="https://padeltrainer.ai/nl/trainers" style="background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Find Another Lesson</a>
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
              <a href="https://padeltrainer.ai/app/club" style="background: #16a34a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Go to Club Dashboard</a>
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
              <a href="https://padeltrainer.ai/app/club/trainers" style="background: #16a34a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">View Club Trainers</a>
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

    case "location_request":
      return {
        subject: `New Club Request: ${data.clubName} (${data.city})`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #2563eb;">New Club Request 📍</h1>
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
            <h1 style="color: #2563eb;">Password Reset 🔐</h1>
            <p>Hi ${data.userName},</p>
            <p>An administrator has requested a password reset for your account.</p>
            <p style="margin-top: 24px;">
              <a href="${data.resetLink}" style="background: #16a34a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Reset Password</a>
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
    const { type, to, data }: EmailRequest = await req.json();
    
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
