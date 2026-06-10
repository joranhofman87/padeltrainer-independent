export const trainerPlayersQueryKey = (trainerId: string | undefined | null) =>
  ['trainer-players', trainerId] as const;
