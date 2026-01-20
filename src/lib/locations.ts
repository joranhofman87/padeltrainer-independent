import { supabase } from '@/integrations/supabase/client';

export interface Location {
  id: string;
  name: string;
  street_address: string | null;
  postal_code: string | null;
  city: string;
  country: string;
  website_url: string | null;
  slug: string;
  is_active: boolean;
  number_of_courts: number | null;
  created_at: string;
  updated_at: string;
}

export type TrainerRelationshipType = 'independent' | 'club_trainer';

export interface TrainerLocation {
  id: string;
  trainer_id: string;
  location_id: string;
  is_primary: boolean;
  relationship_type: TrainerRelationshipType;
  created_at: string;
}

export interface PlayerLocation {
  id: string;
  profile_id: string;
  location_id: string;
  is_preferred: boolean;
  created_at: string;
}

// Fetch all active locations
export async function getActiveLocations(): Promise<Location[]> {
  const { data, error } = await supabase
    .from('locations')
    .select('*')
    .eq('is_active', true)
    .order('city', { ascending: true })
    .order('name', { ascending: true });

  if (error) {
    console.error('Error fetching locations:', error);
    throw error;
  }

  return data || [];
}

// Fetch all locations (for admin)
export async function getAllLocations(): Promise<Location[]> {
  const { data, error } = await supabase
    .from('locations')
    .select('*')
    .order('city', { ascending: true })
    .order('name', { ascending: true });

  if (error) {
    console.error('Error fetching all locations:', error);
    throw error;
  }

  return data || [];
}

// Fetch a single location by slug
export async function getLocationBySlug(slug: string): Promise<Location | null> {
  const { data, error } = await supabase
    .from('locations')
    .select('*')
    .eq('slug', slug)
    .eq('is_active', true)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    console.error('Error fetching location:', error);
    throw error;
  }

  return data;
}

// Fetch trainers at a location
export async function getTrainersAtLocation(locationId: string) {
  const { data, error } = await supabase
    .from('trainer_locations')
    .select(`
      id,
      is_primary,
      trainer_id,
      trainer_profiles!inner (
        id,
        user_id,
        hourly_rate,
        experience_years,
        specializations,
        certifications,
        is_verified,
        knltb_rating
      )
    `)
    .eq('location_id', locationId);

  if (error) {
    console.error('Error fetching trainers at location:', error);
    throw error;
  }

  return data || [];
}

// Fetch trainer's locations
export async function getTrainerLocations(trainerId: string): Promise<(TrainerLocation & { location: Location })[]> {
  const { data, error } = await supabase
    .from('trainer_locations')
    .select(`
      *,
      location:locations(*)
    `)
    .eq('trainer_id', trainerId);

  if (error) {
    console.error('Error fetching trainer locations:', error);
    throw error;
  }

  // Cast relationship_type to our typed enum
  return (data || []).map(item => ({
    ...item,
    relationship_type: (item.relationship_type || 'independent') as TrainerRelationshipType,
  }));
}

// Fetch player's preferred locations
export async function getPlayerLocations(profileId: string): Promise<(PlayerLocation & { location: Location })[]> {
  const { data, error } = await supabase
    .from('player_locations')
    .select(`
      *,
      location:locations(*)
    `)
    .eq('profile_id', profileId);

  if (error) {
    console.error('Error fetching player locations:', error);
    throw error;
  }

  return data || [];
}

export interface TrainerLocationData {
  locationId: string;
  isPrimary: boolean;
  relationshipType: TrainerRelationshipType;
}

// Update trainer locations with relationship types
export async function updateTrainerLocations(
  trainerId: string,
  locationData: TrainerLocationData[]
): Promise<void> {
  // Delete existing locations
  const { error: deleteError } = await supabase
    .from('trainer_locations')
    .delete()
    .eq('trainer_id', trainerId);

  if (deleteError) {
    console.error('Error deleting trainer locations:', deleteError);
    throw deleteError;
  }

  // Insert new locations
  if (locationData.length > 0) {
    const inserts = locationData.map(data => ({
      trainer_id: trainerId,
      location_id: data.locationId,
      is_primary: data.isPrimary,
      relationship_type: data.relationshipType,
    }));

    const { error: insertError } = await supabase
      .from('trainer_locations')
      .insert(inserts);

    if (insertError) {
      console.error('Error inserting trainer locations:', insertError);
      throw insertError;
    }
  }
}

// Legacy function for backward compatibility (uses 'independent' as default)
export async function updateTrainerLocationsSimple(
  trainerId: string,
  locationIds: string[],
  primaryLocationId?: string
): Promise<void> {
  const locationData: TrainerLocationData[] = locationIds.map(locationId => ({
    locationId,
    isPrimary: locationId === primaryLocationId,
    relationshipType: 'independent' as TrainerRelationshipType,
  }));
  return updateTrainerLocations(trainerId, locationData);
}

// Update player locations
export async function updatePlayerLocations(
  profileId: string,
  locationIds: string[],
  preferredLocationId?: string
): Promise<void> {
  // Delete existing locations
  const { error: deleteError } = await supabase
    .from('player_locations')
    .delete()
    .eq('profile_id', profileId);

  if (deleteError) {
    console.error('Error deleting player locations:', deleteError);
    throw deleteError;
  }

  // Insert new locations
  if (locationIds.length > 0) {
    const inserts = locationIds.map(locationId => ({
      profile_id: profileId,
      location_id: locationId,
      is_preferred: locationId === preferredLocationId
    }));

    const { error: insertError } = await supabase
      .from('player_locations')
      .insert(inserts);

    if (insertError) {
      console.error('Error inserting player locations:', insertError);
      throw insertError;
    }
  }
}

// Create a new location (admin only)
export async function createLocation(location: Omit<Location, 'id' | 'created_at' | 'updated_at'>): Promise<Location> {
  const { data, error } = await supabase
    .from('locations')
    .insert(location)
    .select()
    .single();

  if (error) {
    console.error('Error creating location:', error);
    throw error;
  }

  return data;
}

// Update a location (admin only)
export async function updateLocation(id: string, updates: Partial<Location>): Promise<Location> {
  const { data, error } = await supabase
    .from('locations')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error('Error updating location:', error);
    throw error;
  }

  return data;
}

// Get unique cities from locations
export async function getUniqueCities(): Promise<string[]> {
  const { data, error } = await supabase
    .from('locations')
    .select('city')
    .eq('is_active', true)
    .order('city');

  if (error) {
    console.error('Error fetching cities:', error);
    throw error;
  }

  const cities = [...new Set(data?.map(l => l.city) || [])];
  return cities;
}

// Get trainer count per location
export async function getLocationTrainerCounts(): Promise<Record<string, number>> {
  const { data, error } = await supabase
    .from('trainer_locations')
    .select('location_id');

  if (error) {
    console.error('Error fetching trainer counts:', error);
    throw error;
  }

  const counts: Record<string, number> = {};
  data?.forEach(row => {
    counts[row.location_id] = (counts[row.location_id] || 0) + 1;
  });

  return counts;
}

// Get claimed status for multiple locations (batch)
export async function getClaimedLocationIds(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('club_profiles')
    .select('location_id');

  if (error) {
    console.error('Error fetching claimed locations:', error);
    return new Set();
  }

  return new Set(data?.map(cp => cp.location_id) || []);
}

// Get club profile by location ID
export async function getClubProfileByLocationId(locationId: string) {
  const { data, error } = await supabase
    .from('club_profiles')
    .select('*')
    .eq('location_id', locationId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    console.error('Error fetching club profile:', error);
    return null;
  }

  return data;
}
