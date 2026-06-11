import { supabase } from '@/lib/supabaseClient';
import { fetchUnifiedPlayersCore, type CorePlayer } from '@/lib/unifiedPlayers';

export type InvoiceSelectablePlayer = {
  comboboxId: string;
  full_name: string;
  email: string;
  phone: string;
  type: 'guest' | 'registered';
  profileId: string | null;
  guestPlayerId: string | null;
  billing_business_name: string | null;
  billing_address: string | null;
  billing_btw_number: string | null;
};

function coreToInvoiceSelectablePlayer(core: CorePlayer): InvoiceSelectablePlayer {
  return {
    comboboxId: core.key,
    full_name: core.full_name,
    email: core.email,
    phone: core.phone,
    type: core.type,
    profileId: core.profileId,
    guestPlayerId: core.guestPlayerId,
    billing_business_name: core.billing_business_name,
    billing_address: core.billing_address,
    billing_btw_number: core.billing_btw_number,
  };
}

export async function fetchAcademyInvoiceSelectablePlayers(
  academyProfileId: string,
): Promise<InvoiceSelectablePlayer[]> {
  const { players } = await fetchUnifiedPlayersCore({ kind: 'academy', academyProfileId });
  return players.map(coreToInvoiceSelectablePlayer);
}

export async function fetchTrainerInvoiceSelectablePlayers(
  trainerId: string,
): Promise<InvoiceSelectablePlayer[]> {
  const { players } = await fetchUnifiedPlayersCore({ kind: 'trainer', trainerId });
  return players.map(coreToInvoiceSelectablePlayer);
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
