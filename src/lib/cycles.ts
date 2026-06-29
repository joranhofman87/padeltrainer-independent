import { supabase } from '@/lib/supabaseClient';
import { format } from 'date-fns';
import { logger } from '@/lib/logger';
import { resolveOrCreateGuestPlayer } from '@/lib/playerResolve';
import type { GuestResolveScope } from '@/lib/playerResolve';
import { applySlotDeleteToCycle } from '@/lib/slotDeleteGuard';
import { isMissingRpc, reportDeployDriftFallback } from '@/lib/deployDrift';
import { toCycle, toIntakeRequest, toProposedAssignment } from './cycleMappers';
export type * from './cycleTypes';
export * from './cycleProposalSlots';

// Types
export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  time_match: 35,
  preferred_trainer: 20,
  level_compatible: 15,
  priority_bonus: 10,
  capacity_available: 10,
  sessions_per_week: 10,
};


// Cycle CRUD
export async function getCycles(ownerType: 'trainer' | 'club' | 'academy', ownerId: string): Promise<Cycle[]> {
  const { data, error } = await supabase
    .from('cycles')
    .select('*, location:locations(id, name, city)')
    .eq('owner_type', ownerType)
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data || []).map(toCycle);
}

// Get cycles with intake request counts
export async function getCyclesWithCounts(
  ownerType: 'trainer' | 'club' | 'academy',
  ownerId: string,
  types?: Array<Cycle['type']>,
): Promise<Cycle[]> {
  let query = supabase
    .from('cycles')
    .select('*, location:locations(id, name, city)')
    .eq('owner_type', ownerType)
    .eq('owner_id', ownerId);
  if (types && types.length > 0) {
    query = query.in('type', types);
  }
  const { data, error } = await query.order('created_at', { ascending: false });

  if (error) throw error;
  
  const cycles = (data || []).map(toCycle);

  // Per-cycle intake counts via the indexed count_cycles_intakes RPC (ONE GROUP BY) instead of an
  // unbounded client scan of intake_requests — see countCyclesIntakesWithFallback (D-20d).
  if (cycles.length > 0) {
    const countMap = await countCyclesIntakesWithFallback(cycles.map(c => c.id));
    cycles.forEach(cycle => {
      cycle._intakeCount = countMap.get(cycle.id) || 0;
    });
  }

  return cycles;
}

/**
 * Per-cycle intake counts in ONE GROUP BY via the `count_cycles_intakes` RPC (Phase 4 F2a),
 * replacing the unbounded `intake_requests` client scan in getCyclesWithCounts / listRegistrationCycles
 * at 10k+ scale. Returns a Map keyed by cycle id; cycles with zero intakes are absent (treat as 0).
 * RLS-scoped (the RPC is SECURITY INVOKER). A consuming slice wires this in behind a graceful
 * fallback so it is safe before the owner deploys the migration.
 */
export async function countCyclesIntakes(cycleIds: string[]): Promise<Map<string, number>> {
  if (cycleIds.length === 0) return new Map();
  const { data, error } = await supabase.rpc('count_cycles_intakes' as never, {
    _cycle_ids: cycleIds,
  } as never);
  if (error) throw error;
  const rows = (data ?? []) as unknown as Array<{ cycle_id: string; n: number | string }>;
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.cycle_id, Number(row.n));
  return counts;
}

/**
 * {@link countCyclesIntakes} via the indexed RPC, with a graceful fallback to the original
 * (unbounded) client scan when the RPC isn't deployed yet (local/CI before the migration), so
 * consumers like {@link getCyclesWithCounts} are safe either way. The supabase-js codes 'PGRST202'
 * (not in schema cache) / Postgres '42883' (no such function) signal the missing RPC.
 */
export async function countCyclesIntakesWithFallback(cycleIds: string[]): Promise<Map<string, number>> {
  if (cycleIds.length === 0) return new Map();
  try {
    return await countCyclesIntakes(cycleIds);
  } catch (e) {
    if (!isMissingRpc(e)) throw e;
    reportDeployDriftFallback('count_cycles_intakes', { cycleCount: cycleIds.length });
    const { data } = await supabase.from('intake_requests').select('cycle_id').in('cycle_id', cycleIds);
    const counts = new Map<string, number>();
    (data ?? []).forEach((row: { cycle_id: string }) =>
      counts.set(row.cycle_id, (counts.get(row.cycle_id) || 0) + 1));
    return counts;
  }
}

/** A partial slot edit. Only the fields you set are written; an explicit `null` clears the column.
 *  `startShiftMinutes` + `durationMinutes` go together (relative time shift; omit one and neither
 *  applies). Price fields are intentionally absent — edit those via {@link updateCyclePricing}. */
export interface SlotEditPatch {
  startShiftMinutes?: number;
  durationMinutes?: number;
  trainerId?: string | null;
  locationId?: string | null;
  maxParticipants?: number | null;
  ratingSystem?: string | null;
  minRating?: number | null;
  maxRating?: number | null;
  cyclusName?: string | null;
  isPublic?: boolean;
}

export interface SlotEditResult {
  /** Slots actually updated. */
  updatedCount: number;
  /** Slots that blocked the edit because their occupancy exceeds the requested max_participants. */
  blockedCount: number;
  /** The blocking slot ids — surface them ("can't shrink: N players booked"); the edit was a no-op. */
  blockedSlotIds: string[];
}

/**
 * Atomic, set-based slot edit / apply-to-cycle via the `apply_slot_edit_to_cycle` RPC (Phase 4 F2).
 *
 * Replaces the non-atomic per-slot "apply to whole cyclus" client loop. Applies a relative time
 * shift + non-price fields to every `slotIds` row in ONE statement, with an ALL-OR-NOTHING
 * capacity-shrink guard: if a requested `maxParticipants` would shrink any slot below its occupancy,
 * NOTHING is updated and the offending slots come back in `blockedSlotIds`.
 *
 * Adoption notes (Slice 7b):
 *  • Omitted keys are KEPT per-slot — there is no normalization. To reproduce the client's
 *    whole-cyclus overwrite, populate EVERY non-price field, not a changed-only diff.
 *  • `startShiftMinutes` + `durationMinutes` travel together (both or neither; throws otherwise). A
 *    pure resize passes `startShiftMinutes: 0`.
 *  • Relative-shift + cycle-scope + NON-PRICE only. Single-slot absolute-time edits and any price
 *    write stay on the existing path / {@link updateCyclePricing} (slot = price source of truth).
 *
 * INERT until Slice 7b adopts it; wrap callers in a graceful fallback before the owner deploys the
 * migration. `cycleId` may be null (orphan-cyclus slots).
 */
export async function applySlotEditToCycle(
  cycleId: string | null,
  slotIds: string[],
  patch: SlotEditPatch,
): Promise<SlotEditResult> {
  if ((patch.startShiftMinutes === undefined) !== (patch.durationMinutes === undefined)) {
    throw new Error('applySlotEditToCycle: startShiftMinutes and durationMinutes must be provided together');
  }
  const p: Record<string, unknown> = {};
  // Round the integer-typed fields so a fractional value can't abort the server-side ::int cast.
  if (patch.startShiftMinutes !== undefined) p.start_shift_minutes = Math.round(patch.startShiftMinutes);
  if (patch.durationMinutes !== undefined) p.duration_minutes = Math.round(patch.durationMinutes);
  if (patch.maxParticipants !== undefined) {
    p.max_participants = patch.maxParticipants === null ? null : Math.round(patch.maxParticipants);
  }
  if (patch.trainerId !== undefined) p.trainer_id = patch.trainerId;
  if (patch.locationId !== undefined) p.location_id = patch.locationId;
  if (patch.ratingSystem !== undefined) p.rating_system = patch.ratingSystem;
  if (patch.minRating !== undefined) p.min_rating = patch.minRating;
  if (patch.maxRating !== undefined) p.max_rating = patch.maxRating;
  if (patch.cyclusName !== undefined) p.cyclus_name = patch.cyclusName;
  if (patch.isPublic !== undefined) p.is_public = patch.isPublic;

  if (slotIds.length === 0 || Object.keys(p).length === 0) {
    return { updatedCount: 0, blockedCount: 0, blockedSlotIds: [] };
  }

  const { data, error } = await supabase.rpc('apply_slot_edit_to_cycle' as never, {
    _cycle_id: cycleId,
    _slot_ids: slotIds,
    _patch: p,
  } as never);
  if (error) throw error;
  const row = (data as unknown as Array<{
    updated_count: number | string;
    blocked_count: number | string;
    blocked_slot_ids: string[] | null;
  }>)?.[0];
  return {
    updatedCount: Number(row?.updated_count ?? 0),
    blockedCount: Number(row?.blocked_count ?? 0),
    blockedSlotIds: row?.blocked_slot_ids ?? [],
  };
}

export async function getActiveCycles(ownerType: 'trainer' | 'club' | 'academy', ownerId: string): Promise<Cycle[]> {
  const { data, error } = await supabase
    .from('cycles')
    .select('*, location:locations(id, name, city)')
    .eq('owner_type', ownerType)
    .eq('owner_id', ownerId)
    .eq('status', 'open')
    .order('start_date', { ascending: true, nullsFirst: true });

  if (error) throw error;
  return (data || []).map(toCycle);
}

// Fetch all open cycles for a location (from trainers, academies, and clubs at that location)
export async function getLocationCycles(locationId: string): Promise<Cycle[]> {
  // Get trainers at this location
  const { data: trainerLocations } = await supabase
    .from('trainer_locations')
    .select('trainer_id')
    .eq('location_id', locationId);
  
  const trainerIds = trainerLocations?.map(t => t.trainer_id) || [];
  
  // Get academies at this location
  const { data: academyLocations } = await supabase
    .from('academy_locations')
    .select('academy_profile_id')
    .eq('location_id', locationId)
    .eq('is_active', true);
  
  const academyIds = academyLocations?.map(a => a.academy_profile_id) || [];

  // Get club at this location
  const { data: clubProfiles } = await supabase
    .from('club_profiles')
    .select('id')
    .eq('location_id', locationId);

  const clubIds = clubProfiles?.map(c => c.id) || [];
  
  // Fetch cycles from all owner types
  const allCycles: Cycle[] = [];
  
  if (trainerIds.length > 0) {
    const { data: trainerCycles } = await supabase
      .from('cycles')
      .select('*')
      .eq('owner_type', 'trainer')
      .in('owner_id', trainerIds)
      .eq('status', 'open')
      .eq('location_id', locationId);
    if (trainerCycles) allCycles.push(...trainerCycles.map(toCycle));
  }
  
  if (academyIds.length > 0) {
    const { data: academyCycles } = await supabase
      .from('cycles')
      .select('*')
      .eq('owner_type', 'academy')
      .in('owner_id', academyIds)
      .eq('status', 'open')
      .eq('location_id', locationId);
    if (academyCycles) allCycles.push(...academyCycles.map(toCycle));
  }

  if (clubIds.length > 0) {
    const { data: clubCycles } = await supabase
      .from('cycles')
      .select('*')
      .eq('owner_type', 'club')
      .in('owner_id', clubIds)
      .eq('status', 'open')
      .eq('location_id', locationId);
    if (clubCycles) allCycles.push(...clubCycles.map(toCycle));
  }
  
  return allCycles.sort((a, b) => {
    // Always-open first
    if (a.is_always_open && !b.is_always_open) return -1;
    if (!a.is_always_open && b.is_always_open) return 1;
    if (a.is_always_open && b.is_always_open) {
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    }
    return new Date(a.start_date || 0).getTime() - new Date(b.start_date || 0).getTime();
  });
}

export async function getCycle(cycleId: string): Promise<Cycle | null> {
  const { data, error } = await supabase
    .from('cycles')
    .select('*')
    .eq('id', cycleId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw error;
  }
  return toCycle(data);
}

export async function updateCycleSettings(cycleId: string, settings: CycleSettings): Promise<void> {
  const { error } = await supabase
    .from('cycles')
    .update({ settings: settings as unknown as Json })
    .eq('id', cycleId);
  if (error) throw error;
}

export async function createCycle(input: CycleInput): Promise<Cycle> {
  const insertData = {
    owner_type: input.owner_type,
    owner_id: input.owner_id,
    name: input.name,
    description: input.description || null,
    start_date: input.is_always_open ? null : (input.start_date ?? null),
    end_date: input.is_always_open ? null : (input.end_date ?? null),
    enrollment_deadline: input.is_always_open ? null : (input.enrollment_deadline || null),
    is_always_open: input.is_always_open ?? false,
    settings: (input.settings || {}) as Json,
    status: input.status || 'draft',
    type: input.type || 'registration',
    location_id: input.location_id || null,
    price_per_session: input.price_per_session ?? null,
    total_price: input.total_price ?? null,
    currency: input.currency || 'EUR',
    terms: input.terms ?? null,
    price_table: (input.price_table ?? null) as unknown as Json,
  };
  
  const { data, error } = await supabase
    .from('cycles')
    .insert(insertData)
    .select()
    .single();

  if (error) throw error;
  return toCycle(data);
}

export async function updateCycle(cycleId: string, updates: Partial<CycleInput>): Promise<Cycle> {
  const updateData: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (updates.name !== undefined) updateData.name = updates.name;
  if (updates.description !== undefined) updateData.description = updates.description;
  if (updates.start_date !== undefined) updateData.start_date = updates.start_date;
  if (updates.end_date !== undefined) updateData.end_date = updates.end_date;
  if (updates.enrollment_deadline !== undefined) updateData.enrollment_deadline = updates.enrollment_deadline;
  if (updates.is_always_open !== undefined) updateData.is_always_open = updates.is_always_open;
  if (updates.settings !== undefined) updateData.settings = updates.settings as Json;
  if (updates.status !== undefined) updateData.status = updates.status;
  if (updates.location_id !== undefined) updateData.location_id = updates.location_id;
  if (updates.price_per_session !== undefined) updateData.price_per_session = updates.price_per_session;
  if (updates.total_price !== undefined) updateData.total_price = updates.total_price;
  if (updates.currency !== undefined) updateData.currency = updates.currency;
  if (updates.terms !== undefined) updateData.terms = updates.terms;
  if (updates.price_table !== undefined) updateData.price_table = updates.price_table as unknown as Json;
  
  const { data, error } = await supabase
    .from('cycles')
    .update(updateData)
    .eq('id', cycleId)
    .select()
    .single();

  if (error) throw error;
  return toCycle(data);
}

// Bookings in any of these statuses occupy a session → that session must NEVER be
// silently deleted (bookings.slot_id is ON DELETE CASCADE, so deleting the slot would
// drop the booking). Use the canonical capacity set, which includes pending_approval.
import { CAPACITY_OCCUPYING_STATUSES } from './lessons';

/** Current start/end dates of a cycle (for prefilling + validating the end-date editor). */
export async function getCycleDates(cycleId: string): Promise<{ start_date: string | null; end_date: string | null }> {
  const { data, error } = await supabase
    .from('cycles')
    .select('start_date, end_date')
    .eq('id', cycleId)
    .maybeSingle();
  if (error) throw error;
  return { start_date: data?.start_date ?? null, end_date: data?.end_date ?? null };
}

export interface OutOfRangeSlots {
  /** Unbooked sessions after the proposed end date — safe to delete. */
  removableIds: string[];
  /** Sessions after the proposed end date that have an active booking — must be kept. */
  protectedCount: number;
}

/** Find the sessions of a cyclus that fall AFTER a proposed end date, split into
 *  removable (no active booking) vs protected (booked). Used by the end-date editor's
 *  trim preview. A session counts as out-of-range when its start is strictly after the
 *  end-of-day of `endDate` (yyyy-mm-dd), so sessions ON the end date stay in range.
 *  Scans the whole cyclus (all trainers) — end_date is a cycle-wide field. */
export async function findSlotsAfterDate(cyclusId: string, endDate: string): Promise<OutOfRangeSlots> {
  const { data: slots, error } = await supabase
    .from('availability_slots')
    .select('id')
    .eq('cyclus_id', cyclusId)
    .gt('start_time', `${endDate}T23:59:59`);
  if (error) throw error;
  const ids = (slots ?? []).map((s: { id: string }) => s.id);
  if (ids.length === 0) return { removableIds: [], protectedCount: 0 };
  const { data: booked } = await supabase
    .from('bookings')
    .select('slot_id')
    .in('slot_id', ids)
    .in('status', [...CAPACITY_OCCUPYING_STATUSES]);
  const bookedSet = new Set((booked ?? []).map((b: { slot_id: string }) => b.slot_id));
  const removableIds = ids.filter((id) => !bookedSet.has(id));
  return { removableIds, protectedCount: ids.length - removableIds.length };
}

/** Delete the given sessions, re-verifying right before deletion that none gained an
 *  occupying booking since the preview (a player booking is never silently cancelled).
 *  Deleting an availability_slot CASCADES (FK ON DELETE CASCADE) to its bookings, claims,
 *  session reports + notes — which is exactly why the booking re-check is the load-bearing
 *  guard here. Invoices are not FK-linked to slots, so they are untouched. */
export async function deleteUnbookedSlots(slotIds: string[]): Promise<number> {
  if (slotIds.length === 0) return 0;
  // Atomic delete via the canonical RPC: it locks each slot + its bookings FOR UPDATE and KEEPS any
  // that holds a booking, instead of the old check-then-delete (which could cascade-destroy a
  // booking that landed between the booking check and the DELETE). No cycle id → no split recompute,
  // which matches this trim's prior behaviour (it only removes unbooked tail sessions).
  const res = await applySlotDeleteToCycle(null, slotIds);
  return res.deletedCount;
}

export async function deleteCycle(cycleId: string): Promise<void> {
  const { error } = await supabase
    .from('cycles')
    .delete()
    .eq('id', cycleId);

  if (error) throw error;
}

// Intake Requests CRUD
export async function getIntakeRequests(cycleId: string): Promise<IntakeRequest[]> {
  const { data, error } = await supabase
    .from('intake_requests')
    .select('*')
    .eq('cycle_id', cycleId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return (data || []).map(toIntakeRequest);
}

export async function getIntakeRequestsByOwner(
  ownerType: 'trainer' | 'club' | 'academy',
  ownerId: string,
  status?: string
): Promise<IntakeRequest[]> {
  // First get cycles for this owner
  const cyclesQuery = supabase
    .from('cycles')
    .select('id')
    .eq('owner_type', ownerType)
    .eq('owner_id', ownerId);

  const { data: cycles, error: cyclesError } = await cyclesQuery;
  if (cyclesError) throw cyclesError;
  
  if (!cycles || cycles.length === 0) return [];

  const cycleIds = cycles.map(c => c.id);

  let query = supabase
    .from('intake_requests')
    .select('*')
    .in('cycle_id', cycleIds)
    .order('created_at', { ascending: true });

  if (status) {
    query = query.eq('status', status);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(toIntakeRequest);
}

// Fetch intake requests with their proposal details bundled
export async function getIntakeRequestsWithProposals(
  ownerType: 'trainer' | 'club' | 'academy',
  ownerId: string
): Promise<IntakeRequestWithProposal[]> {
  // First get all requests
  const requests = await getIntakeRequestsByOwner(ownerType, ownerId);
  if (requests.length === 0) return [];

  const requestIds = requests.map(r => r.id);

  // Payment status per request: registration/event cycles mint an invoice, so surface
  // paid/unpaid in the table. Read invoice_id straight off the rows (select('*')), then
  // resolve each invoice's status in one query.
  const { data: payRows } = await supabase
    .from('intake_requests')
    .select('id, invoice_id, payment_method')
    .in('id', requestIds);
  const invoiceIds = [...new Set((payRows || []).map(p => p.invoice_id).filter((x): x is string => !!x))];
  const invoiceStatusById = new Map<string, string>();
  if (invoiceIds.length > 0) {
    const { data: invs } = await supabase.from('invoices').select('id, status').in('id', invoiceIds);
    invs?.forEach(i => invoiceStatusById.set(i.id, i.status as string));
  }
  const payByReq = new Map<string, { invoice_id: string | null; payment_method: string | null; invoice_status: string | null }>();
  (payRows || []).forEach(p => payByReq.set(p.id, {
    invoice_id: p.invoice_id ?? null,
    payment_method: p.payment_method ?? null,
    invoice_status: p.invoice_id ? (invoiceStatusById.get(p.invoice_id) ?? null) : null,
  }));

  // Fetch all proposals for these requests with slot info (no nested profile join)
  const { data: proposals, error } = await supabase
    .from('proposed_assignments')
    .select(`
      *,
      slot:availability_slots(id, start_time, end_time)
    `)
    .in('intake_request_id', requestIds);

  if (error) {
    logger.warn('Error fetching proposals', { error });
    return requests; // Return requests without proposals on error
  }

  // Resolve trainer names via separate queries (no FK from trainer_profiles to profiles)
  const trainerIds = [...new Set((proposals || []).map(p => p.trainer_id).filter(Boolean))];
  const trainerProfileMap = new Map<string, { full_name: string; avatar_url: string | null }>();

  if (trainerIds.length > 0) {
    const { data: trainerProfiles } = await supabase
      .from('trainer_profiles')
      .select('id, user_id')
      .in('id', trainerIds);

    if (trainerProfiles && trainerProfiles.length > 0) {
      const userIds = trainerProfiles.map(tp => tp.user_id);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, full_name, avatar_url')
        .in('user_id', userIds);

      trainerProfiles.forEach(tp => {
        const profile = profiles?.find(p => p.user_id === tp.user_id);
        if (profile) {
          trainerProfileMap.set(tp.id, {
            full_name: profile.full_name || 'Unknown',
            avatar_url: profile.avatar_url,
          });
        }
      });
    }
  }

  // Group proposals by slot_id to find group members
  const slotGroups = new Map<string, { requestId: string; name: string }[]>();
  proposals?.forEach(p => {
    const existing = slotGroups.get(p.slot_id) || [];
    const reqName = requests.find(r => r.id === p.intake_request_id)?.full_name;
    if (reqName) {
      existing.push({ requestId: p.intake_request_id, name: reqName });
    }
    slotGroups.set(p.slot_id, existing);
  });

  // Merge proposals into requests
  return requests.map(req => {
    const pay = payByReq.get(req.id) || { invoice_id: null, payment_method: null, invoice_status: null };
    const proposal = proposals?.find(p => p.intake_request_id === req.id);
    if (!proposal || !proposal.slot) return { ...req, ...pay };

    const groupMembers = slotGroups.get(proposal.slot_id)
      ?.filter(m => m.requestId !== req.id)
      ?.map(m => m.name) || [];

    const trainerInfo = trainerProfileMap.get(proposal.trainer_id);

    return {
      ...req,
      ...pay,
      proposal: {
        slot_day: format(new Date(proposal.slot.start_time), 'EEEE'),
        slot_time: `${format(new Date(proposal.slot.start_time), 'HH:mm')} - ${format(new Date(proposal.slot.end_time), 'HH:mm')}`,
        slot_date: format(new Date(proposal.slot.start_time), 'MMM d'),
        slot_start: proposal.slot.start_time,
        slot_end: proposal.slot.end_time,
        trainer_id: proposal.trainer_id,
        trainer_name: trainerInfo?.full_name || 'Unknown',
        trainer_avatar: trainerInfo?.avatar_url || null,
        confidence_score: proposal.confidence_score || 0,
        group_members: groupMembers,
      },
    };
  });
}

export async function getPlayerIntakeRequests(playerId: string): Promise<IntakeRequest[]> {
  const { data, error } = await supabase
    .from('intake_requests')
    .select('*')
    .eq('player_id', playerId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data || []).map(toIntakeRequest);
}

export async function getIntakeRequest(requestId: string): Promise<IntakeRequest | null> {
  const { data, error } = await supabase
    .from('intake_requests')
    .select('*')
    .eq('id', requestId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw error;
  }
  return toIntakeRequest(data);
}

export async function submitIntakeRequest(input: IntakeRequestInput): Promise<IntakeRequest> {
  // Rate limiting: Check for recent submissions from same email (max 3 per hour)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from('intake_requests')
    .select('*', { count: 'exact', head: true })
    .eq('email', input.email)
    .gte('created_at', oneHourAgo);

  if (count && count >= 3) {
    throw new Error('Too many applications submitted. Please try again later.');
  }

  // Fetch cycle to get owner info for auto-follow
  const { data: cycle } = await supabase
    .from('cycles')
    .select('owner_type, owner_id')
    .eq('id', input.cycle_id)
    .single();

  const insertData = {
    cycle_id: input.cycle_id,
    player_id: input.player_id,
    full_name: input.full_name,
    email: input.email,
    phone: input.phone || null,
    birth_date: input.birth_date || null,
    rating: input.rating || null,
    rating_system: input.rating_system || 'knltb',
    lesson_type: input.lesson_types,
    preferred_days: input.preferred_days,
    preferred_time_windows: input.preferred_time_windows as unknown as Json,
    preferred_duration_minutes: input.preferred_duration_minutes || 60,
    sessions_per_week: input.sessions_per_week || 1,
    preferred_trainer_ids: input.preferred_trainer_ids || [],
    location_id: input.location_id || null,
    notes: input.notes || null,
    consent_given: input.consent_given,
    metadata: (input.metadata || {}) as unknown as Json,
    status: 'new' as const,
  };
  
  const { data, error } = await supabase
    .from('intake_requests')
    .insert(insertData)
    .select()
    .single();

  if (error) throw error;

  // Auto-follow and add to student list (non-blocking - don't fail registration)
  if (cycle) {
    const ownerType = cycle.owner_type as 'trainer' | 'club' | 'academy';
    await autoFollowOwner(ownerType, cycle.owner_id, input.player_id);
    await addToStudentList(ownerType, cycle.owner_id, input);
  }

  return toIntakeRequest(data);
}

// Auto-follow the cycle owner (trainer, club, or academy)
async function autoFollowOwner(
  ownerType: 'trainer' | 'club' | 'academy',
  ownerId: string,
  playerId: string
): Promise<void> {
  try {
    if (ownerType === 'trainer') {
      await supabase
        .from('trainer_followers')
        .upsert({
          player_id: playerId,
          trainer_id: ownerId,
          notify_new_availability: true,
        }, { onConflict: 'player_id,trainer_id' });
    } else if (ownerType === 'club') {
      await supabase
        .from('club_followers')
        .upsert({
          player_id: playerId,
          club_profile_id: ownerId,
          notify_new_availability: true,
        }, { onConflict: 'player_id,club_profile_id' });
    } else if (ownerType === 'academy') {
      await supabase
        .from('academy_followers')
        .upsert({
          player_id: playerId,
          academy_profile_id: ownerId,
          notify_new_availability: true,
        }, { onConflict: 'player_id,academy_profile_id' });
    }
  } catch (error) {
    logger.warn('Auto-follow failed (non-blocking)', { error });
  }
}

// Add player to student list as a prospect (non-blocking — registration never fails on this).
//
// NEVER upsert here: the guest_players/club_players unique email indexes are
// PARTIAL (WHERE email <> '' ..., migrations 20260224171306 / 20260126164841)
// and PostgREST upserts cannot target partial indexes (Postgres 42P10), which
// silently broke applicant -> player creation. Use select-then-insert instead.
//
// RLS note: submitIntakeRequest only runs for logged-in players (the anonymous
// guest flow goes through the submit-guest-intake edge function, which uses the
// service-role client). The INSERT policies from migration 20260126164841 allow
// this because we set linked_profile_id = the player's own profile id AND
// source = 'cycle_registration'. Players have no SELECT/UPDATE policy on these
// tables though, so when a row with the same email already exists (e.g. added
// manually by the trainer) the dedup select misses, the insert hits the unique
// index (23505) and resolution yields null — acceptable, since the player
// already exists in the list. A SECURITY DEFINER RPC would be needed to dedup
// across rows the player cannot see; deliberately not built now.
async function addToStudentList(
  ownerType: 'trainer' | 'club' | 'academy',
  ownerId: string,
  input: IntakeRequestInput
): Promise<void> {
  try {
    if (ownerType === 'trainer' || ownerType === 'academy') {
      const scope: GuestResolveScope =
        ownerType === 'trainer'
          ? { kind: 'trainer', trainerId: ownerId }
          : { kind: 'academy', academyProfileId: ownerId };
      const guestPlayerId = await resolveOrCreateGuestPlayer({
        scope,
        fullName: input.full_name,
        email: input.email,
        phone: input.phone || null,
        skillRating: input.rating ?? null,
        ratingSystem: input.rating_system || 'knltb',
        birthDate: input.birth_date || null,
        linkedProfileId: input.player_id,
        source: 'cycle_registration',
        hasTrained: false,
        patchExistingEmptyFields: true,
      });
      if (!guestPlayerId) {
        logger.error('Add to student list failed (non-blocking)', undefined, {
          ownerType,
          ownerId,
          cycleId: input.cycle_id,
        });
      }
    } else if (ownerType === 'club') {
      await addToClubStudentList(ownerId, input);
    }
  } catch (error) {
    logger.error(
      'Add to student list failed (non-blocking)',
      error instanceof Error ? error : new Error(String(error)),
      { ownerType, ownerId, cycleId: input.cycle_id },
    );
  }
}

// club_players variant: select-by-email-then-insert (unique_club_player_email is
// also a PARTIAL index — WHERE email IS NOT NULL AND email != '' — so upsert
// with onConflict fails with 42P10 exactly like guest_players did).
async function addToClubStudentList(
  clubProfileId: string,
  input: IntakeRequestInput
): Promise<void> {
  const email = input.email.trim();

  if (email) {
    const { data: existing } = await supabase
      .from('club_players')
      .select('id')
      .eq('club_profile_id', clubProfileId)
      .eq('email', email)
      .limit(1)
      .maybeSingle();
    if (existing?.id) return;
  }

  const { error } = await supabase.from('club_players').insert({
    club_profile_id: clubProfileId,
    full_name: input.full_name,
    email, // NOT NULL column on club_players
    phone: input.phone || null,
    skill_rating: input.rating ?? null,
    rating_system: input.rating_system || 'knltb',
    linked_profile_id: input.player_id,
    source: 'cycle_registration',
    has_trained: false,
  });

  // 23505 = a concurrent writer (or an RLS-invisible row) already holds this
  // email for the club — the player exists in the list, nothing to do.
  if (error && error.code !== '23505') {
    logger.error('Add to club student list failed (non-blocking)', new Error(error.message), {
      clubProfileId,
      cycleId: input.cycle_id,
      errorCode: error.code,
    });
  }
}

export async function updateIntakeRequestStatus(
  requestId: string,
  status: IntakeRequest['status']
): Promise<IntakeRequest> {
  const { data, error } = await supabase
    .from('intake_requests')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', requestId)
    .select()
    .single();

  if (error) throw error;
  return toIntakeRequest(data);
}

// Proposed Assignments CRUD
export async function getProposedAssignments(cycleId: string): Promise<ProposedAssignment[]> {
  // First get intake request IDs for this cycle
  const { data: requests, error: reqError } = await supabase
    .from('intake_requests')
    .select('id')
    .eq('cycle_id', cycleId);

  if (reqError) throw reqError;
  if (!requests || requests.length === 0) return [];

  const requestIds = requests.map(r => r.id);

  const { data, error } = await supabase
    .from('proposed_assignments')
    .select('*')
    .in('intake_request_id', requestIds)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return (data || []).map(toProposedAssignment);
}

export async function getProposedAssignmentForRequest(
  requestId: string
): Promise<EnrichedProposedAssignment | null> {
  const { data, error } = await supabase
    .from('proposed_assignments')
    .select(`
      *,
      slot:availability_slots(
        id, start_time, end_time, location_id, cyclus_name, max_participants
      )
    `)
    .eq('intake_request_id', requestId)
    .eq('status', 'proposed')
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  // Resolve trainer profile via separate queries
  let trainerData: { id: string; profile: { full_name: string; avatar_url: string | null } } | null = null;
  if (data.trainer_id) {
    const { data: tp } = await supabase
      .from('trainer_profiles')
      .select('id, user_id')
      .eq('id', data.trainer_id)
      .single();

    if (tp) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name, avatar_url')
        .eq('user_id', tp.user_id)
        .single();

      trainerData = {
        id: tp.id,
        profile: {
          full_name: profile?.full_name || 'Unknown',
          avatar_url: profile?.avatar_url || null,
        },
      };
    }
  }

  // Attach trainer data to the result before converting
  const enrichedData = {
    ...data,
    trainer: trainerData,
  };

  return toProposedAssignment(enrichedData) as EnrichedProposedAssignment;
}

export async function createProposedAssignment(
  intakeRequestId: string,
  slotId: string,
  trainerId: string,
  confidenceScore: number,
  rationale: RationaleItem[]
): Promise<ProposedAssignment> {
  const insertData = {
    intake_request_id: intakeRequestId,
    slot_id: slotId,
    trainer_id: trainerId,
    confidence_score: confidenceScore,
    rationale: rationale as unknown as Json,
    status: 'proposed' as const,
  };
  
  const { data, error } = await supabase
    .from('proposed_assignments')
    .insert(insertData)
    .select()
    .single();

  if (error) throw error;
  return toProposedAssignment(data);
}

export async function updateProposedAssignmentStatus(
  assignmentId: string,
  status: ProposedAssignment['status']
): Promise<ProposedAssignment> {
  const { data, error } = await supabase
    .from('proposed_assignments')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', assignmentId)
    .select()
    .single();

  if (error) throw error;
  return toProposedAssignment(data);
}

export async function updateProposedAssignment(
  assignmentId: string,
  updates: {
    slot_id?: string;
    trainer_id?: string;
    status?: ProposedAssignment['status'];
    confidence_score?: number | null;
    rationale?: RationaleItem[];
  }
): Promise<ProposedAssignment> {
  const updateData: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (updates.slot_id !== undefined) updateData.slot_id = updates.slot_id;
  if (updates.trainer_id !== undefined) updateData.trainer_id = updates.trainer_id;
  if (updates.status !== undefined) updateData.status = updates.status;
  if (updates.confidence_score !== undefined) updateData.confidence_score = updates.confidence_score;
  if (updates.rationale !== undefined) updateData.rationale = updates.rationale as unknown as Json;

  const { data, error } = await supabase
    .from('proposed_assignments')
    .update(updateData)
    .eq('id', assignmentId)
    .select()
    .single();

  if (error) throw error;
  return toProposedAssignment(data);
}

// Get all available slots for a cycle with current assignment counts
export interface SlotWithOccupancy {
  id: string;
  start_time: string;
  end_time: string;
  trainer_id: string;
  trainer_name: string;
  trainer_avatar: string | null;
  max_participants: number | null;
  min_rating: number | null;
  max_rating: number | null;
  rating_system: string | null;
  cyclus_name: string | null;
  is_blocked?: boolean;
  is_public?: boolean;
  current_assignments: Array<{
    id: string;
    intake_request_id: string;
    player_name: string;
    player_rating: number | null;
    player_rating_system: string | null;
    confidence_score: number | null;
    sessions_per_week: number;
  }>;
}

export async function getAvailableSlotsForCycle(cycleId: string): Promise<SlotWithOccupancy[]> {
  // 1. Get cycle to know date range and owner
  const { data: cycle, error: cycleError } = await supabase
    .from('cycles')
    .select('start_date, end_date, owner_id, owner_type')
    .eq('id', cycleId)
    .single();

  if (cycleError) throw cycleError;

  // 2. Get trainer IDs for this owner
  let trainerIds: string[] = [];
  if (cycle.owner_type === 'academy') {
    const { data: trainers } = await supabase
      .from('academy_trainers')
      .select('trainer_profile_id')
      .eq('academy_profile_id', cycle.owner_id)
      .eq('status', 'active');
    trainerIds = (trainers || []).map(t => t.trainer_profile_id);
  } else {
    // For trainer-owned cycles, get trainer_profile_id from user_id
    const { data: tp } = await supabase
      .from('trainer_profiles')
      .select('id')
      .eq('user_id', cycle.owner_id)
      .single();
    if (tp) trainerIds = [tp.id];
  }

  if (trainerIds.length === 0) return [];

  // 3. Fetch availability slots for this specific cycle
  const { data: slots, error: slotsError } = await supabase
    .from('availability_slots')
    .select('id, start_time, end_time, trainer_id, max_participants, cyclus_name, min_rating, max_rating, rating_system, is_public')
    .eq('cyclus_id', cycleId)
    .order('start_time', { ascending: true });

  if (slotsError) throw slotsError;
  if (!slots || slots.length === 0) {
    // Even with no cycle slots, fetch blocked (existing) slots for trainers
    // Fall through to blocked slot logic below
  }

  // 4. Fetch all proposed_assignments for intake_requests in this cycle
  const { data: requests } = await supabase
    .from('intake_requests')
    .select('id, full_name, rating, rating_system, sessions_per_week')
    .eq('cycle_id', cycleId);

  const requestMap = new Map((requests || []).map(r => [r.id, r]));
  const requestIds = (requests || []).map(r => r.id);

  let assignments: Array<{ id: string; intake_request_id: string; slot_id: string; confidence_score: number | null }> = [];
  if (requestIds.length > 0) {
    const { data: pa } = await supabase
      .from('proposed_assignments')
      .select('id, intake_request_id, slot_id, confidence_score')
      .in('intake_request_id', requestIds)
      .eq('status', 'proposed');
    assignments = pa || [];
  }


  // 5. Get trainer profiles -> user_ids -> profiles (two-step)
  const uniqueTrainerIds = [...new Set(slots.map(s => s.trainer_id))];
  const { data: trainerProfiles } = await supabase
    .from('trainer_profiles')
    .select('id, user_id')
    .in('id', uniqueTrainerIds);

  const userIds = (trainerProfiles || []).map(tp => tp.user_id).filter(Boolean);
  const { data: profiles } = await supabase
    .from('profiles')
    .select('user_id, full_name, avatar_url')
    .in('user_id', userIds);

  const trainerNameMap = new Map<string, { name: string; avatar: string | null }>();
  for (const tp of trainerProfiles || []) {
    const profile = (profiles || []).find(p => p.user_id === tp.user_id);
    trainerNameMap.set(tp.id, {
      name: profile?.full_name || 'Unknown',
      avatar: profile?.avatar_url || null,
    });
  }

  // 6. Build result
  const slotAssignmentMap = new Map<string, typeof assignments>();
  for (const a of assignments) {
    const existing = slotAssignmentMap.get(a.slot_id) || [];
    existing.push(a);
    slotAssignmentMap.set(a.slot_id, existing);
  }

  const cycleSlots: SlotWithOccupancy[] = (slots || []).map(slot => {
    const trainer = trainerNameMap.get(slot.trainer_id) || { name: 'Unknown', avatar: null };
    const slotAssignments = slotAssignmentMap.get(slot.id) || [];

    return {
      id: slot.id,
      start_time: slot.start_time,
      end_time: slot.end_time,
      trainer_id: slot.trainer_id,
      trainer_name: trainer.name,
      trainer_avatar: trainer.avatar,
      max_participants: slot.max_participants,
      min_rating: slot.min_rating ?? null,
      max_rating: slot.max_rating ?? null,
      rating_system: slot.rating_system ?? null,
      cyclus_name: slot.cyclus_name,
      is_blocked: false,
      is_public: slot.is_public,
      current_assignments: slotAssignments.map(a => {
        const req = requestMap.get(a.intake_request_id);
        return {
          id: a.id,
          intake_request_id: a.intake_request_id,
          player_name: req?.full_name || 'Unknown',
          player_rating: req?.rating ?? null,
          player_rating_system: req?.rating_system ?? null,
          confidence_score: a.confidence_score,
          sessions_per_week: req?.sessions_per_week ?? 1,
        };
      }),
    };
  });

  // 7. Fetch existing (non-cycle) slots for the same trainers within the cycle date range → blocked
  const { data: existingSlots } = await supabase
    .from('availability_slots')
    .select('id, start_time, end_time, trainer_id, max_participants, cyclus_name')
    .in('trainer_id', trainerIds)
    .is('cyclus_id', null)
    .gte('start_time', cycle.start_date)
    .lte('end_time', cycle.end_date)
    .order('start_time', { ascending: true });

  const blockedSlots: SlotWithOccupancy[] = (existingSlots || []).map(slot => {
    const trainer = trainerNameMap.get(slot.trainer_id) || { name: 'Unknown', avatar: null };
    return {
      id: slot.id,
      start_time: slot.start_time,
      end_time: slot.end_time,
      trainer_id: slot.trainer_id,
      trainer_name: trainer.name,
      trainer_avatar: trainer.avatar,
      max_participants: slot.max_participants,
      min_rating: null,
      max_rating: null,
      rating_system: null,
      cyclus_name: slot.cyclus_name,
      is_blocked: true,
      current_assignments: [],
    };
  });

  return [...cycleSlots, ...blockedSlots];
}

export async function deleteProposedAssignment(assignmentId: string): Promise<void> {
  const { error } = await supabase
    .from('proposed_assignments')
    .delete()
    .eq('id', assignmentId);

  if (error) throw error;
}

// Helper: Check if player already applied to a cycle
export async function hasPlayerApplied(cycleId: string, playerId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('intake_requests')
    .select('id')
    .eq('cycle_id', cycleId)
    .eq('player_id', playerId)
    .maybeSingle();

  if (error) throw error;
  return !!data;
}

// Helper: Get intake request counts by status for a cycle
export async function getIntakeRequestCounts(cycleId: string): Promise<Record<string, number>> {
  const { data, error } = await supabase
    .from('intake_requests')
    .select('status')
    .eq('cycle_id', cycleId);

  if (error) throw error;

  const counts: Record<string, number> = {
    new: 0,
    proposed: 0,
    confirmed: 0,
    rejected: 0,
    waitlist: 0,
    total: 0,
  };

  (data || []).forEach(r => {
    counts[r.status] = (counts[r.status] || 0) + 1;
    counts.total++;
  });

  return counts;
}

// Generate proposals using the edge function with configurable weights
export interface TrainerAvailabilityInput {
  trainerId: string;
  trainerName: string;
  windows: { day: string; start: string; end: string }[];
  minRating: number | null;
  maxRating: number | null;
}

export async function generateProposals(
  cycleId: string,
  weights?: ScoringWeights,
  options?: {
    startDate?: string;
    trainerAvailability?: TrainerAvailabilityInput[];
    additionalCriteria?: string;
    linkStrategy?: 'strict' | 'prefer' | 'ignore';
    fillIncompleteGroups?: boolean;
    maxGroupSize?: number;
    timezone?: string;
  }
): Promise<{ generated: number; skipped: number; errors?: string[] }> {
  // Persist trainer availability windows to cycle settings for the schedule grid
  if (options?.trainerAvailability && options.trainerAvailability.length > 0) {
    try {
      const cycle = await getCycle(cycleId);
      if (cycle) {
        const updatedSettings: CycleSettings = {
          ...cycle.settings,
          trainer_availability_windows: options.trainerAvailability.map(ta => ({
            trainerId: ta.trainerId,
            trainerName: ta.trainerName,
            windows: ta.windows,
          })),
        };
        await updateCycle(cycleId, { settings: updatedSettings });
      }
    } catch {
      // Non-critical — don't block generation
      logger.warn('Failed to persist trainer availability windows', { cycleId });
    }
  }

  const { data, error } = await supabase.functions.invoke('generate-proposals', {
    body: {
      cycleId,
      weights,
      startDate: options?.startDate,
      trainerAvailability: options?.trainerAvailability,
      additionalCriteria: options?.additionalCriteria,
      linkStrategy: options?.linkStrategy ?? 'prefer',
      fillIncompleteGroups: options?.fillIncompleteGroups ?? true,
      maxGroupSize: options?.maxGroupSize,
      timezone: options?.timezone,
    }
  });

  if (error) throw error;
  return data;
}

// Save scoring weights as default for a cycle
export async function saveCycleScoringWeights(
  cycleId: string,
  weights: ScoringWeights
): Promise<Cycle> {
  // First get current settings
  const cycle = await getCycle(cycleId);
  if (!cycle) throw new Error('Cycle not found');

  const updatedSettings: CycleSettings = {
    ...cycle.settings,
    scoring_weights: weights,
  };

  return updateCycle(cycleId, { settings: updatedSettings });
}

// Reset all proposals for a cycle (delete proposed_assignments, generated slots, and set intake_requests back to 'new')
export async function resetProposals(cycleId: string): Promise<{ reset: number }> {
  // Step 0: Delete generated availability slots for this cycle — but NEVER a slot that already has
  // an active booking (bookings.slot_id is ON DELETE CASCADE → it would silently delete the booking).
  const { data: cycleSlots, error: cycleSlotsError } = await supabase
    .from('availability_slots')
    .select('id')
    .eq('cyclus_id', cycleId);
  if (cycleSlotsError) throw cycleSlotsError;
  // Atomic delete via the canonical RPC (locks slots + bookings FOR UPDATE; keeps any booked one)
  // instead of the old check-then-delete. Proposal slots are pre-booking, but this closes the
  // cascade-delete race defensively and matches every other delete path.
  const proposalSlotIds = (cycleSlots ?? []).map((s) => s.id);
  if (proposalSlotIds.length > 0) {
    await applySlotDeleteToCycle(null, proposalSlotIds);
  }

  // Get ALL intake requests for this cycle
  const { data: allRequests, error: allFetchError } = await supabase
    .from('intake_requests')
    .select('id')
    .eq('cycle_id', cycleId);

  if (allFetchError) throw allFetchError;
  if (!allRequests || allRequests.length === 0) return { reset: 0 };

  const allIds = allRequests.map(r => r.id);

  // Step 1: Delete ALL proposed assignments for this cycle's requests
  const { error: deleteError } = await supabase
    .from('proposed_assignments')
    .delete()
    .in('intake_request_id', allIds);

  if (deleteError) throw deleteError;

  // Step 2: Reset ALL intake requests to 'new' and clear skip_reason
  const { error: updateError } = await supabase
    .from('intake_requests')
    .update({ status: 'new', skip_reason: null })
    .eq('cycle_id', cycleId);

  if (updateError) throw updateError;

  // Step 3: Verify no stale proposals remain
  const { count } = await supabase
    .from('proposed_assignments')
    .select('*', { count: 'exact', head: true })
    .in('intake_request_id', allIds);

  if (count && count > 0) {
    logger.warn('Stale proposals remain after reset', { cycleId, count });
    throw new Error(`Reset incomplete: ${count} proposals could not be deleted. Please check permissions.`);
  }

  return { reset: allRequests.length };
}

// Reset only skipped intake requests (status='new' with skip_reason) back to a clean 'new' state
export async function resetSkippedRequests(cycleId: string): Promise<{ reset: number }> {
  const { data, error } = await supabase
    .from('intake_requests')
    .update({ skip_reason: null })
    .eq('cycle_id', cycleId)
    .eq('status', 'new')
    .not('skip_reason', 'is', null)
    .select('id');

  if (error) throw error;
  return { reset: data?.length ?? 0 };
}


export async function deleteIntakeRequest(requestId: string): Promise<void> {
  // First delete any associated proposed assignments
  const { error: proposalError } = await supabase
    .from('proposed_assignments')
    .delete()
    .eq('intake_request_id', requestId);

  if (proposalError) throw proposalError;

  // Then delete the intake request itself
  const { error } = await supabase
    .from('intake_requests')
    .delete()
    .eq('id', requestId);

  if (error) throw error;
}

// Update an existing intake request (edit registration)
export async function updateIntakeRequest(
  requestId: string,
  updates: Partial<{
    full_name: string;
    email: string;
    phone: string | null;
    rating: number | null;
    rating_system: string;
    lesson_type: string[];
    preferred_days: string[];
    preferred_time_windows: TimeWindow[];
    preferred_duration_minutes: number;
    sessions_per_week: number;
    preferred_trainer_ids: string[];
    notes: string | null;
    metadata: Record<string, unknown>;
  }>
): Promise<IntakeRequest> {
  const updateData: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (updates.full_name !== undefined) updateData.full_name = updates.full_name;
  if (updates.email !== undefined) updateData.email = updates.email;
  if (updates.phone !== undefined) updateData.phone = updates.phone;
  if (updates.rating !== undefined) updateData.rating = updates.rating;
  if (updates.rating_system !== undefined) updateData.rating_system = updates.rating_system;
  if (updates.lesson_type !== undefined) updateData.lesson_type = updates.lesson_type;
  if (updates.preferred_days !== undefined) updateData.preferred_days = updates.preferred_days;
  if (updates.preferred_time_windows !== undefined) updateData.preferred_time_windows = updates.preferred_time_windows as unknown as Json;
  if (updates.preferred_duration_minutes !== undefined) updateData.preferred_duration_minutes = updates.preferred_duration_minutes;
  if (updates.sessions_per_week !== undefined) updateData.sessions_per_week = updates.sessions_per_week;
  if (updates.preferred_trainer_ids !== undefined) updateData.preferred_trainer_ids = updates.preferred_trainer_ids;
  if (updates.notes !== undefined) updateData.notes = updates.notes;
  if (updates.metadata !== undefined) updateData.metadata = updates.metadata as unknown as Json;

  const { data, error } = await supabase
    .from('intake_requests')
    .update(updateData)
    .eq('id', requestId)
    .select()
    .single();

  if (error) throw error;
  return toIntakeRequest(data);
}

// Player Links (for linking registrations that want to train together)
export interface PlayerLink {
  id: string;
  link_group: string;
  intake_request_id: string;
  created_at: string;
}

export async function getPlayerLinks(cycleId: string): Promise<PlayerLink[]> {
  // Get all intake request ids for this cycle
  const { data: requests } = await supabase
    .from('intake_requests')
    .select('id')
    .eq('cycle_id', cycleId);

  if (!requests || requests.length === 0) return [];

  const requestIds = requests.map(r => r.id);
  const { data, error } = await supabase
    .from('player_links')
    .select('*')
    .in('intake_request_id', requestIds);

  if (error) throw error;
  return (data || []) as PlayerLink[];
}

export async function linkPlayers(intakeRequestIds: string[]): Promise<void> {
  if (intakeRequestIds.length < 2) throw new Error('Need at least 2 registrations to link');

  // Generate a shared link_group UUID
  const linkGroup = crypto.randomUUID();

  // First remove any existing links for these requests
  await supabase
    .from('player_links')
    .delete()
    .in('intake_request_id', intakeRequestIds);

  // Insert new links with shared group
  const inserts = intakeRequestIds.map(id => ({
    link_group: linkGroup,
    intake_request_id: id,
  }));

  const { error } = await supabase
    .from('player_links')
    .insert(inserts);

  if (error) throw error;
}

export async function unlinkPlayer(intakeRequestId: string): Promise<void> {
  // Get the link group for this request
  const { data: link } = await supabase
    .from('player_links')
    .select('link_group')
    .eq('intake_request_id', intakeRequestId)
    .single();

  if (!link) return;

  // Delete this player's link
  await supabase
    .from('player_links')
    .delete()
    .eq('intake_request_id', intakeRequestId);

  // If only 1 player remains in the group, remove them too (can't have a group of 1)
  const { data: remaining } = await supabase
    .from('player_links')
    .select('id')
    .eq('link_group', link.link_group);

  if (remaining && remaining.length === 1) {
    await supabase
      .from('player_links')
      .delete()
      .eq('link_group', link.link_group);
  }
}

// Create a manual intake request (for club managers to add registrations)
export async function createManualIntakeRequest(
  input: IntakeRequestInput & { player_id?: string | null; guest_player_id?: string | null }
): Promise<IntakeRequest> {
  const insertData: Record<string, unknown> = {
    cycle_id: input.cycle_id,
    player_id: input.player_id || null,
    guest_player_id: (input as any).guest_player_id || null,
    full_name: input.full_name,
    email: input.email,
    phone: input.phone || null,
    rating: input.rating || null,
    rating_system: input.rating_system || 'knltb',
    lesson_type: input.lesson_types,
    preferred_days: input.preferred_days,
    preferred_time_windows: input.preferred_time_windows as unknown as Json,
    preferred_duration_minutes: input.preferred_duration_minutes || 60,
    sessions_per_week: input.sessions_per_week || 1,
    preferred_trainer_ids: input.preferred_trainer_ids || [],
    location_id: input.location_id || null,
    notes: input.notes || null,
    consent_given: true,
    status: 'new' as const,
  };

  const { data, error } = await supabase
    .from('intake_requests')
    .insert(insertData as any)
    .select()
    .single();

  if (error) throw error;
  return toIntakeRequest(data);
}


/**
 * Update pricing on cycle record + bulk-update all linked availability_slots.
 */
export async function updateCyclePricing(
  cycleId: string,
  pricing: {
    price_per_session: number | null;
    extra_costs: ExtraCost[];
    split_payment: boolean;
    prices_include_vat: boolean;
  }
) {
  // Atomic: the RPC updates the cycle row AND all linked slots in ONE
  // transaction (id-ordered slot lock — shares the canonical cycle→slots lock
  // order with applySlotEditToCycle/applySlotDeleteToCycle), so billing (which
  // reads the slot columns) can never drift from the cycle after a partial
  // client-side write. (Was two separate updates.) NOTE: this only pushes the
  // price; the caller still runs syncInvoicesAfterPriceChange afterward to
  // rebuild affected invoice line-item amounts + PDFs (the pricing engine + PDF
  // regen can't run in Postgres).
  const { error } = await supabase.rpc('update_cycle_pricing', {
    _cycle_id: cycleId,
    _price_per_session: pricing.price_per_session,
    _extra_costs: pricing.extra_costs as unknown as Json,
    _split_payment: pricing.split_payment,
    _prices_include_vat: pricing.prices_include_vat,
  });

  if (error) throw error;
}
