import { playerKeys } from '@/lib/playerQueryKeys';

/** Legacy alias — now lives in the central ['players', ...] subtree so any
 * scope-wide invalidation (invalidateAllPlayerData) covers it. */
export const academyPlayersQueryKey = (academyId: string | undefined | null) =>
  playerKeys.scope('academy', academyId);
