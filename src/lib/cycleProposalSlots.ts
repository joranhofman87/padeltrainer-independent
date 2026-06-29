// Proposal-grid slot operations (move/edit/delete slots, assign/unassign players, swap, finalize,
// notify) — extracted from lib/cycles.ts (god-file split). One-way: these are called only by UI,
// never by other cycles.ts functions, and use no cycles.ts internals — so cycles.ts re-exports via
// `export *` and importers are unchanged.
import { supabase } from '@/lib/supabaseClient';
import { applySlotDeleteToCycle } from '@/lib/slotDeleteGuard';

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

  // 4. Delete the slot itself — but NEVER if it still has an active booking (bookings.slot_id is
  //    ON DELETE CASCADE, so the delete would silently remove the booking).
  // Atomic delete via the canonical RPC. Only block when a booking actually PROTECTED the slot —
  // an already-deleted/nonexistent slot returns 0 deleted + 0 protected and stays a benign no-op.
  const res = await applySlotDeleteToCycle(null, [slotId]);
  if (res.protectedCount > 0) {
    throw new Error('Cannot delete a session that still has an active booking.');
  }
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

// exportIntakeRequestsToCsv lives in ./intakeCsv (lib domain-split); re-exported for unchanged importers.
export { exportIntakeRequestsToCsv } from './intakeCsv';

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
