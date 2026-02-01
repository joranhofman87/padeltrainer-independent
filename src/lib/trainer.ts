import { supabase } from '@/integrations/supabase/client';

export interface TrainerClub {
  clubId: string;
  clubName: string;
  locationSlug: string;
}

/**
 * Get clubs where the trainer is a club_trainer (relationship_type = 'club_trainer')
 */
export async function getTrainerClubs(trainerProfileId: string): Promise<TrainerClub[]> {
  const { data, error } = await supabase
    .from('trainer_locations')
    .select(`
      location_id,
      location:locations(
        id,
        name,
        slug
      )
    `)
    .eq('trainer_id', trainerProfileId)
    .eq('relationship_type', 'club_trainer');

  if (error) {
    console.error('Error fetching trainer clubs:', error);
    return [];
  }

  if (!data || data.length === 0) {
    return [];
  }

  // Get club profiles for these locations
  const locationIds = data.map((d: any) => d.location_id);
  
  const { data: clubProfiles, error: clubError } = await supabase
    .from('club_profiles')
    .select('id, location_id, location:locations(name, slug)')
    .in('location_id', locationIds);

  if (clubError) {
    console.error('Error fetching club profiles:', clubError);
    return [];
  }

  return (clubProfiles || []).map((club: any) => ({
    clubId: club.id,
    clubName: club.location?.name || 'Unknown Club',
    locationSlug: club.location?.slug || '',
  }));
}
