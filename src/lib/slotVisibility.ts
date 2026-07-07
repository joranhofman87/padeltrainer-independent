import { supabase } from '@/lib/supabaseClient';
import { getSlotVisibility, type PublicReleaseStatus, readClaimParamsFromLocation } from '@/lib/priorityClaims';

export interface RawSlotForVisibility {
  id: string;
  priority_window_ends_at: string | null;
  member_window_ends_at?: string | null;
  public_release_status?: PublicReleaseStatus | null;
  source_cycle_id?: string | null;
}

/**
 * True while a slot is inside a live priority window. Used to hide reserved
 * rebook slots from the PUBLIC listing conservatively — matching the server
 * booking guard (create-guest-*-payment / cart-payment all pass
 * `hasPendingClaim: true`). The client cannot rely on reading slot_priority_claims
 * to learn a slot is held: that table's SELECT RLS is `TO authenticated` only, so
 * an anonymous visitor (or a logged-in non-claim-holder) reads ZERO rows and would
 * otherwise see the held slot resolve to 'public'. Treating any live priority
 * window as "held" closes that leak; a matching claim-token in the URL still
 * bypasses the hide (see getSlotVisibility).
 */
export function isPriorityWindowActive(
  priorityWindowEndsAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!priorityWindowEndsAt) return false;
  return new Date(priorityWindowEndsAt).getTime() > now.getTime();
}

/**
 * Slot ids whose seat has genuinely freed up for the public: at least one claim
 * declined/released/expired AND no claim still pending/claimed. A rebooked slot is
 * SHARED by its whole group (one claim per co-occupant); one person declining does
 * NOT free the slot while the others are still inside their priority window. Marking
 * a slot "released" on ANY single decline (the old behaviour) leaked half-declined
 * group slots to everyone before the rest of the group had even responded.
 */
export function computeReleasedSlotIds(
  claims: Array<{ slot_id: string; status: string }>,
): Set<string> {
  const pending = new Set<string>();
  const freed = new Set<string>();
  for (const c of claims) {
    if (c.status === 'pending' || c.status === 'claimed') pending.add(c.slot_id);
    if (c.status === 'declined' || c.status === 'released' || c.status === 'expired') freed.add(c.slot_id);
  }
  const released = new Set<string>();
  for (const id of freed) if (!pending.has(id)) released.add(id);
  return released;
}

/**
 * Returns the set of slot ids the current viewer is allowed to see in a public listing.
 * Applies tier rules: priority -> members -> public, plus claim-token bypass.
 */
export async function filterVisibleSlotIds(slots: RawSlotForVisibility[]): Promise<Set<string>> {
  if (slots.length === 0) return new Set();
  const ids = slots.map(s => s.id);

  // Priority claims aggregate per slot
  const { data: claimsData } = await supabase
    .from('slot_priority_claims')
    .select('slot_id, status')
    .in('slot_id', ids);
  const claimRows = (claimsData || []) as Array<{ slot_id: string; status: string }>;
  const slotPendingPriority = new Map<string, boolean>();
  claimRows.forEach((c) => {
    if (c.status === 'pending' || c.status === 'claimed') slotPendingPriority.set(c.slot_id, true);
  });
  // Only treat a slot as released when its seat has genuinely freed up (see
  // computeReleasedSlotIds) — not on a single co-occupant's decline.
  const slotHasReleased = computeReleasedSlotIds(claimRows);

  // Cycle membership: only relevant when at least one slot has a member window
  const sourceCycleIds = Array.from(new Set(
    slots.map(s => s.source_cycle_id).filter((x): x is string => !!x)
  ));
  const memberCycles = new Set<string>();
  if (sourceCycleIds.length > 0) {
    const { data: { user } } = await supabase.auth.getUser();
    // Anon viewers are never members: leave memberCycles empty so member-windowed
    // slots stay hidden (identical to the pre-change behaviour).
    if (user) {
      try {
        // Second-bucket eligibility via the shared grant (rebooker OR original
        // cohort OR registered priority list) — one source of truth with the server
        // tier trigger, so what a viewer can SEE matches what they can BOOK.
        const results = await Promise.all(
          sourceCycleIds.map(async (cycleId) => {
            // auth.uid()-based wrapper — the raw can_book_member_window(_user_id, _cycle_id)
            // is now service_role-only (it took an arbitrary _user_id and leaked membership).
            const { data, error } = await supabase.rpc('can_current_user_book_member_window' as never, {
              _cycle_id: cycleId,
            } as never);
            if (error) throw error;
            return { cycleId, ok: data === true };
          }),
        );
        results.forEach(({ cycleId, ok }) => { if (ok) memberCycles.add(cycleId); });
      } catch {
        // Graceful fallback (e.g. frontend deployed before the migration): the
        // legacy own-bookings derivation grants member visibility to rebookers only.
        // Strictly narrower than the RPC, so it can never over-reveal.
        const { data: profile } = await supabase
          .from('profiles').select('id').eq('user_id', user.id).maybeSingle();
        if (profile?.id) {
          const { data: bookings } = await supabase
            .from('bookings')
            .select('slot_id, status')
            .eq('player_id', profile.id);
          const myActiveSlotIds = (bookings || [])
            .filter(b => !['cancelled', 'cancelled_swap'].includes(String(b.status || 'confirmed')))
            .map(b => b.slot_id);
          if (myActiveSlotIds.length > 0) {
            const { data: cycleSlots } = await supabase
              .from('availability_slots')
              .select('cyclus_id')
              .in('id', myActiveSlotIds)
              .in('cyclus_id', sourceCycleIds);
            (cycleSlots || []).forEach(cs => { if (cs.cyclus_id) memberCycles.add(cs.cyclus_id); });
          }
        }
      }
    }
  }

  const { claimToken, claimSlotId } = readClaimParamsFromLocation();
  const now = new Date();
  const visible = new Set<string>();
  for (const s of slots) {
    const tier = getSlotVisibility({
      slotId: s.id,
      priorityWindowEndsAt: s.priority_window_ends_at,
      // Conservative: a live priority window means "held" even when the
      // RLS-blind claims read returned nothing (anon / non-claim-holder), so a
      // reserved rebook slot is never leaked to the public. A matching claim
      // token still bypasses this inside getSlotVisibility.
      hasPendingPriority: !!slotPendingPriority.get(s.id) || isPriorityWindowActive(s.priority_window_ends_at, now),
      hasReleasedSeat: slotHasReleased.has(s.id),
      memberWindowEndsAt: s.member_window_ends_at ?? null,
      publicReleaseStatus: s.public_release_status ?? 'auto_release_scheduled',
      isCycleMember: s.source_cycle_id ? memberCycles.has(s.source_cycle_id) : false,
      claimToken,
      claimSlotId,
      now,
    });
    if (tier === 'public') visible.add(s.id);
  }
  return visible;
}
