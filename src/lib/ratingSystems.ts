import { supabase } from "@/lib/supabaseClient";
import { logger } from '@/lib/logger';

export interface RatingSystemConfig {
  id: string;
  code: string;
  name: string;
  country: string;
  min_rating: number;
  max_rating: number;
  step: number;
  lower_is_better: boolean;
  member_id_label: string | null;
  member_id_placeholder: string | null;
  is_active: boolean;
  display_order: number;
}

// Cache for rating systems to avoid repeated database calls
let cachedSystems: RatingSystemConfig[] | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function getRatingSystems(): Promise<RatingSystemConfig[]> {
  // Return cached data if still valid
  if (cachedSystems && Date.now() - cacheTimestamp < CACHE_TTL) {
    return cachedSystems;
  }

  const { data, error } = await supabase
    .from("rating_systems")
    .select("*")
    .eq("is_active", true)
    .order("display_order", { ascending: true });

  if (error) {
    logger.error("Error fetching rating systems", error as Error, { component: 'ratingSystems' });
    return getDefaultSystems();
  }

  cachedSystems = data as RatingSystemConfig[];
  cacheTimestamp = Date.now();
  return cachedSystems;
}

export async function getRatingSystemByCode(code: string): Promise<RatingSystemConfig | null> {
  const systems = await getRatingSystems();
  return systems.find(s => s.code === code) || null;
}

export async function getRatingSystemsForCountry(country: string): Promise<RatingSystemConfig[]> {
  const systems = await getRatingSystems();
  
  // Get systems for the specific country and international systems
  const localSystems = systems.filter(s => s.country === country);
  const internationalSystems = systems.filter(s => s.country === 'INT');
  
  // Return local systems first, then international
  return [...localSystems, ...internationalSystems];
}

export async function getRatingSystemsGroupedByCountry(): Promise<Record<string, RatingSystemConfig[]>> {
  const systems = await getRatingSystems();
  
  return systems.reduce((acc, system) => {
    const country = system.country;
    if (!acc[country]) {
      acc[country] = [];
    }
    acc[country].push(system);
    return acc;
  }, {} as Record<string, RatingSystemConfig[]>);
}

// Fallback defaults if database is unavailable
function getDefaultSystems(): RatingSystemConfig[] {
  return [
    {
      id: 'default-knltb',
      code: 'knltb',
      name: 'KNLTB',
      country: 'NL',
      min_rating: 0.1,
      max_rating: 9.9,
      step: 0.1,
      lower_is_better: true,
      member_id_label: 'KNLTB Number',
      member_id_placeholder: '12345678',
      is_active: true,
      display_order: 1,
    },
    {
      id: 'default-playtomic',
      code: 'playtomic',
      name: 'Playtomic',
      country: 'INT',
      min_rating: 0.1,
      max_rating: 6.0,
      step: 0.1,
      lower_is_better: false,
      member_id_label: null,
      member_id_placeholder: null,
      is_active: true,
      display_order: 10,
    },
  ];
}

export function clearRatingSystemsCache(): void {
  cachedSystems = null;
  cacheTimestamp = 0;
}

export function validateRating(rating: number | null | undefined, system: RatingSystemConfig): boolean {
  if (rating === null || rating === undefined) return true;
  return rating >= system.min_rating && rating <= system.max_rating;
}

export function formatRatingWithSystem(rating: number | null | undefined, systemName: string): string {
  if (rating === null || rating === undefined) return '—';
  // KNLTB uses 4 decimal places, others use 1
  const decimals = systemName.toUpperCase() === 'KNLTB' ? 4 : 1;
  return `${rating.toFixed(decimals)} (${systemName})`;
}

// Country code to display name mapping
export const COUNTRY_NAMES: Record<string, string> = {
  'NL': 'Netherlands',
  'BE': 'Belgium',
  'ES': 'Spain',
  'GB': 'United Kingdom',
  'DE': 'Germany',
  'FR': 'France',
  'IT': 'Italy',
  'INT': 'International',
};
