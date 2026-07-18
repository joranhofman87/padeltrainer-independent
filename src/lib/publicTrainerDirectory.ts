// Client wrapper for the bounded, public-safe trainer directory RPCs
// (migration 20260909100000). One page of cards + total_count from the server —
// no "fetch everything then filter in React". See src/pages/Trainers.tsx.
import { supabase } from '@/lib/supabaseClient';

export interface PublicTrainerCard {
  trainer_profile_id: string;
  slug: string | null;
  full_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  location: string | null;
  experience_years: number | null;
  certifications: string[] | null;
  specializations: string[] | null;
  is_verified: boolean;
  average_rating: number;
  review_count: number;
  has_availability: boolean;
}

export interface PublicTrainerSearchParams {
  search?: string;
  locationId?: string | null; // 'all' or empty → no location filter
  minRating?: number;
  minExperience?: number;
  specializations?: string[];
  certifications?: string[];
  verified?: boolean;
  ratingSystem?: string;
  minTrainerRating?: number;
  hasAvailability?: boolean;
  sort?: 'rating' | 'experience';
  page?: number;
  pageSize?: number;
}

export interface PublicTrainerSearchResult {
  trainers: PublicTrainerCard[];
  totalCount: number;
}

/** One bounded page of directory cards + the total across the full filtered set. */
export async function searchPublicTrainers(
  params: PublicTrainerSearchParams,
  client: Pick<typeof supabase, 'rpc'> = supabase,
): Promise<PublicTrainerSearchResult> {
  const { data, error } = await client.rpc('search_public_trainers', {
    p_search: params.search?.trim() || null,
    p_location_id: params.locationId && params.locationId !== 'all' ? params.locationId : null,
    p_min_rating: params.minRating ?? 0,
    p_min_experience: params.minExperience ?? 0,
    p_specializations: params.specializations?.length ? params.specializations : null,
    p_certifications: params.certifications?.length ? params.certifications : null,
    p_verified: params.verified ?? false,
    p_rating_system: params.ratingSystem || null,
    p_min_trainer_rating: params.minTrainerRating ?? 0,
    p_has_availability: params.hasAvailability ?? false,
    p_sort: params.sort ?? 'rating',
    p_page: params.page ?? 1,
    p_page_size: params.pageSize ?? 48,
  });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<PublicTrainerCard & { total_count: number | string }>;
  return {
    trainers: rows.map(({ total_count: _total, ...card }) => card),
    totalCount: rows.length ? Number(rows[0].total_count) : 0,
  };
}

export interface DirectoryFacetLocation {
  id: string;
  name: string;
  city: string;
  country: string | null;
  slug: string | null;
}
export interface DirectoryFacets {
  locations: DirectoryFacetLocation[];
  specializations: string[];
  certifications: string[];
}

/** Distinct filter options (locations / specializations / certifications) across the
 *  SAME entitled+public set — a single bounded aggregate, never a per-trainer scan. */
export async function getPublicTrainerDirectoryFacets(
  client: Pick<typeof supabase, 'rpc'> = supabase,
): Promise<DirectoryFacets> {
  const { data, error } = await client.rpc('get_public_trainer_directory_facets');
  if (error) throw new Error(error.message);
  const f = (data ?? {}) as Partial<DirectoryFacets>;
  return {
    locations: Array.isArray(f.locations) ? f.locations : [],
    specializations: Array.isArray(f.specializations) ? f.specializations : [],
    certifications: Array.isArray(f.certifications) ? f.certifications : [],
  };
}
