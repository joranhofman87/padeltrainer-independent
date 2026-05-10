/**
 * DB facts for render-page bot HTML.
 *
 * Pulls minimal aggregates per entity (city, trainer, club, academy, province)
 * so crawlers + LLMs see real numbers, top-N entities, and freshness signals.
 *
 * In-memory isolate cache (5 min TTL) layered under the edge cache (1h).
 * All queries use the service role key (read-only here).
 */

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── In-memory cache (per Deno isolate) ─────────────────────────
const TTL_MS = 5 * 60 * 1000;
// deno-lint-ignore no-explicit-any
const cache = new Map<string, { v: any; e: number }>();

// deno-lint-ignore no-explicit-any
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.e > Date.now()) return hit.v as T;
  try {
    const v = await fn();
    cache.set(key, { v, e: Date.now() + ttlMs });
    return v;
  } catch (err) {
    console.error('[db-facts]', key, err);
    if (hit) return hit.v as T; // soft-stale on error
    throw err;
  }
}

// ─── Types ──────────────────────────────────────────────────────
export interface CityFacts {
  trainerCount: number;
  locationCount: number;
  minRate: number | null;
  maxRate: number | null;
  avgRate: number | null;
  topTrainers: Array<{ slug: string; name: string; rate: number | null }>;
  topClubs: Array<{ slug: string; name: string; courts: number | null; googleRating: number | null }>;
  lastUpdated: string | null;
}

export interface TrainerFacts {
  name: string;
  hourlyRate: number | null;
  experienceYears: number | null;
  specializations: string[];
  certifications: string[];
  city: string | null;
  bio: string | null;
  reviewCount: number;
  avgRating: number | null;
  recentReviews: Array<{ rating: number; comment: string | null; reviewer: string | null }>;
  primaryClub: { name: string; slug: string; city: string } | null;
  lastUpdated: string | null;
}

export interface ClubFacts {
  name: string;
  city: string;
  street: string | null;
  postalCode: string | null;
  country: string | null;
  indoorCourts: number | null;
  outdoorCourts: number | null;
  totalCourts: number | null;
  latitude: number | null;
  longitude: number | null;
  googleRating: number | null;
  googleReviewCount: number | null;
  reviewStats: { avg: number | null; count: number };
  trainersAtClub: Array<{ slug: string; name: string }>;
  lastUpdated: string | null;
}

export interface AcademyFacts {
  name: string;
  description: string | null;
  country: string | null;
  trainerCount: number;
  activeCycleCount: number;
  websiteUrl: string | null;
  social: { instagram: string | null; facebook: string | null; linkedin: string | null };
  upcomingCycles: Array<{ name: string; startDate: string | null; endDate: string | null; price: number | null; currency: string | null }>;
  lastUpdated: string | null;
}

export interface ProvinceFacts {
  name: string;
  country: string;
  cityCount: number;
  trainerCount: number;
  locationCount: number;
  topCities: Array<{ slug: string; name: string; count: number }>;
}

// ─── City ───────────────────────────────────────────────────────
export async function fetchCityFacts(citySlug: string): Promise<CityFacts | null> {
  return cached(`city:${citySlug}`, TTL_MS, async () => {
    const cityName = slugToCityName(citySlug);

    // Locations in this city (case-insensitive — covers "Amsterdam" + "AMSTERDAM")
    const { data: locs } = await supabase
      .from('locations')
      .select('id, slug, name, city, indoor_courts, outdoor_courts, number_of_courts, google_rating, google_review_count, updated_at')
      .ilike('city', cityName)
      .eq('is_active', true)
      .limit(1000);

    const locations = locs || [];
    const locationIds = locations.map(l => l.id);

    // Trainers via trainer_locations join (reliable: city is canonical via locations)
    let trainerProfileIds: string[] = [];
    if (locationIds.length > 0) {
      const { data: tloc } = await supabase
        .from('trainer_locations')
        .select('trainer_id')
        .in('location_id', locationIds)
        .limit(2000);
      trainerProfileIds = Array.from(new Set((tloc || []).map(t => t.trainer_id)));
    }

    // Fallback / supplement: profiles.location ILIKE city (covers trainers with no club link)
    const { data: tprof } = await supabase
      .from('profiles')
      .select('user_id, full_name, location, updated_at')
      .ilike('location', cityName)
      .limit(500);

    const fallbackUserIds = (tprof || []).map(p => p.user_id);

    // Resolve trainer_profiles for both sets
    let trainers: Array<{ slug: string; name: string; rate: number | null; updated_at: string }> = [];
    if (trainerProfileIds.length > 0 || fallbackUserIds.length > 0) {
      const { data: tpsByIds } = trainerProfileIds.length > 0
        ? await supabase
            .from('trainer_profiles')
            .select('id, user_id, slug, hourly_rate, updated_at')
            .in('id', trainerProfileIds)
            .eq('is_public', true)
        : { data: [] as Array<{ id: string; user_id: string; slug: string | null; hourly_rate: number | null; updated_at: string }> };

      const { data: tpsByUsers } = fallbackUserIds.length > 0
        ? await supabase
            .from('trainer_profiles')
            .select('id, user_id, slug, hourly_rate, updated_at')
            .in('user_id', fallbackUserIds)
            .eq('is_public', true)
        : { data: [] as Array<{ id: string; user_id: string; slug: string | null; hourly_rate: number | null; updated_at: string }> };

      const allTps = [...(tpsByIds || []), ...(tpsByUsers || [])];
      const dedup = new Map(allTps.map(t => [t.id, t]));

      // Fetch profile names in one batch
      const userIds = Array.from(new Set([...dedup.values()].map(t => t.user_id)));
      const { data: profs } = userIds.length > 0
        ? await supabase.from('profiles').select('user_id, full_name').in('user_id', userIds)
        : { data: [] as Array<{ user_id: string; full_name: string | null }> };
      const nameByUser = new Map((profs || []).map(p => [p.user_id, p.full_name]));

      trainers = [...dedup.values()].map(t => ({
        slug: t.slug || t.user_id,
        name: nameByUser.get(t.user_id) || 'Trainer',
        rate: t.hourly_rate ? Number(t.hourly_rate) : null,
        updated_at: t.updated_at,
      }));
    }

    if (trainers.length === 0 && locations.length === 0) {
      return {
        trainerCount: 0, locationCount: 0,
        minRate: null, maxRate: null, avgRate: null,
        topTrainers: [], topClubs: [], lastUpdated: null,
      };
    }

    const rates = trainers.map(t => t.rate).filter((r): r is number => r != null && r > 0);
    const minRate = rates.length ? Math.min(...rates) : null;
    const maxRate = rates.length ? Math.max(...rates) : null;
    const avgRate = rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length) : null;

    // Top trainers: prefer those with rates, sort by rate desc as a proxy
    const topTrainers = [...trainers]
      .sort((a, b) => (b.rate || 0) - (a.rate || 0))
      .slice(0, 5)
      .map(t => ({ slug: t.slug, name: t.name, rate: t.rate }));

    const topClubs = locations
      .map(l => ({
        slug: l.slug,
        name: l.name,
        courts: l.number_of_courts || ((l.indoor_courts || 0) + (l.outdoor_courts || 0)) || null,
        googleRating: l.google_rating ? Number(l.google_rating) : null,
      }))
      .sort((a, b) => (b.googleRating || 0) - (a.googleRating || 0))
      .slice(0, 5);

    const allDates = [
      ...trainers.map(t => t.updated_at),
      ...locations.map(l => l.updated_at),
    ].filter(Boolean) as string[];
    const lastUpdated = allDates.length ? allDates.sort().reverse()[0] : null;

    return {
      trainerCount: trainers.length,
      locationCount: locations.length,
      minRate, maxRate, avgRate,
      topTrainers, topClubs, lastUpdated,
    };
  });
}

// ─── Trainer ────────────────────────────────────────────────────
export async function fetchTrainerFacts(slug: string): Promise<TrainerFacts | null> {
  return cached(`trainer:${slug}`, TTL_MS, async () => {
    const { data: tp } = await supabase
      .from('trainer_profiles')
      .select('id, user_id, slug, hourly_rate, experience_years, specializations, certifications, is_public, updated_at')
      .eq('slug', slug)
      .maybeSingle();

    if (!tp) return null;

    const { data: prof } = await supabase
      .from('profiles')
      .select('full_name, location, bio')
      .eq('user_id', tp.user_id)
      .maybeSingle();

    // Reviews
    const { data: revs } = await supabase
      .from('reviews')
      .select('rating, comment, reviewer_name, is_anonymous')
      .eq('trainer_id', tp.id)
      .eq('is_public', true)
      .order('created_at', { ascending: false })
      .limit(20);

    const reviews = revs || [];
    const reviewCount = reviews.length;
    const avgRating = reviewCount
      ? Math.round((reviews.reduce((a, r) => a + (r.rating || 0), 0) / reviewCount) * 10) / 10
      : null;
    const recentReviews = reviews.slice(0, 5).map(r => ({
      rating: r.rating || 0,
      comment: r.comment || null,
      reviewer: r.is_anonymous ? null : (r.reviewer_name || null),
    }));

    // Primary club
    const { data: tloc } = await supabase
      .from('trainer_locations')
      .select('location_id, is_primary')
      .eq('trainer_id', tp.id)
      .order('is_primary', { ascending: false })
      .limit(1);

    let primaryClub: TrainerFacts['primaryClub'] = null;
    if (tloc && tloc.length > 0) {
      const { data: loc } = await supabase
        .from('locations')
        .select('name, slug, city')
        .eq('id', tloc[0].location_id)
        .maybeSingle();
      if (loc) primaryClub = { name: loc.name, slug: loc.slug, city: loc.city };
    }

    return {
      name: prof?.full_name || slugToDisplay(slug),
      hourlyRate: tp.hourly_rate ? Number(tp.hourly_rate) : null,
      experienceYears: tp.experience_years || null,
      specializations: (tp.specializations || []) as string[],
      certifications: (tp.certifications || []) as string[],
      city: prof?.location || null,
      bio: prof?.bio || null,
      reviewCount, avgRating, recentReviews,
      primaryClub,
      lastUpdated: tp.updated_at,
    };
  });
}

// ─── Club / Location ────────────────────────────────────────────
export async function fetchClubFacts(slug: string): Promise<ClubFacts | null> {
  return cached(`club:${slug}`, TTL_MS, async () => {
    const { data: loc } = await supabase
      .from('locations')
      .select('id, name, city, street_address, postal_code, country, indoor_courts, outdoor_courts, number_of_courts, latitude, longitude, google_rating, google_review_count, updated_at')
      .eq('slug', slug)
      .maybeSingle();

    if (!loc) return null;

    // Court reviews aggregate
    const { data: stats } = await supabase
      .rpc('get_location_review_stats', { _location_id: loc.id });
    const reviewStats = {
      avg: stats?.avg_overall ? Number(stats.avg_overall) : null,
      count: stats?.total_count || 0,
    };

    // Trainers at this club
    const { data: tloc } = await supabase
      .from('trainer_locations')
      .select('trainer_id')
      .eq('location_id', loc.id)
      .eq('show_on_club_page', true)
      .limit(20);

    let trainersAtClub: Array<{ slug: string; name: string }> = [];
    if (tloc && tloc.length > 0) {
      const trainerIds = tloc.map(t => t.trainer_id);
      const { data: tps } = await supabase
        .from('trainer_profiles')
        .select('user_id, slug')
        .in('id', trainerIds)
        .eq('is_public', true);
      if (tps && tps.length > 0) {
        const userIds = tps.map(t => t.user_id);
        const { data: profs } = await supabase
          .from('profiles')
          .select('user_id, full_name')
          .in('user_id', userIds);
        const nameByUser = new Map((profs || []).map(p => [p.user_id, p.full_name]));
        trainersAtClub = tps.map(t => ({
          slug: t.slug || t.user_id,
          name: nameByUser.get(t.user_id) || 'Trainer',
        }));
      }
    }

    return {
      name: loc.name,
      city: loc.city,
      street: loc.street_address,
      postalCode: loc.postal_code,
      country: loc.country,
      indoorCourts: loc.indoor_courts,
      outdoorCourts: loc.outdoor_courts,
      totalCourts: loc.number_of_courts || ((loc.indoor_courts || 0) + (loc.outdoor_courts || 0)) || null,
      latitude: loc.latitude ? Number(loc.latitude) : null,
      longitude: loc.longitude ? Number(loc.longitude) : null,
      googleRating: loc.google_rating ? Number(loc.google_rating) : null,
      googleReviewCount: loc.google_review_count,
      reviewStats,
      trainersAtClub,
      lastUpdated: loc.updated_at,
    };
  });
}

// ─── Academy ────────────────────────────────────────────────────
export async function fetchAcademyFacts(slug: string): Promise<AcademyFacts | null> {
  return cached(`academy:${slug}`, TTL_MS, async () => {
    const { data: ap } = await supabase
      .from('academy_profiles')
      .select('id, name, description, country, website_url, social_instagram, social_facebook, social_linkedin, updated_at, is_public')
      .eq('slug', slug)
      .maybeSingle();

    if (!ap) return null;

    // Trainers
    const { count: trainerCount } = await supabase
      .from('academy_trainers')
      .select('*', { count: 'exact', head: true })
      .eq('academy_profile_id', ap.id)
      .eq('status', 'active');

    // Cycles
    const { data: cycles } = await supabase
      .from('cycles')
      .select('name, start_date, end_date, price_per_session, total_price, currency, status')
      .eq('owner_type', 'academy')
      .eq('owner_id', ap.id)
      .order('start_date', { ascending: true })
      .limit(5);

    const upcomingCycles = (cycles || []).map(c => ({
      name: c.name,
      startDate: c.start_date,
      endDate: c.end_date,
      price: c.total_price ? Number(c.total_price) : (c.price_per_session ? Number(c.price_per_session) : null),
      currency: c.currency || 'EUR',
    }));

    return {
      name: ap.name,
      description: ap.description,
      country: ap.country,
      trainerCount: trainerCount || 0,
      activeCycleCount: upcomingCycles.length,
      websiteUrl: ap.website_url,
      social: {
        instagram: ap.social_instagram,
        facebook: ap.social_facebook,
        linkedin: ap.social_linkedin,
      },
      upcomingCycles,
      lastUpdated: ap.updated_at,
    };
  });
}

// ─── Province ───────────────────────────────────────────────────
export async function fetchProvinceFacts(provinceSlug: string): Promise<ProvinceFacts | null> {
  return cached(`province:${provinceSlug}`, TTL_MS, async () => {
    const province = PROVINCES.find(p => p.slug === provinceSlug);
    if (!province) return null;

    // Per-city trainer + location counts
    const cityCounts = await Promise.all(
      province.cities.slice(0, 12).map(async (citySlug) => {
        const facts = await fetchCityFacts(citySlug);
        return {
          slug: citySlug,
          name: slugToCityName(citySlug),
          count: (facts?.trainerCount || 0) + (facts?.locationCount || 0),
        };
      })
    );

    const trainerCount = cityCounts.reduce((a, c) => a + c.count, 0);

    return {
      name: province.name,
      country: province.country,
      cityCount: province.cities.length,
      trainerCount,
      locationCount: 0,
      topCities: cityCounts.sort((a, b) => b.count - a.count).slice(0, 8),
    };
  });
}

// ─── Helpers ────────────────────────────────────────────────────
export function slugToDisplay(slug: string): string {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export function slugToCityName(slug: string): string {
  // Heuristic — matches DB-stored city names when no explicit map exists.
  return slugToDisplay(slug);
}

// ─── Province data (mirror of src/lib/provinces.ts, kept in-sync manually) ─
export interface Province {
  slug: string;
  name: string;
  country: string;
  cities: string[];
}

export const PROVINCES: Province[] = [
  { slug: 'noord-holland', name: 'Noord-Holland', country: 'NL', cities: ['amsterdam', 'haarlem', 'alkmaar', 'zaandam', 'hilversum', 'amstelveen', 'hoofddorp'] },
  { slug: 'zuid-holland', name: 'Zuid-Holland', country: 'NL', cities: ['rotterdam', 'den-haag', 'leiden', 'dordrecht', 'zoetermeer', 'delft', 'gouda'] },
  { slug: 'noord-brabant', name: 'Noord-Brabant', country: 'NL', cities: ['eindhoven', 'tilburg', 'breda', 'den-bosch', 'helmond', 'oss', 'roosendaal'] },
  { slug: 'utrecht', name: 'Utrecht', country: 'NL', cities: ['utrecht', 'amersfoort', 'veenendaal', 'nieuwegein', 'zeist', 'houten'] },
  { slug: 'gelderland', name: 'Gelderland', country: 'NL', cities: ['arnhem', 'nijmegen', 'apeldoorn', 'ede', 'doetinchem', 'harderwijk'] },
  { slug: 'overijssel', name: 'Overijssel', country: 'NL', cities: ['zwolle', 'enschede', 'deventer', 'hengelo', 'almelo'] },
  { slug: 'limburg', name: 'Limburg', country: 'NL', cities: ['maastricht', 'venlo', 'heerlen', 'sittard', 'roermond'] },
  { slug: 'friesland', name: 'Friesland', country: 'NL', cities: ['leeuwarden', 'drachten', 'heerenveen', 'sneek'] },
  { slug: 'groningen', name: 'Groningen', country: 'NL', cities: ['groningen', 'veendam', 'stadskanaal'] },
  { slug: 'drenthe', name: 'Drenthe', country: 'NL', cities: ['assen', 'emmen', 'hoogeveen', 'meppel'] },
  { slug: 'flevoland', name: 'Flevoland', country: 'NL', cities: ['almere', 'lelystad', 'dronten'] },
  { slug: 'zeeland', name: 'Zeeland', country: 'NL', cities: ['middelburg', 'vlissingen', 'goes'] },
  { slug: 'antwerpen', name: 'Antwerpen', country: 'BE', cities: ['antwerpen', 'mechelen', 'turnhout', 'lier'] },
  { slug: 'vlaams-brabant', name: 'Vlaams-Brabant', country: 'BE', cities: ['leuven', 'vilvoorde', 'halle', 'tienen'] },
  { slug: 'oost-vlaanderen', name: 'Oost-Vlaanderen', country: 'BE', cities: ['gent', 'aalst', 'sint-niklaas'] },
  { slug: 'west-vlaanderen', name: 'West-Vlaanderen', country: 'BE', cities: ['brugge', 'kortrijk', 'oostende', 'roeselare'] },
  { slug: 'cataluna', name: 'Cataluña', country: 'ES', cities: ['barcelona', 'tarragona', 'girona', 'sabadell', 'terrassa'] },
  { slug: 'comunidad-de-madrid', name: 'Comunidad de Madrid', country: 'ES', cities: ['madrid', 'alcobendas', 'las-rozas', 'pozuelo-de-alarcon', 'getafe'] },
  { slug: 'comunidad-valenciana', name: 'Comunidad Valenciana', country: 'ES', cities: ['valencia', 'alicante', 'elche', 'castellon', 'benidorm'] },
  { slug: 'andalucia', name: 'Andalucía', country: 'ES', cities: ['sevilla', 'malaga', 'granada', 'cordoba', 'marbella'] },
  { slug: 'nordrhein-westfalen', name: 'Nordrhein-Westfalen', country: 'DE', cities: ['koln', 'dusseldorf', 'dortmund', 'essen', 'duisburg', 'bonn'] },
  { slug: 'bayern', name: 'Bayern', country: 'DE', cities: ['munchen', 'nurnberg', 'augsburg', 'regensburg'] },
  { slug: 'baden-wurttemberg', name: 'Baden-Württemberg', country: 'DE', cities: ['stuttgart', 'karlsruhe', 'mannheim', 'freiburg', 'heidelberg'] },
  { slug: 'ile-de-france', name: 'Île-de-France', country: 'FR', cities: ['paris', 'boulogne-billancourt', 'saint-denis', 'versailles'] },
  { slug: 'provence-alpes-cote-d-azur', name: "Provence-Alpes-Côte d'Azur", country: 'FR', cities: ['marseille', 'nice', 'toulon', 'aix-en-provence', 'cannes'] },
  { slug: 'auvergne-rhone-alpes', name: 'Auvergne-Rhône-Alpes', country: 'FR', cities: ['lyon', 'grenoble', 'saint-etienne', 'annecy'] },
  { slug: 'occitanie', name: 'Occitanie', country: 'FR', cities: ['toulouse', 'montpellier', 'nimes', 'perpignan'] },
  { slug: 'nouvelle-aquitaine', name: 'Nouvelle-Aquitaine', country: 'FR', cities: ['bordeaux', 'pau', 'bayonne', 'biarritz'] },
];

export function getProvinceForCity(citySlug: string): Province | undefined {
  return PROVINCES.find(p => p.cities.includes(citySlug));
}

export function getNearbyCities(citySlug: string, limit = 5): Province['cities'] {
  const p = getProvinceForCity(citySlug);
  if (!p) return [];
  return p.cities.filter(c => c !== citySlug).slice(0, limit);
}

export function getProvinceBySlug(slug: string): Province | undefined {
  return PROVINCES.find(p => p.slug === slug);
}
