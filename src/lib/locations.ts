import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';

// Re-export Location type for convenience

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
  indoor_courts: number | null;
  outdoor_courts: number | null;
  description: string | null;
  logo_url: string | null;
  latitude: number | null;
  longitude: number | null;
  phone: string | null;
  email: string | null;
  facebook_url: string | null;
  instagram_url: string | null;
  google_maps_url: string | null;
  google_rating: number | null;
  google_review_count: number | null;
  opening_hours: string | null;
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

// Lightweight location summary for listing pages (homepage, featured sections)
export interface LocationSummary {
  id: string;
  name: string;
  slug: string;
  city: string;
  country: string;
  logo_url: string | null;
  indoor_courts: number | null;
  outdoor_courts: number | null;
}

export async function getActiveLocationsSummary(): Promise<LocationSummary[]> {
  const { data, error } = await supabase
    .from('locations')
    .select('id, name, slug, city, country, logo_url, indoor_courts, outdoor_courts')
    .eq('is_active', true)
    .order('city', { ascending: true })
    .order('name', { ascending: true });

  if (error) {
    logger.error('Error fetching location summaries', undefined, { error });
    throw error;
  }

  return data || [];
}

// Fetch all active locations (full data) - handles >1000 rows
export async function getActiveLocations(): Promise<Location[]> {
  const allLocations: Location[] = [];
  const pageSize = 1000;
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from('locations')
      .select('*')
      .eq('is_active', true)
      .order('city', { ascending: true })
      .order('name', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      logger.error('Error fetching locations', undefined, { error });
      throw error;
    }

    if (data) {
      allLocations.push(...data);
      hasMore = data.length === pageSize;
      from += pageSize;
    } else {
      hasMore = false;
    }
  }

  return allLocations;
}

// Fetch all locations (for admin) - handles >1000 rows
export async function getAllLocations(): Promise<Location[]> {
  const allLocations: Location[] = [];
  const pageSize = 1000;
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from('locations')
      .select('*')
      .order('city', { ascending: true })
      .order('name', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      logger.error('Error fetching all locations', undefined, { error });
      throw error;
    }

    if (data) {
      allLocations.push(...data);
      hasMore = data.length === pageSize;
      from += pageSize;
    } else {
      hasMore = false;
    }
  }

  return allLocations;
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
    logger.error('Error fetching location', undefined, { error });
    throw error;
  }

  return data;
}

// Fetch trainers at a location (for public display - only shows trainers marked as visible)
export async function getTrainersAtLocation(locationId: string) {
  const { data, error } = await supabase
    .from('trainer_locations')
    .select(`
      id,
      is_primary,
      trainer_id,
      show_on_club_page,
      trainer_profiles!inner (
        id,
        user_id,
        slug,
        hourly_rate,
        experience_years,
        specializations,
        certifications,
        is_verified,
        knltb_rating
      )
    `)
    .eq('location_id', locationId)
    .or('show_on_club_page.eq.true,relationship_type.eq.academy_trainer');

  if (error) {
    logger.error('Error fetching trainers at location', undefined, { error });
    throw error;
  }

  // Filter out trainers who will have no name (we need to check profiles_public)
  // The actual name filtering happens when we join with profiles_public in LocationDetail
  return data || [];
}

// Fetch trainer's locations by user ID
export async function getTrainerLocations(userId: string): Promise<(TrainerLocation & { location: Location })[]> {
  // First, get the trainer profile ID from the user ID
  const { data: trainerProfile, error: profileError } = await supabase
    .from('trainer_profiles')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (profileError || !trainerProfile) {
    logger.error('Error fetching trainer profile for locations', undefined, { error: profileError });
    return [];
  }

  const { data, error } = await supabase
    .from('trainer_locations')
    .select(`
      *,
      location:locations(*)
    `)
    .eq('trainer_id', trainerProfile.id);

  if (error) {
    logger.error('Error fetching trainer locations', undefined, { error });
    throw error;
  }

  // Cast relationship_type to our typed enum - handle both 'club' and 'club_trainer' values
  return (data || []).map(item => ({
    ...item,
    relationship_type: (item.relationship_type === 'club' ? 'club_trainer' : (item.relationship_type || 'independent')) as TrainerRelationshipType,
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
    logger.error('Error fetching player locations', undefined, { error });
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
  userId: string,
  locationData: TrainerLocationData[]
): Promise<void> {
  // First, get the trainer profile ID from the user ID
  const { data: trainerProfile, error: profileError } = await supabase
    .from('trainer_profiles')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (profileError || !trainerProfile) {
    logger.error('Error fetching trainer profile', undefined, { error: profileError });
    throw new Error('Trainer profile not found');
  }

  const trainerId = trainerProfile.id;

  // Delete existing locations
  const { error: deleteError } = await supabase
    .from('trainer_locations')
    .delete()
    .eq('trainer_id', trainerId);

  if (deleteError) {
    logger.error('Error deleting trainer locations', undefined, { error: deleteError });
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
      logger.error('Error inserting trainer locations', undefined, { error: insertError });
      throw insertError;
    }
  }
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
    logger.error('Error deleting player locations', undefined, { error: deleteError });
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
      logger.error('Error inserting player locations', undefined, { error: insertError });
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
    logger.error('Error creating location', undefined, { error });
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
    logger.error('Error updating location', undefined, { error });
    throw error;
  }

  return data;
}

// Lightweight location type for paginated listing (only fields needed by LocationCard)
export type LocationListItem = Pick<Location, 'id' | 'name' | 'slug' | 'city' | 'country' | 'street_address' | 'postal_code' | 'indoor_courts' | 'outdoor_courts' | 'logo_url' | 'latitude' | 'longitude'>;

const LOCATION_LIST_COLUMNS = 'id, name, slug, city, country, street_address, postal_code, indoor_courts, outdoor_courts, logo_url, latitude, longitude';

export interface SearchLocationsParams {
  search?: string;
  country?: string;
  city?: string;
  trainersAvailable?: boolean;
  indoorOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export interface SearchLocationsResult {
  data: LocationListItem[];
  totalCount: number;
}

// Server-side paginated search for locations page
export async function searchLocationsPage(params: SearchLocationsParams): Promise<SearchLocationsResult> {
  const { search, country, city, trainersAvailable, indoorOnly, page = 1, pageSize = 48 } = params;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  // If trainersAvailable filter is on, first get location IDs that have trainers
  let trainerLocationIds: string[] | null = null;
  if (trainersAvailable) {
    const { data: trainerLocs } = await supabase
      .from('trainer_locations')
      .select('location_id');
    trainerLocationIds = [...new Set(trainerLocs?.map(tl => tl.location_id) || [])];
    if (trainerLocationIds.length === 0) {
      return { data: [], totalCount: 0 };
    }
  }

  let query = supabase
    .from('locations')
    .select(LOCATION_LIST_COLUMNS, { count: 'exact' })
    .eq('is_active', true);

  // Apply filters
  if (country && country !== 'all') {
    query = query.eq('country', country);
  }
  if (city && city !== 'all') {
    query = query.eq('city', city);
  }
  if (indoorOnly) {
    query = query.gt('indoor_courts', 0);
  }
  if (search && search.length >= 2) {
    const pattern = `%${search}%`;
    query = query.or(`name.ilike.${pattern},city.ilike.${pattern},street_address.ilike.${pattern}`);
  }
  if (trainerLocationIds) {
    query = query.in('id', trainerLocationIds);
  }

  query = query
    .order('city', { ascending: true })
    .order('name', { ascending: true })
    .range(from, to);

  const { data, error, count } = await query;

  if (error) {
    logger.error('Error searching locations page', undefined, { error });
    throw error;
  }

  return {
    data: (data || []) as LocationListItem[],
    totalCount: count || 0,
  };
}

// Fetch ALL matching locations (no pagination) for map view
export async function searchLocationsAll(params: Omit<SearchLocationsParams, 'page' | 'pageSize'>): Promise<LocationListItem[]> {
  const { search, country, city, trainersAvailable, indoorOnly } = params;

  // If trainersAvailable filter is on, first get location IDs that have trainers
  let trainerLocationIds: string[] | null = null;
  if (trainersAvailable) {
    const { data: trainerLocs } = await supabase
      .from('trainer_locations')
      .select('location_id');
    trainerLocationIds = [...new Set(trainerLocs?.map(tl => tl.location_id) || [])];
    if (trainerLocationIds.length === 0) {
      return [];
    }
  }

  const allResults: LocationListItem[] = [];
  const batchSize = 1000;
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    let query = supabase
      .from('locations')
      .select(LOCATION_LIST_COLUMNS)
      .eq('is_active', true);

    if (country && country !== 'all') {
      query = query.eq('country', country);
    }
    if (city && city !== 'all') {
      query = query.eq('city', city);
    }
    if (indoorOnly) {
      query = query.gt('indoor_courts', 0);
    }
    if (search && search.length >= 2) {
      const pattern = `%${search}%`;
      query = query.or(`name.ilike.${pattern},city.ilike.${pattern},street_address.ilike.${pattern}`);
    }
    if (trainerLocationIds) {
      query = query.in('id', trainerLocationIds);
    }

    query = query
      .order('city', { ascending: true })
      .order('name', { ascending: true })
      .range(from, from + batchSize - 1);

    const { data, error } = await query;

    if (error) {
      logger.error('Error fetching all locations for map', undefined, { error });
      throw error;
    }

    const batch = (data || []) as LocationListItem[];
    allResults.push(...batch);

    if (batch.length < batchSize) {
      hasMore = false;
    } else {
      from += batchSize;
    }
  }

  return allResults;
}

// Search locations by name or city (server-side search for large datasets)
export async function searchLocations(query: string, limit: number = 100): Promise<Location[]> {
  if (!query || query.length < 2) {
    // Return first N locations when no search query
    const { data, error } = await supabase
      .from('locations')
      .select('*')
      .eq('is_active', true)
      .order('city', { ascending: true })
      .order('name', { ascending: true })
      .limit(limit);

    if (error) {
      logger.error('Error fetching initial locations', undefined, { error });
      throw error;
    }

    return data || [];
  }

  const searchPattern = `%${query}%`;
  
  const { data, error } = await supabase
    .from('locations')
    .select('*')
    .eq('is_active', true)
    .or(`name.ilike.${searchPattern},city.ilike.${searchPattern}`)
    .order('city', { ascending: true })
    .order('name', { ascending: true })
    .limit(limit);

  if (error) {
    logger.error('Error searching locations', undefined, { error });
    throw error;
  }

  return data || [];
}

// Get unique cities from locations - handles >1000 rows
export async function getUniqueCities(): Promise<string[]> {
  const allCities: string[] = [];
  const pageSize = 1000;
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from('locations')
      .select('city')
      .eq('is_active', true)
      .order('city')
      .range(from, from + pageSize - 1);

    if (error) {
      logger.error('Error fetching cities', undefined, { error });
      throw error;
    }

    if (data) {
      allCities.push(...data.map(l => l.city));
      hasMore = data.length === pageSize;
      from += pageSize;
    } else {
      hasMore = false;
    }
  }

  return [...new Set(allCities)];
}

// Get unique countries from locations - handles >1000 rows
export async function getUniqueCountries(): Promise<string[]> {
  const allCountries: string[] = [];
  const pageSize = 1000;
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from('locations')
      .select('country')
      .eq('is_active', true)
      .order('country')
      .range(from, from + pageSize - 1);

    if (error) {
      logger.error('Error fetching countries', undefined, { error });
      throw error;
    }

    if (data) {
      allCountries.push(...data.map(l => l.country));
      hasMore = data.length === pageSize;
      from += pageSize;
    } else {
      hasMore = false;
    }
  }

  return [...new Set(allCountries)];
}

// Get trainer count per location
export async function getLocationTrainerCounts(): Promise<Record<string, number>> {
  const { data, error } = await supabase
    .from('trainer_locations')
    .select('location_id');

  if (error) {
    logger.error('Error fetching trainer counts', undefined, { error });
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
    logger.error('Error fetching claimed locations', undefined, { error });
    return new Set();
  }

  return new Set(data?.map(cp => cp.location_id) || []);
}

// Public-safe club profile interface (excludes contact details)
export interface ClubProfilePublic {
  id: string;
  location_id: string;
  description: string | null;
  logo_url: string | null;
  banner_url: string | null;
  is_verified: boolean;
  claimed_at: string;
  created_at: string;
  updated_at: string;
  subscription_status: string | null;
  subscription_tier: string | null;
}

// Get club profile by location ID (public-safe version, excludes contact details)
export async function getClubProfileByLocationId(locationId: string): Promise<ClubProfilePublic | null> {
  const { data, error } = await supabase
    .from('club_profiles_public')
    .select('*')
    .eq('location_id', locationId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error('Error fetching club profile', undefined, { error });
    return null;
  }

  return data as ClubProfilePublic;
}
