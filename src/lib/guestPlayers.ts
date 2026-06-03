import { supabase } from "@/lib/supabaseClient";
import { logger } from "@/lib/logger";

/** Columns for calendar/agenda guest player lists (must match DB schema). */
export const GUEST_PLAYER_CALENDAR_SELECT =
  "id, full_name, skill_rating, rating_system, linked_profile_id";

export interface GuestPlayerRow {
  id: string;
  trainer_id: string | null;
  academy_profile_id: string | null;
  full_name: string;
  email: string | null;
  phone: string | null;
  skill_rating: number | null;
  rating_system: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  linked_profile_id: string | null;
  [key: string]: unknown;
}

export type GuestPlayerLoadStrategy = "academy" | "trainer" | "none";

export function getGuestPlayerLoadStrategy(
  academyId?: string | null,
  trainerId?: string | null,
): GuestPlayerLoadStrategy {
  if (academyId) {
    return "academy";
  }
  if (trainerId) {
    return "trainer";
  }
  return "none";
}

/** Academy guest loads filter by academy_profile_id only (no trainer_id IS NULL). */
export function usesAcademyProfileIdFilterOnly(): true {
  return true;
}

function toError(err: { message: string } | null): Error | null {
  if (!err) return null;
  return new Error(err.message);
}

export async function loadGuestPlayersForTrainer(
  trainerId: string,
): Promise<{ data: GuestPlayerRow[]; error: Error | null }> {
  const { data, error } = await supabase
    .from("guest_players")
    .select("*")
    .eq("trainer_id", trainerId)
    .order("full_name");

  if (error) {
    logger.error("Failed to load trainer guest players", new Error(error.message), {
      component: "guestPlayers",
      trainerId,
    });
    return { data: [], error: toError(error) };
  }

  return { data: (data as GuestPlayerRow[]) || [], error: null };
}

export async function loadGuestPlayersForAcademy(
  academyId: string,
): Promise<{ data: GuestPlayerRow[]; error: Error | null }> {
  const { data, error } = await supabase
    .from("guest_players")
    .select("*")
    .eq("academy_profile_id", academyId)
    .order("full_name");

  if (error) {
    logger.error("Failed to load academy guest players", new Error(error.message), {
      component: "guestPlayers",
      academyId,
    });
    return { data: [], error: toError(error) };
  }

  return { data: (data as GuestPlayerRow[]) || [], error: null };
}
