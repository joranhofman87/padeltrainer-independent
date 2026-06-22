import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';

export type PlayerLocation = { location_id: string; location_name: string };

/** A single player's displayed clubs (academy scope) — the same union the players
 *  table shows (trained ∪ preferred ∪ intake ∪ manual − dismissed). Source of truth. */
export async function fetchPlayerLocations(params: {
  academyProfileId: string;
  profileId: string | null;
  guestPlayerId: string | null;
}): Promise<PlayerLocation[]> {
  const { data, error } = await supabase.rpc('get_player_locations', {
    p_academy_profile_id: params.academyProfileId,
    // Pass null, not undefined: supabase-js drops undefined keys from the JSON
    // body, which leaves PostgREST unable to resolve the 3-arg function (it has
    // no defaults) → PGRST202. Explicit null keeps all params present.
    p_profile_id: params.profileId ?? null,
    p_guest_player_id: params.guestPlayerId ?? null,
  });
  if (error) throw error;
  return (data ?? []) as PlayerLocation[];
}

export function playerLocationsQueryKey(
  academyProfileId: string | null | undefined,
  profileId: string | null,
  guestPlayerId: string | null,
) {
  return ['player-locations', academyProfileId ?? null, profileId ?? null, guestPlayerId ?? null] as const;
}

export function usePlayerLocations(params: {
  academyProfileId: string | null | undefined;
  profileId: string | null;
  guestPlayerId: string | null;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: playerLocationsQueryKey(params.academyProfileId, params.profileId, params.guestPlayerId),
    queryFn: () =>
      fetchPlayerLocations({
        academyProfileId: params.academyProfileId!,
        profileId: params.profileId,
        guestPlayerId: params.guestPlayerId,
      }),
    enabled: (params.enabled ?? true) && Boolean(params.academyProfileId) && Boolean(params.profileId || params.guestPlayerId),
  });
}

/** Attach (dismissed=false → force-show) or detach (dismissed=true → suppress) a club
 *  for a player. Idempotent server-side. */
export async function setPlayerLocation(params: {
  academyProfileId: string;
  profileId: string | null;
  guestPlayerId: string | null;
  locationId: string;
  dismissed: boolean;
}): Promise<void> {
  const { error } = await supabase.rpc('set_player_location', {
    p_academy_profile_id: params.academyProfileId,
    // Pass null, not undefined: supabase-js drops undefined keys from the JSON
    // body, which leaves PostgREST unable to resolve the 3-arg function (it has
    // no defaults) → PGRST202. Explicit null keeps all params present.
    p_profile_id: params.profileId ?? null,
    p_guest_player_id: params.guestPlayerId ?? null,
    p_location_id: params.locationId,
    p_dismissed: params.dismissed,
  });
  if (error) throw error;
}
