import { supabase } from '@/lib/supabaseClient';
import {
  fetchRemovedPlayerKeys,
  filterGuestRowsByRemoval,
  filterProfileIdsByRemoval,
} from '@/lib/playerRemovalVisibility';

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

const PLAYER_SELECT =
  'id, full_name, email, phone, billing_business_name, billing_address, billing_btw_number';

export async function fetchAcademyInvoiceSelectablePlayers(
  academyProfileId: string,
): Promise<InvoiceSelectablePlayer[]> {
  const { data: academyTrainers } = await supabase
    .from('academy_trainers')
    .select('trainer_profile_id')
    .eq('academy_profile_id', academyProfileId)
    .eq('status', 'active');

  const trainerIds = (academyTrainers || []).map((t) => t.trainer_profile_id).filter(Boolean);

  let guestQuery = supabase.from('guest_players').select(PLAYER_SELECT).order('full_name');
  if (trainerIds.length > 0) {
    guestQuery = guestQuery.or(
      `academy_profile_id.eq.${academyProfileId},trainer_id.in.(${trainerIds.join(',')})`,
    );
  } else {
    guestQuery = guestQuery.eq('academy_profile_id', academyProfileId);
  }

  const { data: guests } = await guestQuery;
  const removedKeys = await fetchRemovedPlayerKeys({
    kind: 'academy',
    academyProfileId,
  });
  const activeGuests = filterGuestRowsByRemoval(guests || [], removedKeys);

  const profileIdSet = new Set<string>();
  if (trainerIds.length > 0) {
    const { data: slots } = await supabase
      .from('availability_slots')
      .select('id')
      .eq('academy_profile_id', academyProfileId);
    const slotIds = (slots || []).map((s) => s.id);
    if (slotIds.length > 0) {
      const { data: bookings } = await supabase
        .from('bookings')
        .select('player_id')
        .in('slot_id', slotIds)
        .not('player_id', 'is', null);
      (bookings || []).forEach((b) => {
        if (b.player_id) profileIdSet.add(b.player_id);
      });
    }
  }

  let profiles: InvoiceSelectablePlayer[] = [];
  if (profileIdSet.size > 0) {
    const ids = filterProfileIdsByRemoval(Array.from(profileIdSet), removedKeys);
    if (ids.length > 0) {
      const { data: profileRows } = await supabase
        .from('profiles')
        .select(PLAYER_SELECT)
        .in('id', ids);
      profiles = (profileRows || []).map((p) => ({
        comboboxId: `p_${p.id}`,
        full_name: p.full_name || 'Unknown',
        email: p.email || '',
        phone: p.phone || '',
        type: 'registered' as const,
        profileId: p.id,
        guestPlayerId: null,
        billing_business_name: p.billing_business_name,
        billing_address: p.billing_address,
        billing_btw_number: p.billing_btw_number,
      }));
    }
  }

  const guestPlayers: InvoiceSelectablePlayer[] = activeGuests.map((g) => ({
    comboboxId: `g_${g.id}`,
    full_name: g.full_name,
    email: g.email || '',
    phone: g.phone || '',
    type: 'guest' as const,
    profileId: null,
    guestPlayerId: g.id,
    billing_business_name: g.billing_business_name,
    billing_address: g.billing_address,
    billing_btw_number: g.billing_btw_number,
  }));

  return [...guestPlayers, ...profiles].sort((a, b) => a.full_name.localeCompare(b.full_name));
}

export async function fetchTrainerInvoiceSelectablePlayers(
  trainerId: string,
): Promise<InvoiceSelectablePlayer[]> {
  const { data: guests } = await supabase
    .from('guest_players')
    .select(PLAYER_SELECT)
    .eq('trainer_id', trainerId)
    .order('full_name');

  const removedKeys = await fetchRemovedPlayerKeys({
    kind: 'trainer',
    trainerProfileId: trainerId,
  });
  const activeGuests = filterGuestRowsByRemoval(guests || [], removedKeys);

  const { data: slots } = await supabase
    .from('availability_slots')
    .select('id')
    .eq('trainer_id', trainerId);

  const slotIds = (slots || []).map((s) => s.id);
  const profileIdSet = new Set<string>();

  if (slotIds.length > 0) {
    const { data: bookings } = await supabase
      .from('bookings')
      .select('player_id')
      .in('slot_id', slotIds)
      .not('player_id', 'is', null);
    (bookings || []).forEach((b) => {
      if (b.player_id) profileIdSet.add(b.player_id);
    });
  }

  let profiles: InvoiceSelectablePlayer[] = [];
  if (profileIdSet.size > 0) {
    const ids = filterProfileIdsByRemoval(Array.from(profileIdSet), removedKeys);
    if (ids.length > 0) {
      const { data: profileRows } = await supabase
        .from('profiles')
        .select(PLAYER_SELECT)
        .in('id', ids);
      profiles = (profileRows || []).map((p) => ({
        comboboxId: `p_${p.id}`,
        full_name: p.full_name || 'Unknown',
        email: p.email || '',
        phone: p.phone || '',
        type: 'registered' as const,
        profileId: p.id,
        guestPlayerId: null,
        billing_business_name: p.billing_business_name,
        billing_address: p.billing_address,
        billing_btw_number: p.billing_btw_number,
      }));
    }
  }

  const guestPlayers: InvoiceSelectablePlayer[] = activeGuests.map((g) => ({
    comboboxId: `g_${g.id}`,
    full_name: g.full_name,
    email: g.email || '',
    phone: g.phone || '',
    type: 'guest' as const,
    profileId: null,
    guestPlayerId: g.id,
    billing_business_name: g.billing_business_name,
    billing_address: g.billing_address,
    billing_btw_number: g.billing_btw_number,
  }));

  return [...guestPlayers, ...profiles].sort((a, b) => a.full_name.localeCompare(b.full_name));
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
