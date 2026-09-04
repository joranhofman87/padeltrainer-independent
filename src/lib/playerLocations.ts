import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';
import { refuseOverlayWrite } from '@/lib/overlayWriteContainment';

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

/**
 * Attach (dismissed=false → force-show) or detach (dismissed=true → suppress) a club for a
 * player.
 *
 * ABC-16 H0: temporarily has no client writer. `set_player_location` is SECURITY DEFINER and
 * manager-gated, but its gate only proved the caller manages the ACADEMY — never that the
 * subject (a caller-supplied profile or guest id) has any relationship with it. It is the RPC
 * form of the direct `academy_player_locations` write, so it closes with it: the H0 migration
 * withdrew client EXECUTE. Reads are unchanged and every curated club still displays.
 */
export async function setPlayerLocation(_params: {
  academyProfileId: string;
  profileId: string | null;
  guestPlayerId: string | null;
  locationId: string;
  dismissed: boolean;
}): Promise<never> {
  refuseOverlayWrite('locations');
}
