export const academyPlayersQueryKey = (academyId: string | undefined | null) =>
  ['academy-players', academyId] as const;
