import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';
import { getCycle, type Cycle } from '@/lib/cycles';
import { CAPACITY_OCCUPYING_STATUSES } from '@/lib/lessons';
import {
  computeCyclusGroupPaymentStatus,
  type CyclusGroupPaymentStatus,
  type BookingPaymentFields,
} from '@/lib/cyclusGroupPayment';

/** One session of a cycle + the players in it, for the cycle-detail view (Slice 9). */
export interface CycleDetailSlot {
  id: string;
  start_time: string;
  end_time: string;
  trainer_id: string | null;
  max_participants: number | null;
  is_public: boolean;
  cyclus_name: string | null;
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
    .select('id, start_time, end_time, trainer_id, max_participants, is_public, cyclus_name')
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
  }>;
  const slotIds = slots.map((s) => s.id);

  const playerNamesMap: Record<string, string[]> = {};
  const bookingCountMap: Record<string, number> = {};
  const bookingsBySlot: Record<string, BookingPaymentFields[]> = {};
  // Roster keyed by the player's stable id (profile or guest) so two players with the same name stay
  // distinct; the name is just for display.
  const rosterByKey = new Map<string, { name: string; sessionCount: number }>();

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

    const playerIds = [...new Set(rows.map((b) => b.player_id).filter(Boolean))] as string[];
    const guestIds = [...new Set(rows.map((b) => b.guest_player_id).filter(Boolean))] as string[];
    const nameLookup: Record<string, string> = {};
    if (playerIds.length > 0) {
      const { data: profiles } = await supabase.from('profiles').select('id, full_name').in('id', playerIds);
      (profiles ?? []).forEach((p: { id: string; full_name: string | null }) => {
        if (p.full_name) nameLookup[p.id] = p.full_name;
      });
    }
    if (guestIds.length > 0) {
      const { data: guests } = await supabase.from('guest_players').select('id, full_name').in('id', guestIds);
      (guests ?? []).forEach((g: { id: string; full_name: string | null }) => {
        if (g.full_name) nameLookup[g.id] = g.full_name;
      });
    }

    for (const b of rows) {
      bookingCountMap[b.slot_id] = (bookingCountMap[b.slot_id] ?? 0) + 1;
      (bookingsBySlot[b.slot_id] ??= []).push({
        status: b.status,
        payment_status: b.payment_status ?? null,
        paid_externally: b.paid_externally ?? null,
      });
      const key = b.player_id ?? b.guest_player_id;
      const name = (b.player_id && nameLookup[b.player_id]) || (b.guest_player_id && nameLookup[b.guest_player_id]) || null;
      if (name && key) {
        (playerNamesMap[b.slot_id] ??= []).push(name);
        const existing = rosterByKey.get(key);
        if (existing) existing.sessionCount += 1;
        else rosterByKey.set(key, { name, sessionCount: 1 });
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
