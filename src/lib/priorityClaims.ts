import { supabase } from '@/lib/supabaseClient';

export type ClaimStatus = 'pending' | 'claimed' | 'declined' | 'expired' | 'released';

/** Compute when the priority window ends, given a start time and number of days. */
export function computePriorityWindowEnd(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

/** Apply a week offset to an ISO datetime string. */
export function applyWeeksOffset(iso: string, weeks: number): string {
  return new Date(new Date(iso).getTime() + weeks * 7 * 24 * 60 * 60 * 1000).toISOString();
}

export interface PrioritySlotVisibilityArgs {
  slotId: string;
  windowEndsAt: string | null | undefined;
  hasPendingPriority: boolean;
  hasReleasedSeat: boolean;
  claimToken?: string | null;
  claimSlotId?: string | null;
  now?: Date;
}

/**
 * Returns true when a slot must be hidden from public listings because it
 * still belongs to a priority window with unresolved (pending/claimed) claims
 * and no released seats. A matching claim token+slot bypasses the hide.
 */
export function shouldHidePrioritySlot(args: PrioritySlotVisibilityArgs): boolean {
  const { slotId, windowEndsAt, hasPendingPriority, hasReleasedSeat, claimToken, claimSlotId, now } = args;
  if (claimToken && claimSlotId === slotId) return false;
  if (!windowEndsAt) return false;
  const ends = new Date(windowEndsAt).getTime();
  const nowMs = (now ?? new Date()).getTime();
  if (ends <= nowMs) return false;
  return hasPendingPriority && !hasReleasedSeat;
}

export type PublicReleaseStatus = 'pending_admin_review' | 'auto_release_scheduled' | 'released' | 'held';
export type SlotTier = 'priority' | 'members' | 'public' | 'hidden';

export interface SlotVisibilityArgs {
  slotId: string;
  priorityWindowEndsAt: string | null | undefined;
  hasPendingPriority: boolean;
  hasReleasedSeat: boolean;
  memberWindowEndsAt: string | null | undefined;
  publicReleaseStatus: PublicReleaseStatus | null | undefined;
  isCycleMember: boolean;
  claimToken?: string | null;
  claimSlotId?: string | null;
  now?: Date;
}

/**
 * Resolve the current visibility tier for a slot.
 * - 'priority': only the matching claim token sees it
 * - 'members': only viewers who were members of the source cycle
 * - 'public': anyone
 * - 'hidden': owner-only (admin review pending or held)
 */
export function getSlotVisibility(args: SlotVisibilityArgs): SlotTier {
  const { slotId, priorityWindowEndsAt, hasPendingPriority, hasReleasedSeat,
    memberWindowEndsAt, publicReleaseStatus, isCycleMember,
    claimToken, claimSlotId, now } = args;
  const nowMs = (now ?? new Date()).getTime();

  // Priority window?
  const priorityActive = !!priorityWindowEndsAt
    && new Date(priorityWindowEndsAt).getTime() > nowMs
    && hasPendingPriority
    && !hasReleasedSeat;
  if (priorityActive) {
    if (claimToken && claimSlotId === slotId) return 'public';
    return 'priority';
  }

  // Member window?
  const memberActive = !!memberWindowEndsAt
    && new Date(memberWindowEndsAt).getTime() > nowMs;
  if (memberActive) {
    return isCycleMember ? 'public' : 'members';
  }

  // Public release status decides
  if (publicReleaseStatus === 'held' || publicReleaseStatus === 'pending_admin_review') {
    return 'hidden';
  }
  return 'public';
}

/** Convenience: should the public listing hide this slot from a viewer? */
export function shouldHideSlotForViewer(args: SlotVisibilityArgs): boolean {
  const tier = getSlotVisibility(args);
  return tier !== 'public';
}

/** Read claim token + slot from a URLSearchParams-like (browser only). */
export function readClaimParamsFromLocation(): { claimToken: string | null; claimSlotId: string | null } {
  if (typeof window === 'undefined') return { claimToken: null, claimSlotId: null };
  const p = new URLSearchParams(window.location.search);
  return { claimToken: p.get('claim'), claimSlotId: p.get('slot') };
}

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
  // Tier 2 (members) window length in days, after the priority window ends. 0 to disable.
  memberWindowDays?: number;
  // 'auto_release_scheduled' (default) opens to public after member window;
  // 'pending_admin_review' keeps slots hidden until trainer approves.
  publicReleaseStatus?: PublicReleaseStatus;
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
  const {
    sourceCycleId, targetCycleId, weeksOffset, priorityWindowDays,
    createPriorityClaims, excludeSourceSlotIds = [],
    memberWindowDays = 0, publicReleaseStatus = 'auto_release_scheduled',
  } = input;

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
  const windowEnd = computePriorityWindowEnd(now, priorityWindowDays);
  const memberWindowEnd = memberWindowDays > 0
    ? computePriorityWindowEnd(windowEnd, memberWindowDays)
    : null;

  let copiedSlots = 0;
  let createdClaims = 0;

  for (const src of slotsToCopy) {
    const newStart = applyWeeksOffset(src.start_time, weeksOffset);
    const newEnd = applyWeeksOffset(src.end_time, weeksOffset);

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
      // Visibility is gated by tier (priority/member/public) in the listing layer.
      // Slots are always queryable; the client filters via getSlotVisibility.
      is_public: true,
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
      source_cycle_id: sourceCycleId,
      member_window_starts_at: memberWindowEnd ? windowEnd.toISOString() : null,
      member_window_ends_at: memberWindowEnd ? memberWindowEnd.toISOString() : null,
      public_release_status: publicReleaseStatus,
    };

    const { data: newSlot, error: insErr } = await supabase
      .from('availability_slots')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .insert(insert as any)
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
    _reason: reason,
  });
  if (error) throw error;
  return data;
}

/**
 * Accept a priority claim = commit to the next cycle (no upfront payment).
 * Creates a confirmed, unpaid commitment booking server-side and marks the
 * claim 'claimed'. Returns the RPC result, e.g. { ok, status, booking_id } or
 * { ok: false, reason: 'slot_full' | 'window_expired' | 'already_responded' }.
 */
export async function acceptClaimWithToken(token: string) {
  const { data, error } = await supabase.rpc('respond_to_priority_claim', {
    _token: token,
    _action: 'accept',
  });
  if (error) throw error;
  return data as { ok: boolean; status?: string; reason?: string; booking_id?: string } | null;
}

// === Tier overrides ===

export async function openSlotToMembersNow(slotId: string, memberWindowDays = 7) {
  const memberEnd = new Date(Date.now() + memberWindowDays * 24 * 60 * 60 * 1000);
  const { error } = await supabase
    .from('availability_slots')
    .update({
      priority_window_ends_at: new Date().toISOString(),
      member_window_starts_at: new Date().toISOString(),
      member_window_ends_at: memberEnd.toISOString(),
    } as never)
    .eq('id', slotId);
  if (error) throw error;
}

export async function releaseSlotToPublic(slotId: string) {
  const { error } = await supabase
    .from('availability_slots')
    .update({
      priority_window_ends_at: new Date().toISOString(),
      member_window_ends_at: new Date().toISOString(),
      public_release_status: 'released',
      is_public: true,
    } as never)
    .eq('id', slotId);
  if (error) throw error;
}

export async function holdSlotForReview(slotId: string) {
  const { error } = await supabase
    .from('availability_slots')
    .update({ public_release_status: 'held' } as never)
    .eq('id', slotId);
  if (error) throw error;
}

export async function setSlotToPendingReview(slotId: string) {
  const { error } = await supabase
    .from('availability_slots')
    .update({ public_release_status: 'pending_admin_review' } as never)
    .eq('id', slotId);
  if (error) throw error;
}

// === Member swap ===

export async function swapMemberBooking(oldBookingId: string, newSlotId: string) {
  const { data, error } = await supabase.rpc('swap_member_booking' as never, {
    _old_booking_id: oldBookingId,
    _new_slot_id: newSlotId,
  } as never);
  if (error) throw error;
  return data as { ok: boolean; new_booking_id: string };
}

export async function isCycleMember(cycleId: string): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data, error } = await supabase.rpc('is_cycle_member' as never, {
    _user_id: user.id, _cycle_id: cycleId,
  } as never);
  if (error) return false;
  return Boolean(data);
}

