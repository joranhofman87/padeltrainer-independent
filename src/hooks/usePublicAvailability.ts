import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { filterVisibleSlotIds } from '@/lib/slotVisibility';
import type { PublicReleaseStatus } from '@/lib/priorityClaims';
import { logger } from '@/lib/logger';
import {
  mapAndGroupPublicSlots,
  type PublicDayGroup,
  type RawPublicSlotRow,
} from '@/lib/publicAvailability';

/**
 * Which owner's public availability to load. Owner-agnostic so one hook powers the academy, trainer
 * and (later) club public pages + the visual booking widget.
 */
export type AvailabilityOwner =
  | { type: 'academy'; academyId: string }
  | { type: 'trainer'; trainerId: string }
  | { type: 'location'; locationId: string };

/** The columns the availability transform + tier-visibility filter need. */
type RawSlotSelect = RawPublicSlotRow & {
  is_public: boolean;
  priority_window_ends_at: string | null;
  member_window_ends_at: string | null;
  public_release_status: PublicReleaseStatus | null;
  source_cycle_id: string | null;
};

const SLOT_SELECT = `
  id, start_time, end_time, cyclus_id, cyclus_name, court_type, is_public,
  price_per_session, total_price, max_participants, allow_single_booking, extra_costs,
  split_payment, location_id, trainer_id, academy_profile_id, priority_window_ends_at,
  member_window_ends_at, public_release_status, source_cycle_id, locations:location_id(name)
`;

/** Build the availability_slots `.or()` filter for an owner (academy = its own + its trainers'). */
async function resolveOwnerFilter(owner: AvailabilityOwner): Promise<string> {
  if (owner.type === 'trainer') return `trainer_id.eq.${owner.trainerId}`;
  // location (public club / venue page): everything bookable AT this venue, whichever trainer.
  // availability_slots.location_id is set on public slots + anon-readable, so no trainer join needed.
  if (owner.type === 'location') return `location_id.eq.${owner.locationId}`;
  // academy: the base academy_trainers table is not anon-readable — use the public view.
  const { data: trainerRows } = await supabase
    .from('academy_trainers_public')
    .select('trainer_profile_id')
    .eq('academy_profile_id', owner.academyId);
  const trainerIds = (trainerRows || []).map((t) => t.trainer_profile_id);
  return trainerIds.length > 0
    ? `academy_profile_id.eq.${owner.academyId},trainer_id.in.(${trainerIds.join(',')})`
    : `academy_profile_id.eq.${owner.academyId}`;
}

/**
 * Load an owner's public, bookable availability as day-grouped {@link PublicSlot}s. Anon-safe:
 * reads only public slots via the *_safe / *_public views, enforces tier-visibility with
 * filterVisibleSlotIds, and drops full slots. The pure shaping lives in mapAndGroupPublicSlots.
 * (Behavior lifted verbatim from AcademyPublicOpenSlots; now reusable across surfaces.)
 */
export function usePublicAvailability(owner: AvailabilityOwner): {
  dayGroups: PublicDayGroup[];
  loading: boolean;
} {
  const [dayGroups, setDayGroups] = useState<PublicDayGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const ownerKey =
    owner.type === 'academy' ? `a:${owner.academyId}`
    : owner.type === 'trainer' ? `t:${owner.trainerId}`
    : `l:${owner.locationId}`;

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const orFilter = await resolveOwnerFilter(owner);
        const { data: slotsRaw } = await supabase
          .from('availability_slots')
          .select(SLOT_SELECT)
          .or(orFilter)
          .eq('is_public', true)
          .gte('start_time', new Date().toISOString())
          .order('start_time', { ascending: true })
          // A cyclus runs for months, so 50 was far too low — an academy with a couple
          // of weekly series fills 50 within the first fortnight and later months (e.g. a
          // 13 Jul–17 Aug cyclus) never load. 500 covers realistic public pages AND keeps
          // the downstream slot-id `.in()` queries (capacity + visibility) URL-safe: the
          // PostgREST `in.()` filter 200s at ~500 ids but 400s around 1000. Academies past
          // 500 future public slots need cursor pagination — tracked separately.
          .limit(500);
        const slots = (slotsRaw ?? []) as unknown as RawSlotSelect[];
        if (slots.length === 0) {
          if (!cancelled) setDayGroups([]);
          return;
        }

        // Trainer slug + user_id (trainer_profiles_safe is a view, not in generated types).
        const slotTrainerIds = [...new Set(slots.map((s) => s.trainer_id).filter(Boolean))] as string[];
        const trainerMap: Record<string, { slug: string | null; user_id: string | null }> = {};
        if (slotTrainerIds.length > 0) {
          const { data } = await supabase
            .from('trainer_profiles_safe' as never)
            .select('id, slug, user_id')
            .in('id', slotTrainerIds);
          const rows = (data ?? []) as { id: string; slug: string | null; user_id: string | null }[];
          rows.forEach((tp) => {
            trainerMap[tp.id] = { slug: tp.slug, user_id: tp.user_id };
          });
        }

        // Trainer names (profiles_public is a view too).
        const userIds = [...new Set(Object.values(trainerMap).map((t) => t.user_id).filter(Boolean))] as string[];
        const nameMap: Record<string, string> = {};
        if (userIds.length > 0) {
          const { data } = await supabase
            .from('profiles_public' as never)
            .select('user_id, full_name')
            .in('user_id', userIds);
          const rows = (data ?? []) as { user_id: string; full_name: string | null }[];
          rows.forEach((p) => {
            if (p.full_name) nameMap[p.user_id] = p.full_name;
          });
        }

        // Capacity: count occupying bookings per slot. Anonymous visitors have NO SELECT RLS
        // on bookings, so the legacy direct read returned 0 for them and every full slot showed
        // bookable — use the anon-safe SECURITY DEFINER occupancy RPC (counts only, no PII).
        const slotIds = slots.map((s) => s.id);
        const bookingCounts: Record<string, number> = {};
        const { data: occ, error: occErr } = await supabase.rpc(
          'get_public_slot_occupancy' as never,
          { _slot_ids: slotIds } as never,
        );
        if (!occErr && occ) {
          (occ as unknown as { slot_id: string; occupied: number }[]).forEach((r) => {
            bookingCounts[r.slot_id] = r.occupied;
          });
        } else {
          // Deploy-window fallback (RPC not live yet): the legacy direct read — correct for
          // authed users, no worse than today for anon.
          const { data: bookingsData } = await supabase
            .from('bookings')
            .select('slot_id')
            .in('slot_id', slotIds)
            .in('status', ['pending', 'confirmed']);
          (bookingsData || []).forEach((b) => {
            bookingCounts[b.slot_id] = (bookingCounts[b.slot_id] || 0) + 1;
          });
        }

        // Payment readiness: drop PRICED slots whose payment owner has no working Mollie account,
        // so a guest never fills the whole form only to dead-end (create-*-payment refuses /
        // Mollie 422). Anon-safe RPC (booleans only, no account data). Deploy-window fallback:
        // RPC not live → don't filter (show all, no worse than today).
        let paymentReadyIds: Set<string> | null = null;
        const { data: pr, error: prErr } = await supabase.rpc(
          'get_public_slot_payment_ready' as never,
          { _slot_ids: slotIds } as never,
        );
        if (!prErr && pr) {
          paymentReadyIds = new Set(
            (pr as unknown as { slot_id: string; payment_ready: boolean }[])
              .filter((r) => r.payment_ready)
              .map((r) => r.slot_id),
          );
        }

        // Tier-aware visibility (priority/member windows, public_release_status) — anon-safe.
        const visibleIds = await filterVisibleSlotIds(
          slots.map((s) => ({
            id: s.id,
            priority_window_ends_at: s.priority_window_ends_at,
            member_window_ends_at: s.member_window_ends_at,
            public_release_status: s.public_release_status,
            source_cycle_id: s.source_cycle_id,
          })),
        );

        // Bookable = tier-visible AND payment-ready (when the readiness RPC answered).
        const bookableIds = paymentReadyIds
          ? new Set([...visibleIds].filter((id) => paymentReadyIds!.has(id)))
          : visibleIds;

        const groups = mapAndGroupPublicSlots(slots as unknown as RawPublicSlotRow[], {
          bookingCounts,
          visibleIds: bookableIds,
          trainerMap,
          nameMap,
        });
        if (!cancelled) setDayGroups(groups);
      } catch (error) {
        logger.error(
          'Error fetching public availability',
          error instanceof Error ? error : new Error(String(error)),
          { component: 'usePublicAvailability', owner: ownerKey },
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // Re-run only when the owner changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerKey]);

  return { dayGroups, loading };
}
