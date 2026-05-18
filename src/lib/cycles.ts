import { supabase } from '@/lib/supabaseClient';
import type { Json } from '@/integrations/supabase/types';
import { format } from 'date-fns';
import { logger } from '@/lib/logger';

// Types
export interface PriceTableRow {
  label: string;
  price: number;
  extra_prices?: { column_name: string; price: number }[];
}

export interface Cycle {
  id: string;
  owner_type: 'trainer' | 'club' | 'academy';
  owner_id: string;
  name: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  enrollment_deadline: string | null;
  is_always_open: boolean;
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
  type?: 'per_session' | 'one_time';
  vat_rate?: number;
}

export interface CyclusOption {
  label: string;
  number_of_sessions: number;
  number_of_weeks: number;
  price_per_session: number;
  total_price: number;
}

export type EventPaymentMethod = 'online' | 'cash' | 'both';

export interface CycleSettings {
  lesson_types?: ('private' | 'duo' | 'group' | 'group3' | 'group4' | 'kids')[];
  custom_lesson_types?: string[];
  show_preferred_trainer?: boolean;
  show_price_indication?: boolean;
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
  split_payment?: boolean;
  // Event-specific settings
  payment_methods?: EventPaymentMethod;
  event_dates?: string[];
  max_participants?: number;
  // Custom success message shown after registration
  success_message?: string;
  // Custom text included in the confirmation email sent after registration
  confirmation_email_text?: string;
  // Cyclus options (packages) for registration
  cyclus_options?: CyclusOption[];
  // Duration options (in weeks) players can choose from
  duration_options?: number[];
  // Available lesson duration options (in minutes) players can choose from
  available_duration_minutes?: number[];
  // Named price columns for the price table (e.g. ["Jeugd", "Volwassenen"])
  price_columns?: string[];
  // Whether the displayed prices include VAT
  prices_include_vat?: boolean;
  // Stored trainer availability windows from the proposal wizard
  trainer_availability_windows?: TrainerAvailabilityWindow[];
  // Pre-selected days & time frames available for registration
  available_days?: Record<string, { start: string; end: string }[]>;
  // Dates to exclude from recurring schedule (holidays, etc.)
  excluded_dates?: string[];
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
  lesson_type: 'private' | 'duo' | 'group' | 'group3' | 'group4' | 'kids';
  preferred_days: string[];
  preferred_time_windows: TimeWindow[];
  preferred_duration_minutes: number;
  sessions_per_week: number;
  preferred_trainer_ids: string[];
  location_id: string | null;
  birth_date: string | null;
  notes: string | null;
  consent_given: boolean;
  status: 'new' | 'proposed' | 'confirmed' | 'rejected' | 'waitlist';
  skip_reason?: 'no_matching_slots' | 'all_slots_full' | 'no_available_trainers' | 'rating_outside_trainer_range' | 'rating_spread_exceeded' | null;
  metadata?: Record<string, unknown>;
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
  metadata?: Record<string, unknown>;
}

export interface CycleInput {
  owner_type: 'trainer' | 'club' | 'academy';
  owner_id: string;
  name: string;
  description?: string;
  start_date?: string | null;
  end_date?: string | null;
  enrollment_deadline?: string | null;
  is_always_open?: boolean;
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
  // 1. Fetch assignments to get intake_request_ids before deleting
  const { data: assignments, error: fetchErr } = await supabase
    .from('proposed_assignments')
    .select('id, intake_request_id')
    .eq('slot_id', slotId);
  if (fetchErr) throw fetchErr;

  const affectedRequestIds = (assignments || [])
    .map(a => a.intake_request_id)
    .filter((id): id is string => !!id);

  // 2. Delete proposal assignments for this slot
  const { error: assignError } = await supabase
    .from('proposed_assignments')
    .delete()
    .eq('slot_id', slotId);
  if (assignError) throw assignError;

  // 3. For each affected intake request, check if it still has assignments elsewhere
  for (const requestId of affectedRequestIds) {
    const { count, error: countErr } = await supabase
      .from('proposed_assignments')
      .select('id', { count: 'exact', head: true })
      .eq('intake_request_id', requestId);
    if (countErr) throw countErr;

    if ((count ?? 0) === 0) {
      const { error: updateErr } = await supabase
        .from('intake_requests')
        .update({ status: 'new' })
        .eq('id', requestId);
      if (updateErr) throw updateErr;
    }
  }

  // 4. Delete the slot itself
  const { error } = await supabase
    .from('availability_slots')
    .delete()
    .eq('id', slotId);
  if (error) throw error;
}

// Create a new empty slot for the proposal schedule grid
export async function createProposalSlot(
  cycleId: string,
  trainerId: string,
  startTime: string,
  endTime: string,
): Promise<{ id: string }> {
  // Get cycle defaults
  const { data: cycle, error: cycleErr } = await supabase
    .from('cycles')
    .select('location_id, settings, owner_type, owner_id')
    .eq('id', cycleId)
    .single();
  if (cycleErr) throw cycleErr;

  const maxParticipants = (cycle.settings as any)?.max_participants ?? 4;
  const academyProfileId = cycle.owner_type === 'academy' ? cycle.owner_id : null;

  const { data, error } = await supabase
    .from('availability_slots')
    .insert({
      trainer_id: trainerId,
      start_time: startTime,
      end_time: endTime,
      cyclus_id: cycleId,
      location_id: cycle.location_id,
      max_participants: maxParticipants,
      is_public: false,
      is_recurring: false,
      academy_profile_id: academyProfileId,
    })
    .select('id')
    .single();
  if (error) throw error;
  return { id: data.id };
}

// Assign an unplaced player to a slot (creates proposed_assignment, updates intake request status)
export async function assignPlayerToSlot(intakeRequestId: string, slotId: string): Promise<void> {
  // Get the slot to find the trainer_id
  const { data: slot, error: slotErr } = await supabase
    .from('availability_slots')
    .select('trainer_id')
    .eq('id', slotId)
    .single();
  if (slotErr) throw slotErr;

  // Insert a proposed_assignment
  const { error: insertErr } = await supabase
    .from('proposed_assignments')
    .insert({
      intake_request_id: intakeRequestId,
      slot_id: slotId,
      trainer_id: slot.trainer_id,
      confidence_score: 0,
      rationale: [{ type: 'manual_assignment', score: 0, detail: 'Manually assigned by trainer' }],
    });
  if (insertErr) throw insertErr;

  // Update intake request status to proposed
  const { error: updateErr } = await supabase
    .from('intake_requests')
    .update({ status: 'proposed', skip_reason: null })
    .eq('id', intakeRequestId);
  if (updateErr) throw updateErr;
}

// Unassign a player from a slot (deletes proposed_assignment, reverts intake request to 'new')
export async function unassignPlayer(assignmentId: string): Promise<void> {
  // Get the assignment to find the intake_request_id
  const { data: assignment, error: getErr } = await supabase
    .from('proposed_assignments')
    .select('intake_request_id')
    .eq('id', assignmentId)
    .single();
  if (getErr) throw getErr;

  // Delete the proposed_assignment
  const { error: delErr } = await supabase
    .from('proposed_assignments')
    .delete()
    .eq('id', assignmentId);
  if (delErr) throw delErr;

  // Check if there are other assignments for this intake request
  const { count } = await supabase
    .from('proposed_assignments')
    .select('id', { count: 'exact', head: true })
    .eq('intake_request_id', assignment.intake_request_id);

  // If no more assignments, set back to 'new'
  if (count === 0) {
    const { error: updateErr } = await supabase
      .from('intake_requests')
      .update({ status: 'new' })
      .eq('id', assignment.intake_request_id);
    if (updateErr) throw updateErr;
  }
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

// ── CSV Export ──────────────────────────────────────────────

export function exportIntakeRequestsToCsv(
  requests: IntakeRequestWithProposal[],
  filename: string,
  trainerMap?: Record<string, string>, // id → name
  playerLinks?: PlayerLink[],
  locationMap?: Record<string, string>, // id → name
) {
  const dayKeys = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
  const dayHeaders = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  // Build link group lookup: requestId → set of linked request ids
  const linkedNamesMap = new Map<string, string[]>();
  if (playerLinks?.length) {
    const groupMap = new Map<string, string[]>();
    for (const pl of playerLinks) {
      if (!groupMap.has(pl.link_group)) groupMap.set(pl.link_group, []);
      groupMap.get(pl.link_group)!.push(pl.intake_request_id);
    }
    const nameMap = new Map(requests.map(r => [r.id, r.full_name]));
    for (const members of groupMap.values()) {
      for (const id of members) {
        const partners = members.filter(m => m !== id).map(m => nameMap.get(m) ?? m);
        if (partners.length) linkedNamesMap.set(id, partners);
      }
    }
  }

  const headers = [
    'Full Name', 'Email', 'Phone', 'Birth Date', 'Rating', 'Rating System',
    'Lesson Type', 'Location', 'Package', 'Preferred Weeks',
    ...dayHeaders,
    'Duration (min)', 'Sessions/Week', 'Preferred Trainers',
    'Notes', 'Status', 'Linked Players', 'Applied Date',
  ];

  const escCsv = (val: unknown) => `"${String(val ?? '').replace(/"/g, '""')}"`;

  const rows = requests.map((r) => {
    const trainers = (r.preferred_trainer_ids ?? [])
      .map((id) => trainerMap?.[id] ?? id)
      .join('; ');

    // Build a map: day → time ranges
    const windowsByDay: Record<string, string[]> = {};
    for (const tw of (r.preferred_time_windows ?? [])) {
      const key = (tw.day ?? '').toLowerCase();
      if (!windowsByDay[key]) windowsByDay[key] = [];
      windowsByDay[key].push(`${tw.start}-${tw.end}`);
    }

    const dayCols = dayKeys.map((day) => {
      if (windowsByDay[day]?.length) return windowsByDay[day].join('; ');
      // Day selected but no specific times → whole day
      if ((r.preferred_days ?? []).some((d: string) => d.toLowerCase() === day)) return '✓';
      return '';
    });

    const meta = r.metadata as Record<string, any> | undefined;
    const selectedOption = meta?.selected_cyclus_option;
    const packageLabel = selectedOption
      ? `${selectedOption.label ?? ''}${selectedOption.price != null ? ` (€${selectedOption.price})` : ''}`
      : '';
    const prefWeeks = meta?.preferred_number_of_weeks != null ? String(meta.preferred_number_of_weeks) : '';
    const locationName = r.location_id ? (locationMap?.[r.location_id] ?? '') : '';

    return [
      r.full_name,
      r.email,
      r.phone ?? '',
      r.birth_date ? format(new Date(r.birth_date), 'yyyy-MM-dd') : '',
      r.rating != null ? String(r.rating) : '',
      r.rating_system ?? '',
      Array.isArray(r.lesson_type) ? r.lesson_type.join('; ') : (r.lesson_type ?? ''),
      locationName,
      packageLabel,
      prefWeeks,
      ...dayCols,
      r.preferred_duration_minutes ? String(r.preferred_duration_minutes) : '',
      r.sessions_per_week ? String(r.sessions_per_week) : '',
      trainers,
      r.notes ?? '',
      r.status ?? '',
      (linkedNamesMap.get(r.id) ?? []).join('; '),
      r.created_at ? format(new Date(r.created_at), 'yyyy-MM-dd HH:mm') : '',
    ].map(escCsv).join(';');
  });

  const BOM = '\uFEFF';
  const csv = BOM + [headers.map(escCsv).join(';'), ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Finalize proposals: confirm assignments and create bookings
export async function finalizeProposals(cycleId: string): Promise<{ booked: number; bookings_created: number; errors: string[] }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Authentication required');

  const { data, error } = await supabase.functions.invoke('finalize-proposals', {
    body: { cycle_id: cycleId },
    headers: { Authorization: `Bearer ${session.access_token}` },
  });

  if (error) throw error;
  return data as { booked: number; bookings_created: number; errors: string[] };
}

// Send schedule notification emails to booked players
export async function sendScheduleNotifications(cycleId: string): Promise<{ sent: number; errors: string[] }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Authentication required');

  const { data, error } = await supabase.functions.invoke('send-schedule-notifications', {
    body: { cycle_id: cycleId },
    headers: { Authorization: `Bearer ${session.access_token}` },
  });

  if (error) throw error;
  return data as { sent: number; errors: string[] };
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
  // 1. Update cycle record
  const { data: cycle, error: fetchErr } = await supabase
    .from('cycles')
    .select('settings')
    .eq('id', cycleId)
    .single();

  if (fetchErr) throw fetchErr;

  const settings = (cycle?.settings as CycleSettings) || {};
  const updatedSettings: CycleSettings = {
    ...settings,
    extra_costs: pricing.extra_costs,
    split_payment: pricing.split_payment,
    prices_include_vat: pricing.prices_include_vat,
  };

  const { error: cycleErr } = await supabase
    .from('cycles')
    .update({
      price_per_session: pricing.price_per_session,
      settings: updatedSettings as unknown as Json,
    })
    .eq('id', cycleId);

  if (cycleErr) throw cycleErr;

  // 2. Bulk-update all slots linked to this cycle
  const { error: slotsErr } = await supabase
    .from('availability_slots')
    .update({
      price_per_session: pricing.price_per_session,
      extra_costs: pricing.extra_costs.length > 0 ? (pricing.extra_costs as unknown as Json) : null,
      split_payment: pricing.split_payment,
      prices_include_vat: pricing.prices_include_vat,
    })
    .eq('cyclus_id', cycleId);

  if (slotsErr) throw slotsErr;
}
