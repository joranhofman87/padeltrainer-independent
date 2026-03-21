import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';

export type OwnerType = 'academy' | 'trainer' | 'location';
export type LessonType = 'private' | 'duo' | 'group' | 'group3' | 'group4' | 'kids';
export type WaitingListStatus = 'active' | 'contacted' | 'archived';

export interface TimeWindow {
  day: string;
  start: string;
  end: string;
}

export interface WaitingListEntry {
  id: string;
  owner_type: OwnerType;
  owner_id: string;
  player_id: string;
  lesson_type: LessonType;
  has_group: boolean;
  group_size: number | null;
  rating: number | null;
  rating_system: string | null;
  preferred_days: string[] | null;
  preferred_time_windows: TimeWindow[] | null;
  notes: string | null;
  status: WaitingListStatus;
  contacted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateWaitingListEntryInput {
  owner_type: OwnerType;
  owner_id: string;
  player_id: string;
  lesson_type: LessonType;
  has_group?: boolean;
  group_size?: number | null;
  rating?: number | null;
  rating_system?: string | null;
  preferred_days?: string[] | null;
  preferred_time_windows?: TimeWindow[] | null;
  notes?: string | null;
}

// Create a new waiting list entry
export async function createWaitingListEntry(
  input: CreateWaitingListEntryInput
): Promise<{ data: WaitingListEntry | null; error: Error | null }> {
  const { data, error } = await supabase
    .from('waiting_list_entries' as any)
    .insert({
      owner_type: input.owner_type,
      owner_id: input.owner_id,
      player_id: input.player_id,
      lesson_type: input.lesson_type,
      has_group: input.has_group ?? false,
      group_size: input.group_size ?? null,
      rating: input.rating ?? null,
      rating_system: input.rating_system ?? 'knltb',
      preferred_days: input.preferred_days ?? null,
      preferred_time_windows: input.preferred_time_windows ?? null,
      notes: input.notes ?? null,
    })
    .select()
    .single();

  return { data: data as unknown as WaitingListEntry | null, error: error as Error | null };
}

// Get all waiting list entries for a player
export async function getPlayerWaitingListEntries(
  playerId: string
): Promise<{ data: WaitingListEntry[] | null; error: Error | null }> {
  const { data, error } = await supabase
    .from('waiting_list_entries' as any)
    .select('*')
    .eq('player_id', playerId)
    .order('created_at', { ascending: false });

  return { data: data as unknown as WaitingListEntry[] | null, error: error as Error | null };
}

// Get waiting list entries for an owner (academy, trainer, or location)
export async function getOwnerWaitingListEntries(
  ownerType: OwnerType,
  ownerId: string,
  status?: WaitingListStatus
): Promise<{ data: WaitingListEntry[] | null; error: Error | null }> {
  let query = supabase
    .from('waiting_list_entries' as any)
    .select('*')
    .eq('owner_type', ownerType)
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false });

  if (status) {
    query = query.eq('status', status);
  }

  const { data, error } = await query;

  return { data: data as unknown as WaitingListEntry[] | null, error: error as Error | null };
}

// Check if a player already has an active entry for an owner
export async function hasActiveEntry(
  playerId: string,
  ownerType: OwnerType,
  ownerId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('waiting_list_entries' as any)
    .select('id')
    .eq('player_id', playerId)
    .eq('owner_type', ownerType)
    .eq('owner_id', ownerId)
    .eq('status', 'active')
    .maybeSingle();

  if (error) {
    logger.error('Error checking active entry', error as Error, { component: 'waitingList' });
    return false;
  }

  return !!data;
}

// Update waiting list entry status
export async function updateWaitingListEntryStatus(
  entryId: string,
  status: WaitingListStatus
): Promise<{ error: Error | null }> {
  const updateData: { status: WaitingListStatus; contacted_at?: string } = { status };
  
  if (status === 'contacted') {
    updateData.contacted_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from('waiting_list_entries' as any)
    .update(updateData)
    .eq('id', entryId);

  return { error: error as Error | null };
}

// Delete a waiting list entry (for players removing themselves)
export async function deleteWaitingListEntry(
  entryId: string
): Promise<{ error: Error | null }> {
  const { error } = await supabase
    .from('waiting_list_entries' as any)
    .delete()
    .eq('id', entryId);

  return { error: error as Error | null };
}

// Get count of active waiting list entries for an owner
export async function getActiveWaitingListCount(
  ownerType: OwnerType,
  ownerId: string
): Promise<number> {
  const { count, error } = await supabase
    .from('waiting_list_entries' as any)
    .select('*', { count: 'exact', head: true })
    .eq('owner_type', ownerType)
    .eq('owner_id', ownerId)
    .eq('status', 'active');

  if (error) {
    logger.error('Error getting waiting list count', error as Error, { component: 'waitingList' });
    return 0;
  }

  return count ?? 0;
}
