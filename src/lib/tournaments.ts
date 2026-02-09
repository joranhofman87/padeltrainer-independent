import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';

export interface ClubTournament {
  id: string;
  club_profile_id: string;
  name: string;
  description: string | null;
  start_date: string;
  end_date: string | null;
  registration_url: string | null;
  image_url: string | null;
  is_published: boolean;
  created_at: string;
  updated_at: string;
}

export type ClubTournamentInsert = Omit<ClubTournament, 'id' | 'created_at' | 'updated_at'>;
export type ClubTournamentUpdate = Partial<ClubTournamentInsert>;

// Get all tournaments for a club (for management)
export async function getClubTournaments(clubProfileId: string): Promise<ClubTournament[]> {
  const { data, error } = await supabase
    .from('club_tournaments')
    .select('*')
    .eq('club_profile_id', clubProfileId)
    .order('start_date', { ascending: true });

  if (error) {
    logger.error('Error fetching club tournaments', error as Error, { component: 'tournaments' });
    return [];
  }

  return data || [];
}

// Get published tournaments for a club (for public display)
export async function getPublishedTournaments(clubProfileId: string): Promise<ClubTournament[]> {
  const { data, error } = await supabase
    .from('club_tournaments')
    .select('*')
    .eq('club_profile_id', clubProfileId)
    .eq('is_published', true)
    .gte('end_date', new Date().toISOString().split('T')[0]) // Only future or ongoing tournaments
    .order('start_date', { ascending: true });

  if (error) {
    logger.error('Error fetching published tournaments', error as Error, { component: 'tournaments' });
    return [];
  }

  return data || [];
}

// Create a tournament
export async function createTournament(
  tournament: ClubTournamentInsert
): Promise<ClubTournament | null> {
  const { data, error } = await supabase
    .from('club_tournaments')
    .insert(tournament)
    .select()
    .single();

  if (error) {
    logger.error('Error creating tournament', error as Error, { component: 'tournaments' });
    return null;
  }

  return data;
}

// Update a tournament
export async function updateTournament(
  id: string,
  updates: ClubTournamentUpdate
): Promise<ClubTournament | null> {
  const { data, error } = await supabase
    .from('club_tournaments')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    logger.error('Error updating tournament', error as Error, { component: 'tournaments' });
    return null;
  }

  return data;
}

// Delete a tournament
export async function deleteTournament(id: string): Promise<boolean> {
  const { error } = await supabase
    .from('club_tournaments')
    .delete()
    .eq('id', id);

  if (error) {
    logger.error('Error deleting tournament', error as Error, { component: 'tournaments' });
    return false;
  }

  return true;
}
