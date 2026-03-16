import { supabase } from '@/lib/supabaseClient';
import type { Json } from '@/integrations/supabase/types';
import { format } from 'date-fns';
import { logger } from '@/lib/logger';

// Types
export interface PriceTableRow {
  label: string;
  price: number;
}

export interface Cycle {
  id: string;
  owner_type: 'trainer' | 'club' | 'academy';
  owner_id: string;
  name: string;
  description: string | null;
  start_date: string;
  end_date: string;
  enrollment_deadline: string | null;
  settings: CycleSettings;
  status: 'draft' | 'open' | 'closed' | 'archived';
  type: 'registration' | 'cyclus' | 'event';
  location_id: string | null;
  price_per_session: number | null;
  total_price: number | null;
  currency: string;
  terms: string | null;
  price_table: PriceTableRow[] | null;
  created_at: string;
  updated_at: string;
  // Joined data (optional)
  location?: { id: string; name: string; city: string } | null;
  _intakeCount?: number;
}

export interface ScoringWeights {
  time_match: number;
  preferred_trainer: number;
  level_compatible: number;
  priority_bonus: number;
  capacity_available: number;
  sessions_per_week: number;
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  time_match: 35,
  preferred_trainer: 20,
  level_compatible: 15,
  priority_bonus: 10,
  capacity_available: 10,
  sessions_per_week: 10,
};

export interface ExtraCost {
  description: string;
  price: number;
}

export type EventPaymentMethod = 'online' | 'cash' | 'both';

export interface CycleSettings {
  lesson_types?: ('private' | 'duo' | 'group' | 'kids')[];
  custom_lesson_types?: string[];
  show_preferred_trainer?: boolean;
  default_duration_minutes?: number;
  max_group_size?: number;
  min_group_size?: number;
  assigned_trainer_id?: string;
  min_skill_rating?: number;
  max_skill_rating?: number;
  rating_system?: string;
  applicable_trainer_ids?: string[];
  scoring_weights?: ScoringWeights;
  max_rating_spread?: number;
  rating_spread_system?: string;
  allow_single_booking?: boolean;
  extra_costs?: ExtraCost[];
  mark_as_paid?: boolean;
  payment_timing?: 'upfront' | 'invoice_after_weeks' | 'manual';
  invoice_delay_weeks?: number;
  // Event-specific settings
  payment_methods?: EventPaymentMethod;
  event_dates?: string[];
  max_participants?: number;
  // Custom success message shown after registration
  success_message?: string;
  // Custom text included in the confirmation email sent after registration
  confirmation_email_text?: string;
  // Stored trainer availability windows from the proposal wizard
  trainer_availability_windows?: TrainerAvailabilityWindow[];
  [key: string]: unknown; // Allow for Json compatibility
}

export interface TrainerAvailabilityWindow {
  trainerId: string;
  trainerName: string;
  trainerAvatar?: string | null;
  windows: { day: string; start: string; end: string }[];
}

export interface IntakeRequest {
  id: string;
  cycle_id: string;
  player_id: string;
  full_name: string;
  email: string;
  phone: string | null;
  rating: number | null;
  rating_system: string;
  lesson_type: 'private' | 'duo' | 'group' | 'kids';
  preferred_days: string[];
  preferred_time_windows: TimeWindow[];
  preferred_duration_minutes: number;
  sessions_per_week: number;
  preferred_trainer_ids: string[];
  location_id: string | null;
  notes: string | null;
  consent_given: boolean;
  status: 'new' | 'proposed' | 'confirmed' | 'rejected' | 'waitlist';
  skip_reason?: 'no_matching_slots' | 'all_slots_full' | 'no_available_trainers' | 'rating_outside_trainer_range' | 'rating_spread_exceeded' | null;
  created_at: string;
  updated_at: string;
}

export interface ProposalDetails {
  slot_day: string;      // e.g., "Monday"
  slot_time: string;     // e.g., "12:00 - 13:00"
  slot_date: string;     // e.g., "Feb 16"
  slot_start: string;    // ISO timestamp
  slot_end: string;      // ISO timestamp
  trainer_id: string;
  trainer_name: string;
  trainer_avatar?: string | null;
  confidence_score: number;
  group_members: string[];  // Other players in same slot
}

export interface IntakeRequestWithProposal extends IntakeRequest {
  proposal?: ProposalDetails;
}

export interface RationaleItem {
  type: string;
  score: number;
  detail: string;
}

export interface ProposedAssignment {
  id: string;
  intake_request_id: string;
  slot_id: string;
  trainer_id: string;
  status: 'proposed' | 'approved' | 'rejected' | 'confirmed';
  confidence_score: number | null;
  rationale: RationaleItem[] | null;
  created_at: string;
  updated_at: string;
}

export interface EnrichedProposedAssignment extends ProposedAssignment {
  slot?: {
    id: string;
    start_time: string;
    end_time: string;
    location_id: string | null;
    cyclus_name?: string | null;
    max_participants?: number | null;
  };
  trainer?: {
    id: string;
    profile?: { full_name: string; avatar_url: string | null } | null;
  };
}

export interface TimeWindow {
  day: string;
  start: string;
  end: string;
}

export interface IntakeRequestInput {
  cycle_id: string;
  player_id: string;
  full_name: string;
  email: string;
  phone?: string;
  birth_date?: string;
  rating?: number;
  rating_system?: string;
  lesson_types: string[];
  preferred_days: string[];
  preferred_time_windows: TimeWindow[];
  preferred_duration_minutes?: number;
  sessions_per_week?: number;
  preferred_trainer_ids?: string[];
  location_id?: string;
  notes?: string;
  consent_given?: boolean;
}

export interface CycleInput {
  owner_type: 'trainer' | 'club' | 'academy';
  owner_id: string;
  name: string;
  description?: string;
  start_date: string;
  end_date: string;
  enrollment_deadline?: string;
  settings?: CycleSettings;
  status?: 'draft' | 'open' | 'closed' | 'archived';
  type?: 'registration' | 'cyclus' | 'event';
  location_id?: string | null;
  price_per_session?: number | null;
  total_price?: number | null;
  currency?: string;
  terms?: string | null;
  price_table?: PriceTableRow[] | null;
}

// Helper to convert DB row to typed object
// Helper to convert DB row to typed object
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toCycle(row: Record<string, any>): Cycle {
  return {
    ...row,
    settings: (row.settings || {}) as CycleSettings,
    price_table: (row.price_table || null) as unknown as PriceTableRow[] | null,
  } as Cycle;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIntakeRequest(row: Record<string, any>): IntakeRequest {
  return {
    ...row,
    preferred_time_windows: (row.preferred_time_windows || []) as unknown as TimeWindow[],
  } as IntakeRequest;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toProposedAssignment(row: Record<string, any>): ProposedAssignment {
  return {
    ...row,
    rationale: (row.rationale || null) as unknown as RationaleItem[] | null,
  } as ProposedAssignment;
}

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
export async function getCyclesWithCounts(ownerType: 'trainer' | 'club' | 'academy', ownerId: string): Promise<Cycle[]> {
  const { data, error } = await supabase
    .from('cycles')
    .select('*, location:locations(id, name, city)')
    .eq('owner_type', ownerType)
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  
  const cycles = (data || []).map(toCycle);
  
  // Get intake counts for all cycles
  if (cycles.length > 0) {
    const cycleIds = cycles.map(c => c.id);
    const { data: intakeCounts } = await supabase
      .from('intake_requests')
      .select('cycle_id')
      .in('cycle_id', cycleIds);
    
    const countMap = new Map<string, number>();
    intakeCounts?.forEach(row => {
      countMap.set(row.cycle_id, (countMap.get(row.cycle_id) || 0) + 1);
    });
    
    cycles.forEach(cycle => {
      cycle._intakeCount = countMap.get(cycle.id) || 0;
    });
  }
  
  return cycles;
}

export async function getActiveCycles(ownerType: 'trainer' | 'club' | 'academy', ownerId: string): Promise<Cycle[]> {
  const { data, error } = await supabase
    .from('cycles')
    .select('*, location:locations(id, name, city)')
    .eq('owner_type', ownerType)
    .eq('owner_id', ownerId)
    .eq('status', 'open')
    .order('start_date', { ascending: true });

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
      .eq('status', 'open');
    if (trainerCycles) allCycles.push(...trainerCycles.map(toCycle));
  }
  
  if (academyIds.length > 0) {
    const { data: academyCycles } = await supabase
      .from('cycles')
      .select('*')
      .eq('owner_type', 'academy')
      .in('owner_id', academyIds)
      .eq('status', 'open');
    if (academyCycles) allCycles.push(...academyCycles.map(toCycle));
  }

  if (clubIds.length > 0) {
    const { data: clubCycles } = await supabase
      .from('cycles')
      .select('*')
      .eq('owner_type', 'club')
      .in('owner_id', clubIds)
      .eq('status', 'open');
    if (clubCycles) allCycles.push(...clubCycles.map(toCycle));
  }
  
  return allCycles.sort((a, b) => 
    new Date(a.start_date).getTime() - new Date(b.start_date).getTime()
  );
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

export async function createCycle(input: CycleInput): Promise<Cycle> {
  const insertData = {
    owner_type: input.owner_type,
    owner_id: input.owner_id,
    name: input.name,
    description: input.description || null,
    start_date: input.start_date,
    end_date: input.end_date,
    enrollment_deadline: input.enrollment_deadline || null,
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
  let cyclesQuery = supabase
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
    const proposal = proposals?.find(p => p.intake_request_id === req.id);
    if (!proposal || !proposal.slot) return req;

    const groupMembers = slotGroups.get(proposal.slot_id)
      ?.filter(m => m.requestId !== req.id)
      ?.map(m => m.name) || [];

    const trainerInfo = trainerProfileMap.get(proposal.trainer_id);

    return {
      ...req,
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

// Add player to student list as a prospect
async function addToStudentList(
  ownerType: 'trainer' | 'club' | 'academy',
  ownerId: string,
  input: IntakeRequestInput
): Promise<void> {
  try {
    if (ownerType === 'trainer') {
      await supabase
        .from('guest_players')
        .upsert({
          trainer_id: ownerId,
          full_name: input.full_name,
          email: input.email,
          phone: input.phone || null,
          skill_rating: input.rating || null,
          rating_system: input.rating_system || 'knltb',
          linked_profile_id: input.player_id,
          source: 'cycle_registration',
          has_trained: false,
        }, { 
          onConflict: 'trainer_id,email',
          ignoreDuplicates: false 
        });
    } else if (ownerType === 'club') {
      await supabase
        .from('club_players')
        .upsert({
          club_profile_id: ownerId,
          full_name: input.full_name,
          email: input.email,
          phone: input.phone || null,
          skill_rating: input.rating || null,
          rating_system: input.rating_system || 'knltb',
          linked_profile_id: input.player_id,
          source: 'cycle_registration',
          has_trained: false,
        }, { 
          onConflict: 'club_profile_id,email',
          ignoreDuplicates: false 
        });
    } else if (ownerType === 'academy') {
      await supabase
        .from('guest_players')
        .upsert({
          academy_profile_id: ownerId,
          full_name: input.full_name,
          email: input.email || null,
          phone: input.phone || null,
          skill_rating: input.rating || null,
          rating_system: input.rating_system || 'knltb',
          linked_profile_id: input.player_id,
          source: 'cycle_registration',
          has_trained: false,
        }, { 
          onConflict: 'academy_profile_id,email',
          ignoreDuplicates: false 
        });
    }
  } catch (error) {
    logger.warn('Add to student list failed (non-blocking)', { error });
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
  cyclus_name: string | null;
  is_blocked?: boolean;
  current_assignments: Array<{
    id: string;
    intake_request_id: string;
    player_name: string;
    player_rating: number | null;
    player_rating_system: string | null;
    confidence_score: number | null;
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
    .select('id, start_time, end_time, trainer_id, max_participants, cyclus_name')
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
    .select('id, full_name, rating, rating_system')
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
      cyclus_name: slot.cyclus_name,
      is_blocked: false,
      current_assignments: slotAssignments.map(a => {
        const req = requestMap.get(a.intake_request_id);
        return {
          id: a.id,
          intake_request_id: a.intake_request_id,
          player_name: req?.full_name || 'Unknown',
          player_rating: req?.rating ?? null,
          player_rating_system: req?.rating_system ?? null,
          confidence_score: a.confidence_score,
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
    } catch (e) {
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
  // Step 0: Delete generated availability slots for this cycle
  const { error: slotsDeleteError } = await supabase
    .from('availability_slots')
    .delete()
    .eq('cyclus_id', cycleId);

  if (slotsDeleteError) throw slotsDeleteError;

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

// Create a manual intake request (for club managers to add registrations)
export async function createManualIntakeRequest(
  input: IntakeRequestInput & { player_id: string }
): Promise<IntakeRequest> {
  const insertData = {
    cycle_id: input.cycle_id,
    player_id: input.player_id,
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
    .insert(insertData)
    .select()
    .single();

  if (error) throw error;
  return toIntakeRequest(data);
}

// Move a player assignment to a different slot
export async function movePlayerAssignment(assignmentId: string, newSlotId: string): Promise<void> {
  const { error } = await supabase
    .from('proposed_assignments')
    .update({ slot_id: newSlotId })
    .eq('id', assignmentId);

  if (error) throw error;
}

// Update the time range of an availability slot
export async function updateSlotTime(slotId: string, startTime: string, endTime: string): Promise<void> {
  const { error } = await supabase
    .from('availability_slots')
    .update({ start_time: startTime, end_time: endTime })
    .eq('id', slotId);

  if (error) throw error;
}

// Move an entire slot to a different trainer
export async function moveSlotToTrainer(slotId: string, newTrainerId: string): Promise<void> {
  const { error } = await supabase
    .from('availability_slots')
    .update({ trainer_id: newTrainerId })
    .eq('id', slotId);

  if (error) throw error;
}

// Move a slot: change trainer and/or time in a single update
export async function moveSlot(
  slotId: string,
  newTrainerId: string,
  newStartTime: string,
  newEndTime: string,
): Promise<void> {
  const { error } = await supabase
    .from('availability_slots')
    .update({
      trainer_id: newTrainerId,
      start_time: newStartTime,
      end_time: newEndTime,
    })
    .eq('id', slotId);

  if (error) throw error;
}

// Delete a slot and remove its proposal assignments (players return to unassigned pool)
export async function deleteSlot(slotId: string): Promise<void> {
  // First delete proposal assignments for this slot
  const { error: assignError } = await supabase
    .from('proposed_assignments')
    .delete()
    .eq('slot_id', slotId);
  if (assignError) throw assignError;

  // Then delete the slot itself
  const { error } = await supabase
    .from('availability_slots')
    .delete()
    .eq('id', slotId);
  if (error) throw error;
}

// Atomic swap of two slots using a DB function (single transaction)
export async function swapSlots(
  slotAId: string,
  slotANewTrainerId: string,
  slotANewStart: string,
  slotANewEnd: string,
  slotBId: string,
  slotBNewTrainerId: string,
  slotBNewStart: string,
  slotBNewEnd: string,
): Promise<void> {
  const { error } = await supabase.rpc('swap_slots', {
    _slot_a_id: slotAId,
    _slot_a_trainer_id: slotANewTrainerId,
    _slot_a_start: slotANewStart,
    _slot_a_end: slotANewEnd,
    _slot_b_id: slotBId,
    _slot_b_trainer_id: slotBNewTrainerId,
    _slot_b_start: slotBNewStart,
    _slot_b_end: slotBNewEnd,
  });

  if (error) throw error;
}
