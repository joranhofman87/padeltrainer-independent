import { supabase } from "@/lib/supabaseClient";
import { logger } from "@/lib/logger";
import {
  fetchRemovedPlayerKeys,
  filterGuestRowsByRemoval,
  mergeRemovedPlayerKeys,
} from "@/lib/playerRemovalVisibility";

/** Columns for calendar/agenda guest player lists (must match DB schema). */
export const GUEST_PLAYER_CALENDAR_SELECT =
  "id, first_name, last_name, full_name, skill_rating, rating_system, linked_profile_id";

export interface GuestPlayerRow {
  id: string;
  trainer_id: string | null;
  academy_profile_id: string | null;
  first_name: string | null;
  last_name: string | null;
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

/** PostgREST column for academy-scoped guest lists (no trainer_id IS NULL filter). */
export const GUEST_PLAYER_ACADEMY_FILTER_COLUMN = "academy_profile_id";

/** PostgREST column for trainer-scoped guest lists. */
export const GUEST_PLAYER_TRAINER_FILTER_COLUMN = "trainer_id";

export function getGuestPlayerQueryFilter(
  strategy: GuestPlayerLoadStrategy,
  id: string,
): { column: string; value: string } | null {
  if (strategy === "academy") {
    return { column: GUEST_PLAYER_ACADEMY_FILTER_COLUMN, value: id };
  }
  if (strategy === "trainer") {
    return { column: GUEST_PLAYER_TRAINER_FILTER_COLUMN, value: id };
  }
  return null;
}

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

export async function loadGuestPlayersForBulkCreate(
  academyId?: string | null,
  trainerId?: string | null,
): Promise<{ data: GuestPlayerRow[]; error: Error | null }> {
  const strategy = getGuestPlayerLoadStrategy(academyId, trainerId);
  if (strategy === "academy" && academyId) {
    return loadGuestPlayersForAcademy(academyId);
  }
  if (strategy === "trainer" && trainerId) {
    return loadGuestPlayersForTrainer(trainerId);
  }
  return { data: [], error: null };
}

export async function loadGuestPlayersForTrainer(
  trainerId: string,
): Promise<{ data: GuestPlayerRow[]; error: Error | null }> {
  const filter = getGuestPlayerQueryFilter("trainer", trainerId)!;
  const { data, error } = await supabase
    .from("guest_players")
    .select("*")
    .eq(filter.column, filter.value)
    .order("full_name");

  if (error) {
    logger.error("Failed to load trainer guest players", new Error(error.message), {
      component: "guestPlayers",
      trainerId,
    });
    return { data: [], error: toError(error) };
  }

  const removedKeys = await fetchRemovedPlayerKeys({
    kind: "trainer",
    trainerProfileId: trainerId,
  });

  return {
    data: filterGuestRowsByRemoval((data as GuestPlayerRow[]) || [], removedKeys),
    error: null,
  };
}

export async function loadGuestPlayersForAcademy(
  academyId: string,
): Promise<{ data: GuestPlayerRow[]; error: Error | null }> {
  const filter = getGuestPlayerQueryFilter("academy", academyId)!;
  const { data, error } = await supabase
    .from("guest_players")
    .select("*")
    .eq(filter.column, filter.value)
    .order("full_name");

  if (error) {
    logger.error("Failed to load academy guest players", new Error(error.message), {
      component: "guestPlayers",
      academyId,
    });
    return { data: [], error: toError(error) };
  }

  const removedKeys = await fetchRemovedPlayerKeys({
    kind: "academy",
    academyProfileId: academyId,
  });

  return {
    data: filterGuestRowsByRemoval((data as GuestPlayerRow[]) || [], removedKeys),
    error: null,
  };
}

/** Guest list for booking/slot flows; applies trainer + optional academy removal. */
export async function loadActiveGuestPlayersForBooking(
  trainerId: string,
  academyProfileId?: string | null,
): Promise<{ data: GuestPlayerRow[]; error: Error | null }> {
  const { data, error } = await supabase
    .from("guest_players")
    .select("*")
    .eq("trainer_id", trainerId)
    .order("full_name");

  if (error) {
    logger.error("Failed to load bookable guest players", new Error(error.message), {
      component: "guestPlayers",
      trainerId,
      academyProfileId,
    });
    return { data: [], error: toError(error) };
  }

  const trainerKeys = await fetchRemovedPlayerKeys({
    kind: "trainer",
    trainerProfileId: trainerId,
  });

  const keys = academyProfileId
    ? mergeRemovedPlayerKeys(
        trainerKeys,
        await fetchRemovedPlayerKeys({ kind: "academy", academyProfileId }),
      )
    : trainerKeys;

  return {
    data: filterGuestRowsByRemoval((data as GuestPlayerRow[]) || [], keys),
    error: null,
  };
}
