import { supabase } from '@/lib/supabaseClient';
import type { Json } from '@/integrations/supabase/types';
import { format } from 'date-fns';
import { logger } from '@/lib/logger';

// Types
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
  type: 'registration' | 'cyclus';
  location_id: string | null;
  price_per_session: number | null;
  total_price: number | null;
  currency: string;
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

export interface CycleSettings {
  lesson_types?: ('private' | 'duo' | 'group' | 'kids')[];
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
  [key: string]: unknown; // Allow for Json compatibility
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
    lessons?: { id: string; title: string } | null;
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
  type?: 'registration' | 'cyclus';
  location_id?: string | null;
  price_per_session?: number | null;
  total_price?: number | null;
  currency?: string;
}

// Helper to convert DB row to typed object
function toCycle(row: any): Cycle {
  return {
    ...row,
    settings: (row.settings || {}) as CycleSettings,
  };
}

function toIntakeRequest(row: any): IntakeRequest {
  return {
    ...row,
    preferred_time_windows: (row.preferred_time_windows || []) as TimeWindow[],
  };
}

function toProposedAssignment(row: any): ProposedAssignment {
  return {
    ...row,
    rationale: (row.rationale || null) as RationaleItem[] | null,
  };
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
  return (data || []) as Cycle[];
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
  
  const cycles = (data || []) as Cycle[];
  
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
    .select('*')
    .eq('owner_type', ownerType)
    .eq('owner_id', ownerId)
    .eq('status', 'open')
    .order('start_date', { ascending: true });

  if (error) throw error;
  return (data || []) as Cycle[];
}

// Fetch all open cycles for a location (from trainers + academies at that location)
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
  
  // Fetch cycles from both
  const allCycles: Cycle[] = [];
  
  if (trainerIds.length > 0) {
    const { data: trainerCycles } = await supabase
      .from('cycles')
      .select('*')
      .eq('owner_type', 'trainer')
      .in('owner_id', trainerIds)
      .eq('status', 'open');
    if (trainerCycles) allCycles.push(...(trainerCycles as Cycle[]));
  }
  
  if (academyIds.length > 0) {
    const { data: academyCycles } = await supabase
      .from('cycles')
      .select('*')
      .eq('owner_type', 'academy')
      .in('owner_id', academyIds)
      .eq('status', 'open');
    if (academyCycles) allCycles.push(...(academyCycles as Cycle[]));
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
  return data as Cycle;
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

  // Fetch all proposals for these requests with slot and trainer info
  const { data: proposals, error } = await supabase
    .from('proposed_assignments')
    .select(`
      *,
      slot:availability_slots(id, start_time, end_time),
      trainer:trainer_profiles(
        id,
        profiles!trainer_profiles_user_id_fkey(full_name, avatar_url)
      )
    `)
    .in('intake_request_id', requestIds);

  if (error) {
    logger.warn('Error fetching proposals', { error });
    return requests; // Return requests without proposals on error
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

    // Get trainer name from the nested profile (type assertion for Supabase query result)
    const trainerProfile = proposal.trainer?.profiles as { full_name?: string; avatar_url?: string | null } | { full_name?: string; avatar_url?: string | null }[] | null;
    const trainerName = Array.isArray(trainerProfile) 
      ? trainerProfile[0]?.full_name 
      : trainerProfile?.full_name;
    const trainerAvatar = Array.isArray(trainerProfile) 
      ? trainerProfile[0]?.avatar_url 
      : trainerProfile?.avatar_url;

    return {
      ...req,
      proposal: {
        slot_day: format(new Date(proposal.slot.start_time), 'EEEE'),
        slot_time: `${format(new Date(proposal.slot.start_time), 'HH:mm')} - ${format(new Date(proposal.slot.end_time), 'HH:mm')}`,
        slot_date: format(new Date(proposal.slot.start_time), 'MMM d'),
        trainer_name: trainerName || 'Unknown',
        trainer_avatar: trainerAvatar,
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
    await autoFollowOwner(cycle.owner_type as 'trainer' | 'club', cycle.owner_id, input.player_id);
    await addToStudentList(cycle.owner_type as 'trainer' | 'club', cycle.owner_id, input);
  }

  return toIntakeRequest(data);
}

// Auto-follow the cycle owner (trainer or club)
async function autoFollowOwner(
  ownerType: 'trainer' | 'club',
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
    } else {
      await supabase
        .from('club_followers')
        .upsert({
          player_id: playerId,
          club_profile_id: ownerId,
          notify_new_availability: true,
        }, { onConflict: 'player_id,club_profile_id' });
    }
  } catch (error) {
    logger.warn('Auto-follow failed (non-blocking)', { error });
  }
}

// Add player to student list as a prospect
async function addToStudentList(
  ownerType: 'trainer' | 'club',
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
    } else {
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
        id, start_time, end_time, location_id,
        lessons(id, title)
      ),
      trainer:trainer_profiles(
        id,
        profile:profiles!trainer_profiles_user_id_fkey(full_name, avatar_url)
      )
    `)
    .eq('intake_request_id', requestId)
    .eq('status', 'proposed')
    .maybeSingle();

  if (error) throw error;
  return data ? toProposedAssignment(data) as EnrichedProposedAssignment : null;
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
  updates: { slot_id?: string; trainer_id?: string; status?: ProposedAssignment['status'] }
): Promise<ProposedAssignment> {
  const { data, error } = await supabase
    .from('proposed_assignments')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', assignmentId)
    .select()
    .single();

  if (error) throw error;
  return toProposedAssignment(data);
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
export async function generateProposals(
  cycleId: string,
  weights?: ScoringWeights
): Promise<{ generated: number; skipped: number; errors?: string[] }> {
  const { data, error } = await supabase.functions.invoke('generate-proposals', {
    body: { cycleId, weights }
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

// Delete an intake request and its associated proposals
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
