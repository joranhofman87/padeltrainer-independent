/**
 * Single source of truth for WHO counts as a player in an academy or trainer
 * context. Every surface that lists or picks players (players tables, invoice
 * picker, email campaign, booking dialogs) builds on this so membership rules
 * can never diverge between views.
 *
 * Membership rules (the "players table is leading" semantics):
 * - Guests: academy scope = academy-level guests (academy_profile_id) PLUS
 *   guests owned by the academy's active trainers; trainer scope = guests
 *   owned by that trainer. Removal metadata (academy_player_metadata.removed_at)
 *   filters both kinds.
 * - Registered: profiles with a confirmed/completed booking on a slot of an
 *   in-scope trainer. Profiles linked to a fetched guest (linked_profile_id)
 *   are deduped away — the person appears once, as the guest.
 *
 * The result also exposes the slots and status-filtered bookings the core
 * fetched, so pages can layer their own enrichment (locations, cycles,
 * trainer chips) without re-querying.
 */
import { supabase } from '@/lib/supabaseClient';
import { loadGuestPlayersForAcademy, loadGuestPlayersForTrainer, type GuestPlayerRow } from '@/lib/guestPlayers';
import { fetchRemovedPlayerKeys, filterProfileIdsByRemoval } from '@/lib/playerRemovalVisibility';
import { TRAINING_BOOKING_STATUSES } from '@/lib/academyPlayerTrainingLocations';

export type UnifiedPlayerScope =
  | { kind: 'academy'; academyProfileId: string; trainerIds?: string[] }
  | { kind: 'trainer'; trainerId: string };

export interface CorePlayer {
  /** Stable cross-surface key: g_<guestId> or p_<profileId>. */
  key: string;
  type: 'guest' | 'registered';
  guestPlayerId: string | null;
  profileId: string | null;
  full_name: string;
  email: string;
  phone: string;
  billing_business_name: string | null;
  billing_address: string | null;
  billing_btw_number: string | null;
  skill_rating: number | null;
  rating_system: string;
  notes: string | null;
  /** For registered players: created_at of their first in-scope booking. */
  created_at: string;
  has_trained: boolean;
  source: string | null;
  birth_date: string | null;
  /** Original guest row (edit dialogs need the full record). Null for registered. */
  guestRow: GuestPlayerRow | null;
}

export interface ScopeSlot {
  id: string;
  trainer_id: string | null;
  location_id: string | null;
  cyclus_id: string | null;
  end_time: string | null;
  academy_profile_id: string | null;
}

export interface ScopeBooking {
  player_id: string | null;
  slot_id: string;
  created_at: string;
}

export interface UnifiedPlayersCoreResult {
  players: CorePlayer[];
  /** Trainer ids in scope (academy: active academy trainers; trainer: [trainerId]). */
  trainerIds: string[];
  /** Slots of the in-scope trainers (for page-level enrichment). */
  slots: ScopeSlot[];
  /** Status-filtered registered-player bookings on those slots. */
  registeredBookings: ScopeBooking[];
}

const PROFILE_SELECT =
  'id, full_name, email, phone, skill_rating, rating_system, billing_business_name, billing_address, billing_btw_number';

async function fetchActiveAcademyTrainerIds(academyProfileId: string): Promise<string[]> {
  const { data } = await supabase
    .from('academy_trainers')
    .select('trainer_profile_id')
    .eq('academy_profile_id', academyProfileId)
    .eq('status', 'active');
  return (data || []).map((t) => t.trainer_profile_id).filter(Boolean);
}

function guestToCorePlayer(g: GuestPlayerRow): CorePlayer {
  return {
    key: `g_${g.id}`,
    type: 'guest',
    guestPlayerId: g.id,
    profileId: null,
    full_name: g.full_name,
    email: g.email || '',
    phone: g.phone || '',
    billing_business_name: (g as { billing_business_name?: string | null }).billing_business_name ?? null,
    billing_address: (g as { billing_address?: string | null }).billing_address ?? null,
    billing_btw_number: (g as { billing_btw_number?: string | null }).billing_btw_number ?? null,
    skill_rating: g.skill_rating ?? null,
    rating_system: g.rating_system || 'knltb',
    notes: g.notes || null,
    created_at: g.created_at,
    has_trained: (g as { has_trained?: boolean }).has_trained ?? false,
    source: (g as { source?: string | null }).source ?? null,
    birth_date: (g as { birth_date?: string | null }).birth_date ?? null,
    guestRow: g,
  };
}

export async function fetchUnifiedPlayersCore(
  scope: UnifiedPlayerScope,
): Promise<UnifiedPlayersCoreResult> {
  const trainerIds =
    scope.kind === 'academy'
      ? scope.trainerIds ?? (await fetchActiveAcademyTrainerIds(scope.academyProfileId))
      : [scope.trainerId];

  // --- Guests (removal-filtered by the scope's metadata) ---
  let guests: GuestPlayerRow[] = [];
  if (scope.kind === 'academy') {
    if (trainerIds.length > 0) {
      const { data: trainerGuests } = await supabase
        .from('guest_players')
        .select('*')
        .in('trainer_id', trainerIds)
        .order('full_name');
      if (trainerGuests) guests.push(...(trainerGuests as GuestPlayerRow[]));
    }
    const { data: academyGuests, error } = await loadGuestPlayersForAcademy(scope.academyProfileId);
    if (error) throw error;
    guests.push(...academyGuests);
    const seen = new Set<string>();
    guests = guests.filter((g) => {
      if (seen.has(g.id)) return false;
      seen.add(g.id);
      return true;
    });
    // Trainer-owned guests above are raw; apply academy removal metadata to all.
    const removedKeys = await fetchRemovedPlayerKeys({
      kind: 'academy',
      academyProfileId: scope.academyProfileId,
    });
    guests = guests.filter((g) => !removedKeys.guestIds.has(g.id));
  } else {
    const { data: trainerGuests, error } = await loadGuestPlayersForTrainer(scope.trainerId);
    if (error) throw error;
    guests = trainerGuests;
  }

  // --- Slots + registered bookings in scope ---
  let slots: ScopeSlot[] = [];
  if (trainerIds.length > 0) {
    const { data } = await supabase
      .from('availability_slots')
      .select('id, trainer_id, location_id, cyclus_id, end_time, academy_profile_id')
      .in('trainer_id', trainerIds);
    slots = (data || []) as ScopeSlot[];
  }

  let registeredBookings: ScopeBooking[] = [];
  if (slots.length > 0) {
    const { data } = await supabase
      .from('bookings')
      .select('player_id, created_at, slot_id')
      .in('slot_id', slots.map((s) => s.id))
      .not('player_id', 'is', null)
      .in('status', [...TRAINING_BOOKING_STATUSES]);
    registeredBookings = (data || []) as ScopeBooking[];
  }

  // --- Registered players (linked-profile deduped, removal-filtered) ---
  let registered: CorePlayer[] = [];
  const firstBookingByPlayer = new Map<string, string>();
  registeredBookings.forEach((b) => {
    if (!b.player_id) return;
    if (!firstBookingByPlayer.has(b.player_id)) {
      firstBookingByPlayer.set(b.player_id, b.created_at);
    }
  });

  if (firstBookingByPlayer.size > 0) {
    const linkedIds = new Set(
      guests.map((g) => g.linked_profile_id).filter((id): id is string => Boolean(id)),
    );
    const removedKeys = await fetchRemovedPlayerKeys(
      scope.kind === 'academy'
        ? { kind: 'academy', academyProfileId: scope.academyProfileId }
        : { kind: 'trainer', trainerProfileId: scope.trainerId },
    );
    const candidateIds = filterProfileIdsByRemoval(
      Array.from(firstBookingByPlayer.keys()).filter((id) => !linkedIds.has(id)),
      removedKeys,
    );

    if (candidateIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select(PROFILE_SELECT)
        .in('id', candidateIds);

      registered = (profiles || []).map((p) => ({
        key: `p_${p.id}`,
        type: 'registered' as const,
        guestPlayerId: null,
        profileId: p.id,
        full_name: p.full_name || 'Unknown',
        email: p.email || '',
        phone: p.phone || '',
        billing_business_name: p.billing_business_name ?? null,
        billing_address: p.billing_address ?? null,
        billing_btw_number: p.billing_btw_number ?? null,
        skill_rating: p.skill_rating ?? null,
        rating_system: p.rating_system || 'knltb',
        notes: null,
        created_at: firstBookingByPlayer.get(p.id) || new Date().toISOString(),
        has_trained: true,
        source: null,
        birth_date: null,
        guestRow: null,
      }));
    }
  }

  const players = [...guests.map(guestToCorePlayer), ...registered].sort((a, b) =>
    a.full_name.localeCompare(b.full_name),
  );

  return { players, trainerIds, slots, registeredBookings };
}
