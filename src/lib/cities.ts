import { supabase } from '@/lib/supabaseClient';

export interface CityWithTrainerCount {
  city: string;
  slug: string;
  trainerCount: number;
  locationCount: number;
}

// Get all cities that have at least one location with trainers
export async function getCitiesWithTrainers(): Promise<CityWithTrainerCount[]> {
  // Get all active locations
  const { data: locations, error: locError } = await supabase
    .from('locations')
    .select('id, city')
    .eq('is_active', true);

  if (locError) {
    console.error('Error fetching locations:', locError);
    return [];
  }

  // Get trainer counts per location
  const { data: trainerLinks, error: tlError } = await supabase
    .from('trainer_locations')
    .select('location_id');

  if (tlError) {
    console.error('Error fetching trainer locations:', tlError);
    return [];
  }

  // Count trainers per location
  const locationTrainerCounts: Record<string, number> = {};
  trainerLinks?.forEach(link => {
    locationTrainerCounts[link.location_id] = (locationTrainerCounts[link.location_id] || 0) + 1;
  });

  // Aggregate by city
  const cityData: Record<string, { trainerCount: number; locationCount: number }> = {};
  
  locations?.forEach(loc => {
    if (!cityData[loc.city]) {
      cityData[loc.city] = { trainerCount: 0, locationCount: 0 };
    }
    cityData[loc.city].locationCount += 1;
    cityData[loc.city].trainerCount += locationTrainerCounts[loc.id] || 0;
  });

  // Convert to array and create slugs
  const result: CityWithTrainerCount[] = Object.entries(cityData)
    .map(([city, data]) => ({
      city,
      slug: city.toLowerCase().replace(/\s+/g, '-'),
      trainerCount: data.trainerCount,
      locationCount: data.locationCount,
    }))
    .sort((a, b) => b.trainerCount - a.trainerCount);

  return result;
}

// Get popular cities (those with the most trainers)
export async function getPopularCities(limit: number = 10): Promise<CityWithTrainerCount[]> {
  const cities = await getCitiesWithTrainers();
  return cities.slice(0, limit);
}

// Get all unique city slugs for sitemap
export async function getAllCitySlugs(): Promise<string[]> {
  const { data, error } = await supabase
    .from('locations')
    .select('city')
    .eq('is_active', true);

  if (error) {
    console.error('Error fetching cities:', error);
    return [];
  }

  const uniqueCities = [...new Set(data?.map(l => l.city) || [])];
  return uniqueCities.map(city => city.toLowerCase().replace(/\s+/g, '-'));
}
