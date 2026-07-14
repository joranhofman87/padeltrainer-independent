/**
 * Shared TanStack Query hooks for proposal/intake-request pages.
 * Provides cached data so navigating away and back is instant.
 */
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import {
  getCycles,
  getCycle,
  getIntakeRequestsWithProposals,
  getAvailableSlotsForCycle,
  getPlayerLinks,
  type Cycle,
  type IntakeRequestWithProposal,
  type SlotWithOccupancy,
  type PlayerLink,
} from '@/lib/cycles';
import { listRegistrationCycles, getRegistration, registrationToCycle } from '@/lib/registrations';

// ── Multi-cycle pages (AcademyIntakeRequests / TrainerIntakeRequests) ──

export function useCyclesQuery(ownerType: 'academy' | 'trainer', ownerId: string | null) {
  return useQuery<Cycle[]>({
    queryKey: ['cycles', ownerType, ownerId],
    queryFn: () => getCycles(ownerType, ownerId!),
    enabled: !!ownerId,
    staleTime: 60_000,
  });
}

/**
 * Registration/event FORMS only (legacy typed reg/event cycles UNION the registrations overlays,
 * keyed on source_cycle_id = intake_requests.cycle_id). Overlay-aware, so a post-split registration
 * (born type='cyclus') is included while a plain training cyclus / rebook round is not — the correct
 * option set for the manual "Add registration" intake picker (audit Batch 1 V3).
 */
export function useRegistrationCyclesQuery(ownerType: 'academy' | 'trainer', ownerId: string | null) {
  return useQuery<Cycle[]>({
    queryKey: ['registration-cycles', ownerType, ownerId],
    queryFn: () => listRegistrationCycles(ownerType, ownerId!),
    enabled: !!ownerId,
    staleTime: 60_000,
  });
}

export function useIntakeRequestsQuery(ownerType: 'academy' | 'trainer', ownerId: string | null) {
  return useQuery<IntakeRequestWithProposal[]>({
    queryKey: ['intake-requests', ownerType, ownerId],
    queryFn: () => getIntakeRequestsWithProposals(ownerType, ownerId!),
    enabled: !!ownerId,
    staleTime: 30_000,
  });
}

export function usePlayerLinksQuery(cycleIds: string[]) {
  return useQuery<PlayerLink[]>({
    queryKey: ['player-links', ...cycleIds],
    queryFn: async () => {
      const allLinks: PlayerLink[] = [];
      for (const id of cycleIds) {
        const links = await getPlayerLinks(id);
        allLinks.push(...links);
      }
      return allLinks;
    },
    enabled: cycleIds.length > 0,
    staleTime: 60_000,
  });
}

// ── Single-cycle detail page (AcademyCycleDetail) ──

export function useCycleDetailQuery(cycleId: string | undefined) {
  return useQuery<Cycle | null>({
    queryKey: ['cycle-detail', cycleId],
    // A registration form is standalone (no cycle shell) — fall back to presenting it as a Cycle so
    // the detail page renders the form (name, dates, price) instead of "not found".
    queryFn: async () => {
      if (!cycleId) return null;
      const cycle = await getCycle(cycleId);
      if (cycle) return cycle;
      const reg = await getRegistration(cycleId);
      return reg ? registrationToCycle(reg) : null;
    },
    enabled: !!cycleId,
    staleTime: 60_000,
  });
}

export function useCycleRequestsQuery(
  ownerType: 'academy' | 'trainer',
  ownerId: string | null,
  cycleId: string | undefined,
) {
  return useQuery<IntakeRequestWithProposal[]>({
    queryKey: ['cycle-requests', ownerType, ownerId, cycleId],
    queryFn: async () => {
      if (!ownerId || !cycleId) return [];
      const all = await getIntakeRequestsWithProposals(ownerType, ownerId);
      // cycleId here is the FORM id (registration.id); applicants link via registration_id.
      return all.filter(r => r.registration_id === cycleId);
    },
    enabled: !!ownerId && !!cycleId,
    staleTime: 30_000,
  });
}

export function useCyclePlayerLinksQuery(cycleId: string | undefined) {
  return useQuery<PlayerLink[]>({
    queryKey: ['cycle-player-links', cycleId],
    queryFn: () => (cycleId ? getPlayerLinks(cycleId) : Promise.resolve([])),
    enabled: !!cycleId,
    staleTime: 60_000,
  });
}

export function useScheduleSlotsQuery(cycleId: string | undefined, enabled: boolean) {
  return useQuery<SlotWithOccupancy[]>({
    queryKey: ['proposal-slots', cycleId],
    queryFn: () => (cycleId ? getAvailableSlotsForCycle(cycleId) : Promise.resolve([])),
    enabled: !!cycleId && enabled,
    // Short staleTime so invalidateQueries actually refetches after mutations
    // (generate proposals, reset, reset skipped, reassign).
    // Optimistic edits are protected by setQueryData + pendingMutationsRef
    // in the consuming page, plus keepPreviousData to avoid grid flicker.
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });
}

/** Helper to invalidate all proposal-related queries for a given context */
export function useInvalidateProposalData() {
  const queryClient = useQueryClient();
  return {
    invalidateAll: (ownerType: string, ownerId: string, cycleId?: string) => {
      queryClient.invalidateQueries({ queryKey: ['cycles', ownerType, ownerId] });
      queryClient.invalidateQueries({ queryKey: ['intake-requests', ownerType, ownerId] });
      if (cycleId) {
        queryClient.invalidateQueries({ queryKey: ['cycle-detail', cycleId] });
        queryClient.invalidateQueries({ queryKey: ['cycle-requests', ownerType, ownerId, cycleId] });
        queryClient.invalidateQueries({ queryKey: ['cycle-player-links', cycleId] });
        queryClient.invalidateQueries({ queryKey: ['proposal-slots', cycleId] });
        queryClient.invalidateQueries({ queryKey: ['player-links'] });
      }
    },
    invalidateSlots: (cycleId: string) => {
      queryClient.invalidateQueries({ queryKey: ['proposal-slots', cycleId] });
    },
    invalidateRequests: (ownerType: string, ownerId: string, cycleId?: string) => {
      queryClient.invalidateQueries({ queryKey: ['intake-requests', ownerType, ownerId] });
      if (cycleId) {
        queryClient.invalidateQueries({ queryKey: ['cycle-requests', ownerType, ownerId, cycleId] });
        queryClient.invalidateQueries({ queryKey: ['cycle-player-links', cycleId] });
        queryClient.invalidateQueries({ queryKey: ['player-links'] });
      }
    },
  };
}
