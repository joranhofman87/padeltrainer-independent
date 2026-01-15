import { supabase } from "@/integrations/supabase/client";

export type EmailType = 
  | "booking_confirmation" 
  | "booking_reminder" 
  | "booking_cancelled" 
  | "review_received"
  | "payment_confirmed_player"
  | "payment_confirmed_trainer"
  | "new_booking_trainer";

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
}

export const sendEmail = async (
  type: EmailType,
  to: string,
  data: EmailData
): Promise<{ success: boolean; error?: string }> => {
  try {
    const { data: response, error } = await supabase.functions.invoke("send-email", {
      body: { type, to, data },
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
