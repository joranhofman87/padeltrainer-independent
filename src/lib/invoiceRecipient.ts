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

/** Trainer has no per-player detail route; list page only when an id exists. */
export function getTrainerPlayersListPath(
  playerId: string | null | undefined,
  guestPlayerId: string | null | undefined,
): string | null {
  if (playerId || guestPlayerId) return '/app/trainer/players';
  return null;
}
