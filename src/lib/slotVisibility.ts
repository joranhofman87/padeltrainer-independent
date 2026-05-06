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
  const slotPendingPriority = new Map<string, boolean>();
  const slotHasReleased = new Map<string, boolean>();
  (claimsData || []).forEach((c: { slot_id: string; status: string }) => {
    if (c.status === 'pending' || c.status === 'claimed') slotPendingPriority.set(c.slot_id, true);
    if (c.status === 'declined' || c.status === 'released' || c.status === 'expired') slotHasReleased.set(c.slot_id, true);
  });

  // Cycle membership: only relevant when at least one slot has a member window
  const sourceCycleIds = Array.from(new Set(
    slots.map(s => s.source_cycle_id).filter((x): x is string => !!x)
  ));
  const memberCycles = new Set<string>();
  if (sourceCycleIds.length > 0) {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      // Single batch query: cycles where this user has a non-cancelled booking
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

  const { claimToken, claimSlotId } = readClaimParamsFromLocation();
  const now = new Date();
  const visible = new Set<string>();
  for (const s of slots) {
    const tier = getSlotVisibility({
      slotId: s.id,
      priorityWindowEndsAt: s.priority_window_ends_at,
      hasPendingPriority: !!slotPendingPriority.get(s.id),
      hasReleasedSeat: !!slotHasReleased.get(s.id),
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
