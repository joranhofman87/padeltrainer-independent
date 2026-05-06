import { supabase } from '@/lib/supabaseClient';

export type ClaimStatus = 'pending' | 'claimed' | 'declined' | 'expired' | 'released';

export interface PriorityClaim {
  id: string;
  slot_id: string;
  player_id: string | null;
  guest_player_id: string | null;
  status: ClaimStatus;
  claim_token: string;
  invited_at: string | null;
  responded_at: string | null;
  decline_reason: string | null;
  source_slot_id: string | null;
  booking_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Fetch the bookings on the source cycle's slots so we know which players
 * are currently sitting in each slot. Returns map keyed by source slot id.
 */
export async function getBookingsBySlotIds(slotIds: string[]) {
  if (slotIds.length === 0) return new Map<string, Array<{ player_id: string | null; guest_player_id: string | null }>>();
  const { data, error } = await supabase
    .from('bookings')
    .select('slot_id, player_id, guest_player_id, status')
    .in('slot_id', slotIds)
    .neq('status', 'cancelled');
  if (error) throw error;
  const map = new Map<string, Array<{ player_id: string | null; guest_player_id: string | null }>>();
  for (const b of data || []) {
    if (!map.has(b.slot_id)) map.set(b.slot_id, []);
    map.get(b.slot_id)!.push({ player_id: b.player_id, guest_player_id: b.guest_player_id });
  }
  return map;
}

export interface BulkCopyInput {
  sourceCycleId: string;
  targetCycleId: string;
  weeksOffset: number; // how many weeks to shift each slot's start/end by
  priorityWindowDays: number;
  // If false, copies slots only without creating priority claims.
  createPriorityClaims: boolean;
  // Allow trainer to opt slots out
  excludeSourceSlotIds?: string[];
}

export interface BulkCopyResult {
  copiedSlots: number;
  createdClaims: number;
}

/**
 * Bulk copy slots from a source cycle to a target cycle, optionally
 * pre-populating slot_priority_claims based on the source slot bookings.
 * Idempotent on (target_cycle_id, source_slot_id).
 */
export async function bulkCopySlotsToCycle(input: BulkCopyInput): Promise<BulkCopyResult> {
  const { sourceCycleId, targetCycleId, weeksOffset, priorityWindowDays, createPriorityClaims, excludeSourceSlotIds = [] } = input;

  const { data: sourceSlots, error: srcErr } = await supabase
    .from('availability_slots')
    .select('*')
    .eq('cyclus_id', sourceCycleId);
  if (srcErr) throw srcErr;

  const { data: targetCycle, error: tcErr } = await supabase
    .from('cycles')
    .select('id, name')
    .eq('id', targetCycleId)
    .single();
  if (tcErr) throw tcErr;

  const { data: existingTargetSlots } = await supabase
    .from('availability_slots')
    .select('id, priority_source_slot_id')
    .eq('cyclus_id', targetCycleId)
    .not('priority_source_slot_id', 'is', null);
  const alreadyCopiedSourceIds = new Set((existingTargetSlots || []).map(s => s.priority_source_slot_id));

  const excludeSet = new Set(excludeSourceSlotIds);
  const slotsToCopy = (sourceSlots || []).filter(s => !alreadyCopiedSourceIds.has(s.id) && !excludeSet.has(s.id));

  const now = new Date();
  const windowEnd = new Date(now.getTime() + priorityWindowDays * 24 * 60 * 60 * 1000);
  const offsetMs = weeksOffset * 7 * 24 * 60 * 60 * 1000;

  let copiedSlots = 0;
  let createdClaims = 0;

  for (const src of slotsToCopy) {
    const newStart = new Date(new Date(src.start_time).getTime() + offsetMs).toISOString();
    const newEnd = new Date(new Date(src.end_time).getTime() + offsetMs).toISOString();

    const insert: Record<string, unknown> = {
      trainer_id: src.trainer_id,
      start_time: newStart,
      end_time: newEnd,
      is_recurring: false,
      cyclus_id: targetCycleId,
      cyclus_name: targetCycle.name,
      court_type: src.court_type,
      location_id: src.location_id,
      academy_profile_id: src.academy_profile_id,
      is_public: false,
      training_level: src.training_level,
      price_per_session: src.price_per_session,
      total_price: src.total_price,
      allow_single_booking: src.allow_single_booking,
      min_participants: src.min_participants,
      max_participants: src.max_participants,
      extra_costs: src.extra_costs,
      rating_system: src.rating_system,
      min_rating: src.min_rating,
      max_rating: src.max_rating,
      prices_include_vat: src.prices_include_vat,
      split_payment: src.split_payment,
      priority_source_slot_id: src.id,
      priority_window_starts_at: createPriorityClaims ? now.toISOString() : null,
      priority_window_ends_at: createPriorityClaims ? windowEnd.toISOString() : null,
    };

    const { data: newSlot, error: insErr } = await supabase
      .from('availability_slots')
      .insert(insert)
      .select('id')
      .single();
    if (insErr) throw insErr;
    copiedSlots++;

    if (createPriorityClaims) {
      const bookingsMap = await getBookingsBySlotIds([src.id]);
      const bookings = bookingsMap.get(src.id) || [];
      for (const b of bookings) {
        if (!b.player_id && !b.guest_player_id) continue;
        const { error: cErr } = await supabase.from('slot_priority_claims').insert({
          slot_id: newSlot.id,
          player_id: b.player_id,
          guest_player_id: b.guest_player_id,
          source_slot_id: src.id,
          status: 'pending',
        });
        if (!cErr) createdClaims++;
      }
    }
  }

  return { copiedSlots, createdClaims };
}

export async function getPriorityClaimsForSlot(slotId: string) {
  const { data, error } = await supabase
    .from('slot_priority_claims')
    .select('*, profiles:player_id(id, full_name, email), guest_players:guest_player_id(id, full_name, email)')
    .eq('slot_id', slotId)
    .order('created_at');
  if (error) throw error;
  return data || [];
}

export async function declineClaimAsManager(claimId: string, reason?: string) {
  const { error } = await supabase
    .from('slot_priority_claims')
    .update({ status: 'declined', responded_at: new Date().toISOString(), decline_reason: reason ?? 'Manager released' })
    .eq('id', claimId);
  if (error) throw error;
}

export async function extendPriorityWindow(slotId: string, extraDays: number) {
  const { data: slot } = await supabase
    .from('availability_slots')
    .select('priority_window_ends_at')
    .eq('id', slotId)
    .single();
  const base = slot?.priority_window_ends_at ? new Date(slot.priority_window_ends_at) : new Date();
  const newEnd = new Date(base.getTime() + extraDays * 24 * 60 * 60 * 1000);
  const { error } = await supabase
    .from('availability_slots')
    .update({ priority_window_ends_at: newEnd.toISOString() })
    .eq('id', slotId);
  if (error) throw error;
}

export async function endPriorityWindowNow(slotId: string) {
  const { error } = await supabase
    .from('availability_slots')
    .update({ priority_window_ends_at: new Date().toISOString(), is_public: true })
    .eq('id', slotId);
  if (error) throw error;
}

export async function fetchClaimByToken(token: string) {
  const { data, error } = await supabase.rpc('get_priority_claim_by_token', { _token: token });
  if (error) throw error;
  return data as Record<string, unknown> | null;
}

export async function declineClaimWithToken(token: string, reason?: string) {
  const { data, error } = await supabase.rpc('respond_to_priority_claim', {
    _token: token,
    _action: 'decline',
    _reason: reason ?? null,
  });
  if (error) throw error;
  return data;
}
