// Proposed-assignment CRUD (read + scheduling writes), extracted from lib/cycles.ts (god-file
// split). One-way: uses only the shared toProposedAssignment mapper + supabase, no other cycles.ts
// internals, and nothing in cycles.ts calls it — so cycles.ts re-exports via `export *`.
import { supabase } from '@/lib/supabaseClient';
import type { Json } from '@/integrations/supabase/types';
import { toProposedAssignment } from './cycleMappers';
import type { ProposedAssignment, EnrichedProposedAssignment, RationaleItem } from './cycleTypes';

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
