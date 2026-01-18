import { supabase } from "@/integrations/supabase/client";

export type EmailType = 
  | "booking_confirmation" 
  | "booking_reminder" 
  | "booking_cancelled" 
  | "review_received"
  | "payment_confirmed_player"
  | "payment_confirmed_trainer"
  | "new_booking_trainer"
  | "new_availability"
  | "manual_booking_confirmation"
  | "slot_reopened"
  | "booking_request"
  | "booking_approved_payment"
  | "booking_approved_invoice"
  | "booking_rejected";

export interface EmailData {
  playerName?: string;
  playerEmail?: string;
  trainerName?: string;
  lessonTitle?: string;
  lessonDate?: string;
  lessonTime?: string;
  location?: string;
  price?: number;
  rating?: number;
  platformFee?: number;
  netAmount?: number;
  paymentLink?: string;
  reason?: string;
  bookingUrl?: string;
}

/**
 * Sends an email using the send-email edge function.
 * Automatically includes authentication headers for security.
 */
export const sendEmail = async (
  type: EmailType,
  to: string,
  data: EmailData
): Promise<{ success: boolean; error?: string }> => {
  try {
    // Get the current session for authentication
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session?.access_token) {
      console.error("No active session for sending email");
      return { success: false, error: "Authentication required" };
    }

    const { data: response, error } = await supabase.functions.invoke("send-email", {
      body: { type, to, data },
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    });

    if (error) {
      console.error("Error sending email:", error);
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err: any) {
    console.error("Error invoking send-email function:", err);
    return { success: false, error: err.message };
  }
};

export const sendBookingConfirmation = async (
  playerEmail: string,
  playerName: string,
  trainerName: string,
  lessonTitle: string,
  lessonDate: string,
  lessonTime: string,
  location: string | null,
  price: number
) => {
  return sendEmail("booking_confirmation", playerEmail, {
    playerName,
    trainerName,
    lessonTitle,
    lessonDate,
    lessonTime,
    location: location || undefined,
    price,
  });
};

export const sendBookingCancellation = async (
  playerEmail: string,
  playerName: string,
  trainerName: string,
  lessonTitle: string,
  lessonDate: string,
  lessonTime: string
) => {
  return sendEmail("booking_cancelled", playerEmail, {
    playerName,
    trainerName,
    lessonTitle,
    lessonDate,
    lessonTime,
  });
};

export const sendReviewNotification = async (
  trainerEmail: string,
  trainerName: string,
  playerName: string,
  lessonTitle: string,
  rating: number
) => {
  return sendEmail("review_received", trainerEmail, {
    trainerName,
    playerName,
    lessonTitle,
    rating,
  });
};
