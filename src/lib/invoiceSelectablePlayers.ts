import { supabase } from '@/lib/supabaseClient';
import { fetchAllPlayersOverview, fetchPlayersOverview, type PlayersOverviewRow } from '@/lib/playersOverview';
import type { PlayerScope } from '@/lib/playerQueryKeys';

export type InvoiceSelectablePlayer = {
  comboboxId: string;
  full_name: string;
  email: string;
  phone: string;
  type: 'guest' | 'registered';
  profileId: string | null;
  guestPlayerId: string | null;
  /** Canonical Player identity (U2) — what a pick hands to the invoice write. */
  personId: string | null;
  billing_business_name: string | null;
  billing_address: string | null;
  billing_btw_number: string | null;
};

export function overviewRowToInvoiceSelectablePlayer(row: PlayersOverviewRow): InvoiceSelectablePlayer {
  return {
    comboboxId: row.player_key,
    full_name: row.full_name,
    email: row.email,
    phone: row.phone,
    type: row.player_type as 'guest' | 'registered',
    profileId: row.profile_id ?? null,
    guestPlayerId: row.guest_player_id ?? null,
    personId: row.person_id ?? null,
    billing_business_name: row.billing_business_name ?? null,
    billing_address: row.billing_address ?? null,
    billing_btw_number: row.billing_btw_number ?? null,
  };
}

/**
 * Server-side picker search via the get_players_overview RPC (name/email/
 * business/phone-digit matching, removal filtering and linked-player dedupe
 * all happen in the database). Returns the first page of matches.
 */
export async function searchInvoiceSelectablePlayers(
  scope: PlayerScope,
  search: string,
): Promise<InvoiceSelectablePlayer[]> {
  const { rows } = await fetchPlayersOverview(scope, { search, pageSize: 50 });
  return rows.map(overviewRowToInvoiceSelectablePlayer);
}

/** Complete scoped list via the overview RPC (membership rules enforced in SQL). */
export async function fetchAcademyInvoiceSelectablePlayers(
  academyProfileId: string,
): Promise<InvoiceSelectablePlayer[]> {
  const rows = await fetchAllPlayersOverview({ kind: 'academy', id: academyProfileId });
  return rows.map(overviewRowToInvoiceSelectablePlayer);
}

export async function fetchTrainerInvoiceSelectablePlayers(
  trainerId: string,
): Promise<InvoiceSelectablePlayer[]> {
  const rows = await fetchAllPlayersOverview({ kind: 'trainer', id: trainerId });
  return rows.map(overviewRowToInvoiceSelectablePlayer);
}

export type InvoicePrefillScope =
  | { kind: 'academy'; academyProfileId: string }
  | { kind: 'trainer'; trainerId: string };

export function matchInvoicePrefillPlayer(
  players: InvoiceSelectablePlayer[],
  parsed: { kind: 'guest'; guestPlayerId: string } | { kind: 'profile'; profileId: string },
): InvoiceSelectablePlayer | null {
  if (parsed.kind === 'guest') {
    return players.find((p) => p.guestPlayerId === parsed.guestPlayerId) ?? null;
  }
  return players.find((p) => p.profileId === parsed.profileId) ?? null;
}

/** Prefill only when the player is in the scoped selectable list (same rules as manual search). */
export async function fetchInvoicePlayerForPrefill(
  parsed: { kind: 'guest'; guestPlayerId: string } | { kind: 'profile'; profileId: string },
  scope: InvoicePrefillScope,
): Promise<InvoiceSelectablePlayer | null> {
  const players =
    scope.kind === 'academy'
      ? await fetchAcademyInvoiceSelectablePlayers(scope.academyProfileId)
      : await fetchTrainerInvoiceSelectablePlayers(scope.trainerId);

  return matchInvoicePrefillPlayer(players, parsed);
}

/** Registered player visible to trainer only if they have a booking on this trainer's slots. */
export async function isTrainerRegisteredPlayerVisible(
  trainerId: string,
  profileId: string,
): Promise<boolean> {
  const { data: slots } = await supabase
    .from('availability_slots')
    .select('id')
    .eq('trainer_id', trainerId);

  const slotIds = (slots || []).map((s) => s.id);
  if (slotIds.length === 0) return false;

  const { data: booking } = await supabase
    .from('bookings')
    .select('id')
    .eq('player_id', profileId)
    .in('slot_id', slotIds)
    .limit(1)
    .maybeSingle();

  return !!booking;
}
