import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type BookingAccessRow = {
  player_id: string | null;
  availability_slots: {
    trainer_id: string;
    academy_profile_id: string | null;
  } | null;
};

/** Player, trainer, academy manager, or admin (e.g. get-booking-invoice). */
export async function canAccessBooking(
  supabase: SupabaseClient,
  userId: string,
  booking: BookingAccessRow,
): Promise<boolean> {
  const slot = booking.availability_slots;
  if (!slot) return false;

  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();

  if (profile?.id && booking.player_id === profile.id) {
    return true;
  }

  const { data: trainerProfile } = await supabase
    .from("trainer_profiles")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();

  if (trainerProfile?.id === slot.trainer_id) {
    return true;
  }

  if (slot.academy_profile_id) {
    const { data: manager } = await supabase
      .from("academy_managers")
      .select("id")
      .eq("user_id", userId)
      .eq("academy_profile_id", slot.academy_profile_id)
      .maybeSingle();
    if (manager) return true;
  }

  const { data: adminRole } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();

  return !!adminRole;
}

/** Booking owner or admin — used by verify-mollie-payment fallback. */
export async function canPlayerVerifyMolliePayment(
  supabase: SupabaseClient,
  userId: string,
  booking: { player_id: string | null },
): Promise<boolean> {
  if (!booking.player_id) return false;

  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();

  if (profile?.id === booking.player_id) {
    return true;
  }

  const { data: adminRole } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();

  return !!adminRole;
}

export function metadataReferencesBooking(
  metadata: Record<string, unknown> | null | undefined,
  bookingId: string,
): boolean {
  if (!metadata) return false;
  const single = metadata.booking_id;
  if (single === bookingId) return true;
  const ids = metadata.booking_ids;
  if (Array.isArray(ids)) {
    return ids.some((id) => String(id) === bookingId);
  }
  return false;
}
