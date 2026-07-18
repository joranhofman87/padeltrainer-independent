// @vitest-environment node
// Public trainer directory RPCs (migration 20260909100000): bounded, public-safe
// server-side search + facets. The harness builds faithful minimal
// trainer_profiles_safe / profiles_public views (the real is_active_subscription
// expression — own sub/trial OR active-academy coverage — is replicated so the
// entitlement paths are actually exercised) and loads the REAL migration.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

type Row = Record<string, unknown>;
const search = async (params: Record<string, unknown> = {}): Promise<Row[]> => {
  const p = {
    p_search: null, p_location_id: null, p_min_rating: 0, p_min_experience: 0,
    p_specializations: null, p_certifications: null, p_verified: false,
    p_rating_system: null, p_min_trainer_rating: 0, p_has_availability: false,
    p_sort: 'rating', p_page: 1, p_page_size: 48, ...params,
  };
  const { rows } = await db.query<Row>(
    `SELECT * FROM public.search_public_trainers($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [p.p_search, p.p_location_id, p.p_min_rating, p.p_min_experience, p.p_specializations,
     p.p_certifications, p.p_verified, p.p_rating_system, p.p_min_trainer_rating,
     p.p_has_availability, p.p_sort, p.p_page, p.p_page_size],
  );
  return rows;
};

// Insert an entitled public trainer with a profile. Overrides via opts.
let seq = 0;
const addTrainer = async (opts: Partial<{
  id: string; is_public: boolean; subscription_status: string; trial_ends_at: string | null;
  full_name: string; bio: string; location: string; specializations: string[]; certifications: string[];
  experience_years: number; is_verified: boolean; skill_rating: number | null; rating_system: string | null;
}> = {}): Promise<string> => {
  seq += 1;
  const id = opts.id ?? `a0000000-0000-0000-0000-${String(seq).padStart(12, '0')}`;
  const userId = `b0000000-0000-0000-0000-${String(seq).padStart(12, '0')}`;
  await db.query(
    `INSERT INTO public.trainer_profiles
       (id, user_id, slug, experience_years, certifications, specializations, is_verified, is_public, subscription_status, trial_ends_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, userId, 'slug-' + seq, opts.experience_years ?? 0, opts.certifications ?? [], opts.specializations ?? [],
     opts.is_verified ?? false, opts.is_public ?? true, opts.subscription_status ?? 'active', opts.trial_ends_at ?? null]);
  await db.query(
    `INSERT INTO public.profiles (id, user_id, full_name, avatar_url, bio, location, skill_rating, rating_system)
     VALUES (gen_random_uuid(),$1,$2,'https://x/a.png',$3,$4,$5,$6)`,
    [userId, opts.full_name ?? ('Trainer ' + seq), opts.bio ?? '', opts.location ?? 'City', opts.skill_rating ?? null, opts.rating_system ?? null]);
  return id;
};
const addReview = (trainerId: string, rating: number, isPublic: boolean) =>
  db.query(`INSERT INTO public.reviews (id, trainer_id, rating, is_public) VALUES (gen_random_uuid(),$1,$2,$3)`, [trainerId, rating, isPublic]);
const addSlot = (trainerId: string, startTime: string, isPublic: boolean) =>
  db.query(`INSERT INTO public.availability_slots (id, trainer_id, start_time, is_public) VALUES (gen_random_uuid(),$1,$2,$3)`, [trainerId, startTime, isPublic]);
const reset = () => db.exec(`
  TRUNCATE public.trainer_profiles, public.profiles, public.reviews, public.availability_slots,
           public.trainer_locations, public.academy_trainers, public.academy_profiles CASCADE;`);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE public.trainer_profiles (
      id uuid PRIMARY KEY, user_id uuid, slug text, experience_years int, coaching_since_year int,
      certifications text[], specializations text[], is_verified boolean, is_public boolean,
      subscription_status text, trial_ends_at timestamptz);
    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY, subscription_status text, trial_ends_at timestamptz);
    CREATE TABLE public.academy_trainers (trainer_profile_id uuid, academy_profile_id uuid, status text);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid UNIQUE, full_name text, avatar_url text,
      bio text, location text, skill_rating numeric, rating_system text);
    CREATE TABLE public.reviews (id uuid PRIMARY KEY, trainer_id uuid, rating int, is_public boolean);
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, trainer_id uuid, start_time timestamptz, is_public boolean);
    CREATE TABLE public.trainer_locations (trainer_id uuid, location_id uuid);
    CREATE TABLE public.locations (id uuid PRIMARY KEY, name text, city text, country text, slug text);
    CREATE TABLE public.rating_systems (code text PRIMARY KEY, lower_is_better boolean);
    INSERT INTO public.rating_systems (code, lower_is_better) VALUES ('knltb', true), ('lta', false);

    -- Faithful minimal views (is_active_subscription copied from the real view).
    CREATE VIEW public.trainer_profiles_safe AS
      SELECT id, user_id, slug,
        CASE WHEN coaching_since_year IS NOT NULL THEN (EXTRACT(year FROM CURRENT_DATE))::int - coaching_since_year
             ELSE experience_years END AS experience_years,
        certifications, specializations, is_verified, is_public,
        (subscription_status = 'active'
          OR (trial_ends_at IS NOT NULL AND trial_ends_at > now())
          OR EXISTS (SELECT 1 FROM public.academy_trainers atr
                     JOIN public.academy_profiles ap ON ap.id = atr.academy_profile_id
                     WHERE atr.trainer_profile_id = tp.id AND atr.status = 'active'
                       AND (ap.subscription_status = 'active' OR (ap.trial_ends_at IS NOT NULL AND ap.trial_ends_at > now())))
        ) AS is_active_subscription
      FROM public.trainer_profiles tp;
    CREATE VIEW public.profiles_public AS
      SELECT p.user_id, p.full_name, p.avatar_url, p.bio, p.location, p.skill_rating, p.rating_system
      FROM public.profiles p
      WHERE EXISTS (SELECT 1 FROM public.trainer_profiles tp WHERE tp.user_id = p.user_id AND tp.is_public = true);
  `);
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260909100000_public_trainer_directory.sql'), 'utf8'));
});

beforeEach(async () => { await reset(); seq = 0; });

describe('search_public_trainers — pagination + cap', () => {
  it('clamps page_size to 100 even when 500 is requested', async () => {
    for (let i = 0; i < 105; i++) await addTrainer({ experience_years: i });
    const rows = await search({ p_page_size: 500 });
    expect(rows.length).toBe(100);
    expect(Number(rows[0].total_count)).toBe(105);
  });

  it('pages deterministically and without overlap', async () => {
    for (let i = 0; i < 105; i++) await addTrainer({ experience_years: i });
    const p1a = await search({ p_page: 1, p_page_size: 50 });
    const p1b = await search({ p_page: 1, p_page_size: 50 });
    const p2 = await search({ p_page: 2, p_page_size: 50 });
    const ids1 = p1a.map((r) => r.trainer_profile_id);
    expect(p1b.map((r) => r.trainer_profile_id)).toEqual(ids1); // deterministic
    const overlap = ids1.filter((id) => p2.map((r) => r.trainer_profile_id).includes(id));
    expect(overlap).toHaveLength(0); // non-overlapping
    expect(Number(p1a[0].total_count)).toBe(105);
  });

  it('never returns sensitive fields', async () => {
    await addTrainer({});
    const rows = await search({});
    const keys = Object.keys(rows[0]).sort();
    expect(keys).toEqual([
      'average_rating', 'avatar_url', 'bio', 'certifications', 'experience_years', 'full_name',
      'has_availability', 'is_verified', 'location', 'review_count', 'slug', 'specializations',
      'total_count', 'trainer_profile_id',
    ].sort());
    // explicit: no identity/subscription leakage
    for (const forbidden of ['user_id', 'email', 'phone', 'subscription_status', 'trial_ends_at', 'skill_rating']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe('search_public_trainers — entitlement + privacy', () => {
  it('shows a public+active trainer; hides public but non-entitled', async () => {
    const active = await addTrainer({ full_name: 'Active', subscription_status: 'active' });
    await addTrainer({ full_name: 'Lapsed', subscription_status: 'inactive', trial_ends_at: null });
    const rows = await search({});
    const names = rows.map((r) => r.full_name);
    expect(names).toContain('Active');
    expect(names).not.toContain('Lapsed');
    expect(rows.map((r) => r.trainer_profile_id)).toContain(active);
  });

  it('shows a trainer covered by an ACTIVE academy even without own subscription', async () => {
    const id = await addTrainer({ full_name: 'AcademyCovered', subscription_status: 'inactive' });
    await db.query(`INSERT INTO public.academy_profiles (id, subscription_status) VALUES ($1,'active')`, ['c0000000-0000-0000-0000-000000000001']);
    await db.query(`INSERT INTO public.academy_trainers (trainer_profile_id, academy_profile_id, status) VALUES ($1,$2,'active')`, [id, 'c0000000-0000-0000-0000-000000000001']);
    const rows = await search({});
    expect(rows.map((r) => r.full_name)).toContain('AcademyCovered');
  });

  it('never shows a private (is_public=false) trainer', async () => {
    await addTrainer({ full_name: 'Private', is_public: false, subscription_status: 'active' });
    const rows = await search({});
    expect(rows.map((r) => r.full_name)).not.toContain('Private');
  });
});

describe('search_public_trainers — filters', () => {
  const future = new Date(Date.now() + 864e5).toISOString();
  const past = new Date(Date.now() - 864e5).toISOString();

  it('search matches name / bio / specialization, only among entitled+public', async () => {
    await addTrainer({ full_name: 'Ada Padel', bio: 'coach' });
    await addTrainer({ full_name: 'Bob', bio: 'padel wizard' });
    await addTrainer({ full_name: 'Cy', specializations: ['padel-technique'] });
    await addTrainer({ full_name: 'Zoe', bio: 'tennis only' });
    await addTrainer({ full_name: 'PadelHidden', bio: 'padel', is_public: false }); // private, must not match
    const rows = await search({ p_search: 'padel' });
    const names = rows.map((r) => r.full_name).sort();
    expect(names).toEqual(['Ada Padel', 'Bob', 'Cy']);
  });

  it('location filter returns only trainers at that location', async () => {
    const a = await addTrainer({ full_name: 'AtClub' });
    await addTrainer({ full_name: 'Elsewhere' });
    await db.query(`INSERT INTO public.locations (id, name, city, country, slug) VALUES ($1,'Club','Town','NL','club')`, ['d0000000-0000-0000-0000-000000000001']);
    await db.query(`INSERT INTO public.trainer_locations (trainer_id, location_id) VALUES ($1,$2)`, [a, 'd0000000-0000-0000-0000-000000000001']);
    const rows = await search({ p_location_id: 'd0000000-0000-0000-0000-000000000001' });
    expect(rows.map((r) => r.full_name)).toEqual(['AtClub']);
  });

  it('min review rating uses PUBLIC reviews only', async () => {
    const hi = await addTrainer({ full_name: 'HiPublic' });
    const priv = await addTrainer({ full_name: 'HiPrivateOnly' });
    await addReview(hi, 5, true); await addReview(hi, 5, true);
    await addReview(priv, 5, false); await addReview(priv, 5, false); // private 5s
    await addReview(priv, 2, true); // its only PUBLIC review is a 2
    const rows = await search({ p_min_rating: 4 });
    const names = rows.map((r) => r.full_name);
    expect(names).toContain('HiPublic');
    expect(names).not.toContain('HiPrivateOnly'); // public avg is 2, below 4
  });

  // Codex P3: the OLD client rounded to 1 decimal before filtering/sorting/
  // displaying (Math.round(avg*10)/10). A raw (unrounded) average changes
  // behavior at the boundary — pin the exact case Codex described: a true
  // average of 4.45 rounds to 4.5 and must clear a minRating=4.5 filter, the
  // same way the pre-migration client did.
  it('average_rating is ROUNDED to 1 decimal, matching the old client (boundary case)', async () => {
    const boundary = await addTrainer({ full_name: 'Boundary' });
    for (let i = 0; i < 11; i++) await addReview(boundary, 4, true);
    for (let i = 0; i < 9; i++) await addReview(boundary, 5, true); // raw avg = 89/20 = 4.45
    const unfiltered = await search({});
    expect(Number(unfiltered.find((r) => r.full_name === 'Boundary')!.average_rating)).toBe(4.5);
    const rows = await search({ p_min_rating: 4.5 });
    expect(rows.map((r) => r.full_name)).toContain('Boundary');
  });

  it('hasAvailability counts only FUTURE public slots', async () => {
    const ok = await addTrainer({ full_name: 'FutureSlot' });
    const pastOnly = await addTrainer({ full_name: 'PastSlot' });
    const privSlot = await addTrainer({ full_name: 'PrivateSlot' });
    await addSlot(ok, future, true);
    await addSlot(pastOnly, past, true);
    await addSlot(privSlot, future, false);
    const rows = await search({ p_has_availability: true });
    expect(rows.map((r) => r.full_name)).toEqual(['FutureSlot']);
    // and has_availability flag is correct on an unfiltered fetch
    const all = await search({});
    const flags = Object.fromEntries(all.map((r) => [r.full_name, r.has_availability]));
    expect(flags['FutureSlot']).toBe(true);
    expect(flags['PastSlot']).toBe(false);
    expect(flags['PrivateSlot']).toBe(false);
  });

  it('lower_is_better rating system (KNLTB): min trainer rating is an UPPER bound', async () => {
    await addTrainer({ full_name: 'Strong', rating_system: 'knltb', skill_rating: 3 });   // lower = stronger
    await addTrainer({ full_name: 'Weak', rating_system: 'knltb', skill_rating: 8 });
    // ask for players at least this strong → skill_rating <= 5
    const rows = await search({ p_rating_system: 'knltb', p_min_trainer_rating: 5 });
    expect(rows.map((r) => r.full_name)).toEqual(['Strong']);
  });
});

describe('get_public_trainer_directory_facets', () => {
  it('returns distinct locations/specializations/certifications across entitled+public trainers', async () => {
    const a = await addTrainer({ specializations: ['tech', 'fitness'], certifications: ['knltb'] });
    await addTrainer({ specializations: ['tech'], certifications: ['lta'] });
    await addTrainer({ full_name: 'Hidden', specializations: ['secret'], is_public: false }); // excluded
    await db.query(`INSERT INTO public.locations (id, name, city, country, slug) VALUES ($1,'Club','Town','NL','club')`, ['d0000000-0000-0000-0000-000000000009']);
    await db.query(`INSERT INTO public.trainer_locations (trainer_id, location_id) VALUES ($1,$2)`, [a, 'd0000000-0000-0000-0000-000000000009']);
    const { rows } = await db.query<{ f: { locations: unknown[]; specializations: string[]; certifications: string[] } }>(
      `SELECT public.get_public_trainer_directory_facets() AS f`);
    const f = rows[0].f;
    expect(f.specializations.sort()).toEqual(['fitness', 'tech']); // 'secret' excluded (private)
    expect(f.certifications.sort()).toEqual(['knltb', 'lta']);
    expect(f.locations).toHaveLength(1);
    expect((f.locations[0] as { slug: string }).slug).toBe('club');
  });
});
