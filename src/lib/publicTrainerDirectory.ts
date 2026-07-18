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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A non-negative finite number, or `fallback` for anything else (NaN, Infinity,
 *  negative, non-numeric). This is a public SEO page fed straight from the URL —
 *  garbage query params must degrade to "no filter", never an RPC error. */
function safeNonNegative(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** One bounded page of directory cards + the total across the full filtered set.
 *  URL-derived params are sanitized here (the RPC boundary) so a malformed deep
 *  link degrades to "no filter" instead of surfacing a Postgres cast error. */
export async function searchPublicTrainers(
  params: PublicTrainerSearchParams,
  client: Pick<typeof supabase, 'rpc'> = supabase,
): Promise<PublicTrainerSearchResult> {
  const locationId = params.locationId && params.locationId !== 'all' && UUID_RE.test(params.locationId)
    ? params.locationId
    : null;
  const { data, error } = await client.rpc('search_public_trainers', {
    p_search: params.search?.trim() || null,
    p_location_id: locationId,
    p_min_rating: safeNonNegative(params.minRating, 0),
    p_min_experience: safeNonNegative(params.minExperience, 0),
    p_specializations: params.specializations?.length ? params.specializations : null,
    p_certifications: params.certifications?.length ? params.certifications : null,
    p_verified: params.verified ?? false,
    p_rating_system: params.ratingSystem || null,
    p_min_trainer_rating: safeNonNegative(params.minTrainerRating, 0),
    p_has_availability: params.hasAvailability ?? false,
    p_sort: params.sort === 'experience' ? 'experience' : 'rating',
    p_page: Math.max(1, Math.trunc(safeNonNegative(params.page, 1))),
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
