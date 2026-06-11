import { playerKeys } from '@/lib/playerQueryKeys';

/** Legacy alias — now lives in the central ['players', ...] subtree so any
 * scope-wide invalidation (invalidateAllPlayerData) covers it. */
export const trainerPlayersQueryKey = (trainerId: string | undefined | null) =>
  playerKeys.scope('trainer', trainerId);
