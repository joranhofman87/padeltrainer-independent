import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { applySlotDeleteToCycle } from '@/lib/slotDeleteGuard';
import { isMissingRpc, isMissingRelation, reportDeployDriftFallback } from '@/lib/deployDrift';
import { toCycle, toIntakeRequest } from './cycleMappers';
import { updateCycle } from './cycleWrites';
import type { Cycle } from './cycleTypes';
import type { Json } from '@/integrations/supabase/types';
export type * from './cycleTypes';
export * from './cycleProposalSlots';
export * from './cycleIntakeReads';
export * from './cycleProposalAssignments';
export * from './cyclePricing';
export * from './cycleWrites';

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

/**
 * Cycle types shown on the PUBLIC "Open for Registration" list. Only application-based
 * cycles (registration + event) belong here — a `cyclus` (a slot-based training series
 * from the slot generator) is booked via the availability CALENDAR (its public slots),
 * NOT the registration list. This mirrors the admin split: AcademyRegistrations manages
 * registration/event, the cyclus-overview/agenda manages cyclus. Without this filter a
 * published cyclus wrongly appeared as a "registration".
 */
const PUBLIC_REGISTRATION_CYCLE_TYPES = ['registration', 'event'] as const;

/**
 * Cycles to show on an owner's PUBLIC page ("Open for Registration"): open registration/
 * event cycles only. Cyclus (slot-series) cycles are excluded — they surface on the
 * availability calendar via their public slots. All callers are public surfaces
 * (AcademyOpenCycles, TrainerOpenCycles, AcademyPublicProfile JSON-LD).
 */
/**
 * Batch-fetch the {id,name,city} location for a set of cycles and attach it as
 * `cycle.location` (the shape AcademyOpenCycles / AcademyPublicProfile render).
 * Used instead of a PostgREST embed because the anon path reads through the
 * cycles_public VIEW, and PostgREST cannot embed on a plain view (raises PGRST200,
 * which our missing-relation detector treats as "view missing"). A plain view +
 * JS location join is the repo pattern for every `_public`/`_safe` surface.
 */
async function attachCycleLocations(cycles: Cycle[]): Promise<Cycle[]> {
  const ids = Array.from(
    new Set(cycles.map((c) => c.location_id).filter((id): id is string => !!id)),
  );
  if (ids.length === 0) return cycles;
  const { data } = await supabase.from('locations').select('id, name, city').in('id', ids);
  const byId = new Map((data || []).map((l) => [l.id, l]));
  return cycles.map((c) => ({ ...c, location: c.location_id ? byId.get(c.location_id) ?? null : null }));
}

export async function getActiveCycles(ownerType: 'trainer' | 'club' | 'academy', ownerId: string): Promise<Cycle[]> {
  // Public/anon list (AcademyOpenCycles / TrainerOpenCycles / AcademyPublicProfile).
  // Read through the sanitized cycles_public view (PLAIN columns, NO embed) so
  // settings.notify_admin_emails never reaches an unauthenticated caller (P2-1),
  // then attach locations via a JS join. The view is status='open' only, which this
  // query already filtered to. Graceful fallback to the base table while the view
  // migration is not yet applied (frontend deploys first).
  const runQuery = (relation: 'cycles_public' | 'cycles') =>
    supabase
      .from(relation as never)
      .select('*')
      .eq('owner_type', ownerType)
      .eq('owner_id', ownerId)
      .eq('status', 'open')
      .in('type', PUBLIC_REGISTRATION_CYCLE_TYPES as unknown as string[])
      .order('start_date', { ascending: true, nullsFirst: true });

  const { data, error } = await runQuery('cycles_public');
  if (error) {
    if (!isMissingRelation(error)) throw error;
    reportDeployDriftFallback('cycles_public', { path: 'getActiveCycles' });
    const { data: baseData, error: baseErr } = await runQuery('cycles');
    if (baseErr) throw baseErr;
    return attachCycleLocations((baseData || []).map((r) => toCycle(r as Record<string, unknown>)));
  }
  return attachCycleLocations((data || []).map((r) => toCycle(r as Record<string, unknown>)));
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
  
  // Fetch cycles from all owner types.
  // Public/anon page (LocationOpenCycles on locations/:slug). Read through the
  // sanitized cycles_public view (PLAIN columns, no embed) so settings.notify_admin_emails
  // never reaches an unauthenticated caller (P2-1). No JS location join is needed here —
  // this query is already scoped to a single locationId and LocationOpenCycles does not
  // read cycle.location. Graceful fallback to the base table while the view migration is
  // not yet applied (frontend deploys first).
  const readOpenCyclesForOwner = async (
    ownerType: 'trainer' | 'academy' | 'club',
    ownerIds: string[],
  ): Promise<Cycle[]> => {
    const runQuery = (relation: 'cycles_public' | 'cycles') =>
      supabase
        .from(relation as never)
        .select('*')
        .eq('owner_type', ownerType)
        .in('owner_id', ownerIds)
        .eq('status', 'open')
        .in('type', PUBLIC_REGISTRATION_CYCLE_TYPES as unknown as string[])
        .eq('location_id', locationId);
    const { data, error } = await runQuery('cycles_public');
    if (error) {
      if (!isMissingRelation(error)) throw error;
      reportDeployDriftFallback('cycles_public', { path: 'getLocationCycles', ownerType });
      const { data: baseData, error: baseErr } = await runQuery('cycles');
      if (baseErr) throw baseErr;
      return (baseData || []).map((r) => toCycle(r as Record<string, unknown>));
    }
    return (data || []).map((r) => toCycle(r as Record<string, unknown>));
  };

  const allCycles: Cycle[] = [];

  if (trainerIds.length > 0) {
    allCycles.push(...(await readOpenCyclesForOwner('trainer', trainerIds)));
  }

  if (academyIds.length > 0) {
    allCycles.push(...(await readOpenCyclesForOwner('academy', academyIds)));
  }

  if (clubIds.length > 0) {
    allCycles.push(...(await readOpenCyclesForOwner('club', clubIds)));
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

/**
 * PUBLIC (anon) single-cycle read for the register/:cycleId form. Goes through the
 * postgres-owned `cycles_public` view (PLAIN columns, no embed), which sanitizes
 * `settings` (strips notify_admin_emails / notify_admin_on_submission) — so an
 * unauthenticated caller can never read the staff notification list (P2-1). The view
 * only exposes status='open' cycles, which is exactly what the public form serves.
 *
 * Graceful fallback: the frontend auto-deploys before the owner applies the view
 * migration, so a missing `cycles_public` (PGRST205 / PGRST200 / 42P01) drops back to
 * the base `cycles` table (unchanged legacy behaviour, still anon-readable until the
 * SAME migration restricts it) and reports deploy drift. Admin editors keep using
 * {@link getCycle} (full settings) — do NOT repoint that.
 */
export async function getPublicCycle(cycleId: string): Promise<Cycle | null> {
  const { data, error } = await supabase
    .from('cycles_public' as never)
    .select('*')
    .eq('id', cycleId)
    .maybeSingle();
  if (error) {
    if (isMissingRelation(error)) {
      reportDeployDriftFallback('cycles_public', { path: 'getPublicCycle' });
      const { data: baseData, error: baseErr } = await supabase
        .from('cycles')
        .select('*')
        .eq('id', cycleId)
        .maybeSingle();
      if (baseErr) throw baseErr;
      return baseData ? toCycle(baseData as Record<string, unknown>) : null;
    }
    throw error;
  }
  return data ? toCycle(data as Record<string, unknown>) : null;
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
  /** Count of sessions after the proposed end date that have an active booking. */
  protectedCount: number;
  /** Ids of those booked out-of-range sessions — the owner can opt to cancel + remove them. */
  protectedIds: string[];
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
  if (ids.length === 0) return { removableIds: [], protectedCount: 0, protectedIds: [] };
  const { data: booked } = await supabase
    .from('bookings')
    .select('slot_id')
    .in('slot_id', ids)
    .in('status', [...CAPACITY_OCCUPYING_STATUSES]);
  const bookedSet = new Set((booked ?? []).map((b: { slot_id: string }) => b.slot_id));
  const removableIds = ids.filter((id) => !bookedSet.has(id));
  const protectedIds = ids.filter((id) => bookedSet.has(id));
  return { removableIds, protectedCount: protectedIds.length, protectedIds };
}

// Intake Requests CRUD

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
// FAM-02 (Batch 4, Level 1): academy/trainer registrants are NO LONGER added here. A logged-in
// registrant is already a player via their profile and shows as a prospect in the intake-requests
// view, so minting a "self-shadow" guest linked to their own profile is redundant — and that
// overloaded linked_profile_id is exactly what the old players-overview de-dup had to collapse.
// Only the club vertical still keeps a club_players roster row (separate table + overview).
//
// club_players NEVER upserts: its unique email index is PARTIAL (WHERE email IS NOT NULL AND
// email != '', migration 20260126164841) and PostgREST upserts cannot target partial indexes
// (Postgres 42P10). Use select-then-insert; a 23505 on insert means the row already exists.
//
// RLS note (club): a logged-in player self-registering can INSERT the club_players row because
// migration 20260126164841's INSERT policy requires linked_profile_id = their own profile id AND
// source = 'cycle_registration' (both set in addToClubStudentList). Players have no SELECT/UPDATE
// on the table, so a pre-existing same-email row makes the dedup select miss and the insert hits
// the unique index (23505) — acceptable, the player is already listed.
async function addToStudentList(
  ownerType: 'trainer' | 'club' | 'academy',
  ownerId: string,
  input: IntakeRequestInput
): Promise<void> {
  try {
    if (ownerType === 'club') {
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

