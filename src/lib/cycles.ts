import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';

// Types
export interface Cycle {
  id: string;
  owner_type: 'trainer' | 'club';
  owner_id: string;
  name: string;
  description: string | null;
  start_date: string;
  end_date: string;
  enrollment_deadline: string | null;
  settings: CycleSettings;
  status: 'draft' | 'open' | 'closed' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface CycleSettings {
  lesson_types?: ('private' | 'duo' | 'group' | 'kids')[];
  show_preferred_trainer?: boolean;
  default_duration_minutes?: number;
  max_group_size?: number;
  applicable_trainer_ids?: string[];
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
  preferred_trainer_id: string | null;
  location_id: string | null;
  notes: string | null;
  consent_given: boolean;
  status: 'new' | 'proposed' | 'confirmed' | 'rejected' | 'waitlist';
  created_at: string;
  updated_at: string;
}

export interface TimeWindow {
  day?: string;
  preset?: 'morning' | 'afternoon' | 'evening' | 'weekend';
  start?: string;
  end?: string;
  [key: string]: unknown; // Allow for Json compatibility
}

export interface ProposedAssignment {
  id: string;
  intake_request_id: string;
  slot_id: string;
  trainer_id: string;
  confidence_score: number | null;
  rationale: RationaleItem[] | null;
  status: 'proposed' | 'confirmed' | 'rejected' | 'manual_override';
  created_at: string;
  updated_at: string;
}

export interface RationaleItem {
  type: string;
  score: number;
  detail: string;
  [key: string]: unknown; // Allow for Json compatibility
}

export interface IntakeRequestInput {
  cycle_id: string;
  player_id: string;
  full_name: string;
  email: string;
  phone?: string;
  rating?: number;
  rating_system?: string;
  lesson_type: 'private' | 'duo' | 'group' | 'kids';
  preferred_days: string[];
  preferred_time_windows: TimeWindow[];
  preferred_duration_minutes?: number;
  preferred_trainer_id?: string;
  location_id?: string;
  notes?: string;
  consent_given: boolean;
}

export interface CycleInput {
  owner_type: 'trainer' | 'club';
  owner_id: string;
  name: string;
  description?: string;
  start_date: string;
  end_date: string;
  enrollment_deadline?: string;
  settings?: CycleSettings;
  status?: 'draft' | 'open' | 'closed' | 'archived';
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
export async function getCycles(ownerType: 'trainer' | 'club', ownerId: string): Promise<Cycle[]> {
  const { data, error } = await supabase
    .from('cycles')
    .select('*')
    .eq('owner_type', ownerType)
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data || []) as Cycle[];
}

export async function getActiveCycles(ownerType: 'trainer' | 'club', ownerId: string): Promise<Cycle[]> {
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
  return (data || []) as IntakeRequest[];
}

export async function getIntakeRequestsByOwner(
  ownerType: 'trainer' | 'club',
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
  return (data || []) as IntakeRequest[];
}

export async function getPlayerIntakeRequests(playerId: string): Promise<IntakeRequest[]> {
  const { data, error } = await supabase
    .from('intake_requests')
    .select('*')
    .eq('player_id', playerId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data || []) as IntakeRequest[];
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
  return data as IntakeRequest;
}

export async function submitIntakeRequest(input: IntakeRequestInput): Promise<IntakeRequest> {
  const insertData = {
    cycle_id: input.cycle_id,
    player_id: input.player_id,
    full_name: input.full_name,
    email: input.email,
    phone: input.phone || null,
    rating: input.rating || null,
    rating_system: input.rating_system || 'knltb',
    lesson_type: input.lesson_type,
    preferred_days: input.preferred_days,
    preferred_time_windows: input.preferred_time_windows as unknown as Json,
    preferred_duration_minutes: input.preferred_duration_minutes || 60,
    preferred_trainer_id: input.preferred_trainer_id || null,
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
  return toIntakeRequest(data);
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
  return data as IntakeRequest;
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
  return (data || []) as ProposedAssignment[];
}

export async function getProposedAssignmentForRequest(
  requestId: string
): Promise<ProposedAssignment | null> {
  const { data, error } = await supabase
    .from('proposed_assignments')
    .select('*')
    .eq('intake_request_id', requestId)
    .eq('status', 'proposed')
    .maybeSingle();

  if (error) throw error;
  return data as ProposedAssignment | null;
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
  return data as ProposedAssignment;
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
  return data as ProposedAssignment;
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
