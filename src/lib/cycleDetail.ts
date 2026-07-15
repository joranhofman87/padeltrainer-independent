import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';
import { getCycle, type Cycle } from '@/lib/cycles';
import { CAPACITY_OCCUPYING_STATUSES } from '@/lib/lessons';
import { personDisplayName, personKeyOf, personRefOf } from '@/lib/personIdentity';
import {
  computeCyclusGroupPaymentStatus,
  type CyclusGroupPaymentStatus,
  type BookingPaymentFields,
} from '@/lib/cyclusGroupPayment';

/** One session of a cycle + the players in it, for the cycle-detail view (Slice 9). */
/**
 * The price the cycle's slots ACTUALLY charge — the value the inline pricing card should seed from,
 * NOT cycles.price_per_session (which can drift: a bulk-copy attach copies source-slot prices onto a
 * target cycle whose row price is never touched; a rebook/misrouted edit can null it). Returns the
 * MOST COMMON non-null slot price (a stray drifted session can't win), null when no slot has a price
 * — so a stale cycle row can no longer be pushed back over the real slot prices on save (audit Batch 2 a).
 */
export function representativeSlotPrice(slots: { price_per_session: number | null }[]): number | null {
  const counts = new Map<number, number>();
  for (const s of slots) {
    if (s.price_per_session == null) continue;
    counts.set(s.price_per_session, (counts.get(s.price_per_session) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestN = 0;
  for (const [price, n] of counts) {
    if (n > bestN) { best = price; bestN = n; }
  }
  return best;
}

export interface CycleDetailSlot {
  id: string;
  start_time: string;
  end_time: string;
  trainer_id: string | null;
  max_participants: number | null;
  is_public: boolean;
  cyclus_name: string | null;
  /** The slot's own price — the booking-truth value (the cycle row's price_per_session can drift). */
  price_per_session: number | null;
  /** Display names of the players occupying this slot. */
  playerNames: string[];
  /** Count of capacity-occupying bookings on this slot. */
  bookedCount: number;
  paymentStatus: CyclusGroupPaymentStatus;
}

/** A distinct player across the whole cycle + how many of its sessions they're in. */
export interface CycleRosterEntry {
  name: string;
  sessionCount: number;
  /** Stable identity for whole-cycle roster actions (XOR — exactly one is set). */
  playerId: string | null;
  guestPlayerId: string | null;
}

export interface CycleDetail {
  cycle: Cycle | null;
  /** The cycle's slots, ordered by start_time. */
  slots: CycleDetailSlot[];
  /** Deduped players across the cycle (most sessions first, then name). */
  roster: CycleRosterEntry[];
  totalSlots: number;
  totalPlayers: number;
}

/**
 * Per-cycle detail for the cycle-detail centerpiece view (Slice 9): one cycle's slots, the players in
 * each, and a deduped roster across the cycle.
 *
 * Scoped to a SINGLE cycle (≈ 11 slots × 4 players → naturally bounded), so it does client-side joins
 * — NOT the 10k-scale `get_cyclus_groups_paginated` overview path. Reuses the academy cyclus
 * overview's name-resolve + `computeCyclusGroupPaymentStatus`. SECURITY/RLS: every read is under the
 * caller's RLS, so they only ever see their own slots/bookings.
 */
export async function getCycleDetail(cycleId: string): Promise<CycleDetail> {
  const cycle = await getCycle(cycleId).catch(() => null);

  const { data: slotRows, error: slotErr } = await supabase
    .from('availability_slots')
    .select('id, start_time, end_time, trainer_id, max_participants, is_public, cyclus_name, price_per_session')
    .eq('cyclus_id', cycleId)
    .order('start_time');
  if (slotErr) throw slotErr;
  const slots = (slotRows ?? []) as Array<{
    id: string;
    start_time: string;
    end_time: string;
    trainer_id: string | null;
    max_participants: number | null;
    is_public: boolean;
    cyclus_name: string | null;
    price_per_session: number | null;
  }>;
  const slotIds = slots.map((s) => s.id);

  const playerNamesMap: Record<string, string[]> = {};
  const bookingCountMap: Record<string, number> = {};
  const bookingsBySlot: Record<string, BookingPaymentFields[]> = {};
  // Roster keyed by the player's stable id (profile or guest) so two players with the same name stay
  // distinct; the name is just for display.
  const rosterByKey = new Map<string, { name: string; sessionCount: number; playerId: string | null; guestPlayerId: string | null }>();

  if (slotIds.length > 0) {
    const { data: bookings, error: bErr } = await supabase
      .from('bookings')
      .select('slot_id, player_id, guest_player_id, status, payment_status, paid_externally')
      .in('slot_id', slotIds)
      .in('status', CAPACITY_OCCUPYING_STATUSES as unknown as string[]);
    if (bErr) throw bErr;
    const rows = (bookings ?? []) as Array<{
      slot_id: string;
      player_id: string | null;
      guest_player_id: string | null;
      status: string;
      payment_status: string | null;
      paid_externally: boolean | null;
    }>;

    // Resolve participant names through a SECURITY DEFINER RPC, NOT a client-side profiles read.
    // An academy manager cannot SELECT a player's `profiles` row under RLS (only their trainers'),
    // so a registered player who booked as a logged-in account (player_id booking, no guest row)
    // would resolve to a null name and get silently dropped from the roster — invisible and
    // unmanageable, while the cycle LIST (also a definer RPC) shows them. The RPC is the single
    // authoritative name source for BOTH profile and guest people, authorized to whoever can
    // already see this cycle's bookings.
    const nameLookup: Record<string, string> = {};
    const { data: rosterNames } = await supabase.rpc('get_cycle_roster_names', { _cycle_id: cycleId });
    (rosterNames ?? []).forEach((n: { id: string; full_name: string | null }) => {
      if (n.full_name) nameLookup[n.id] = n.full_name;
    });

    for (const b of rows) {
      bookingCountMap[b.slot_id] = (bookingCountMap[b.slot_id] ?? 0) + 1;
      (bookingsBySlot[b.slot_id] ??= []).push({
        status: b.status,
        payment_status: b.payment_status ?? null,
        paid_externally: b.paid_externally ?? null,
      });
      // FAM-02 Level 1 (personIdentity.ts): a dual-keyed booking belongs to the GUEST person and
      // shows the guest's OWN name — a linked child's seat must not be attributed to (or named
      // after) the parent's profile, and it stays a separate roster entry from the parent's own.
      const key = personKeyOf(b);
      const name = personDisplayName(b, {
        profileName: b.player_id ? nameLookup[b.player_id] : null,
        guestName: b.guest_player_id ? nameLookup[b.guest_player_id] : null,
      });
      const ref = personRefOf(b);
      if (name && key && ref) {
        (playerNamesMap[b.slot_id] ??= []).push(name);
        const existing = rosterByKey.get(key);
        if (existing) existing.sessionCount += 1;
        else rosterByKey.set(key, { name, sessionCount: 1, playerId: ref.playerId, guestPlayerId: ref.guestPlayerId });
      }
    }
  }

  const detailSlots: CycleDetailSlot[] = slots.map((s) => ({
    id: s.id,
    start_time: s.start_time,
    end_time: s.end_time,
    trainer_id: s.trainer_id ?? null,
    max_participants: s.max_participants ?? null,
    is_public: s.is_public,
    cyclus_name: s.cyclus_name ?? null,
    price_per_session: s.price_per_session ?? null,
    playerNames: playerNamesMap[s.id] ?? [],
    bookedCount: bookingCountMap[s.id] ?? 0,
    paymentStatus: computeCyclusGroupPaymentStatus(bookingsBySlot[s.id] ?? []),
  }));

  const roster: CycleRosterEntry[] = [...rosterByKey.values()].sort(
    (a, b) => b.sessionCount - a.sessionCount || a.name.localeCompare(b.name),
  );

  return {
    cycle,
    slots: detailSlots,
    roster,
    totalSlots: detailSlots.length,
    totalPlayers: roster.length,
  };
}

/** TanStack hook wrapping {@link getCycleDetail}, keyed per cycle. */
export function useCycleDetail(cycleId: string | undefined) {
  return useQuery({
    queryKey: ['cycle-detail', cycleId],
    queryFn: () => getCycleDetail(cycleId as string),
    enabled: !!cycleId,
    staleTime: 60_000,
  });
}
