export type InvoiceRecipientKind = 'registered' | 'guest' | 'manual';

export type InvoiceDetailOwner = 'academy' | 'trainer';

export function getInvoiceRecipientKind(
  playerId: string | null | undefined,
  guestPlayerId: string | null | undefined,
): InvoiceRecipientKind {
  if (playerId) return 'registered';
  if (guestPlayerId) return 'guest';
  return 'manual';
}

export function getAcademyPlayerProfilePath(
  playerId: string | null | undefined,
  guestPlayerId: string | null | undefined,
): string | null {
  if (playerId) return `/app/academy/players/p_${playerId}`;
  if (guestPlayerId) return `/app/academy/players/g_${guestPlayerId}`;
  return null;
}

export function getTrainerPlayerProfilePath(
  playerId: string | null | undefined,
  guestPlayerId: string | null | undefined,
): string | null {
  if (playerId) return `/app/trainer/players/p_${playerId}`;
  if (guestPlayerId) return `/app/trainer/players/g_${guestPlayerId}`;
  return null;
}

/** @deprecated Use getTrainerPlayerProfilePath */
export function getTrainerPlayersListPath(
  playerId: string | null | undefined,
  guestPlayerId: string | null | undefined,
): string | null {
  return getTrainerPlayerProfilePath(playerId, guestPlayerId);
}
