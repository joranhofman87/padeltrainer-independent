// @vitest-environment node
// Reviews integrity hardening (migration 20260914100000). Pins the INSERT RLS + FK:
// a player review must be tied to a REAL completed/confirmed booking of that player with
// that trainer; admins may insert manual reviews with booking_id = NULL; the FK rejects a
// non-null fake booking_id; one review per real booking, unlimited NULLs. Exercises the
// REAL policies by SET ROLE authenticated with a mockable auth.uid().
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;
const MIG = (n: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', n), 'utf8');

const U_PLAYER = 'e0000000-0000-0000-0000-0000000000e1';
const PL = 'b0000000-0000-0000-0000-0000000000b1';       // player's profile
const U_ADMIN = 'e0000000-0000-0000-0000-0000000000e2';
const ADM = 'b0000000-0000-0000-0000-0000000000b2';      // admin's profile
const U_OTHER = 'e0000000-0000-0000-0000-0000000000e3'; // a different, non-admin user
const OTHER = 'b0000000-0000-0000-0000-0000000000b3';    // their profile
const TP = 'c0000000-0000-0000-0000-0000000000a1';       // trainer being reviewed
const TP2 = 'c0000000-0000-0000-0000-0000000000a2';      // a DIFFERENT trainer
const S1 = 'f0000000-0000-0000-0000-00000000001a';       // slot of TP
const B1 = 'a1000000-0000-0000-0000-0000000000b1';       // PL completed booking with TP
const BP = 'a1000000-0000-0000-0000-0000000000bf';       // PL PENDING booking with TP
const FAKE = 'a1000000-0000-0000-0000-00000000dead';     // no such booking

// Attempt an insert as `uid` under RLS. Resolves on success, rejects with the pg error on
// denial. Everything runs in ONE db.exec: SET ROLE + a warm-up read (a pglite quirk mis-
// resolves the policy's table access on the first RLS-gated statement after SET ROLE; a
// warm-up in the same message fixes it — real Postgres/prod is unaffected) + the INSERT.
const insertReviewAs = async (uid: string, over: Record<string, string> = {}) => {
  const cols: Record<string, string> = {
    booking_id: `'${B1}'`, player_id: `'${PL}'`, trainer_id: `'${TP}'`, rating: '5', ...over,
  };
  const stmt = `INSERT INTO public.reviews (${Object.keys(cols).join(', ')}) VALUES (${Object.values(cols).join(', ')})`;
  try {
    await db.exec(`SET ROLE authenticated; SET test.uid = '${uid}';
      SELECT id FROM public.profiles WHERE user_id = auth.uid(); SELECT count(*) FROM public.bookings;
      ${stmt};`);
  } finally {
    await db.exec(`RESET ROLE; RESET test.uid;`);
  }
};
const reviewCount = async () => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.reviews`)).rows[0].n;
// seed a valid review as superuser (bypasses RLS) to exercise the UPDATE policy against
const seedReview = async (over: Record<string, string> = {}) => {
  const cols: Record<string, string> = { id: `gen_random_uuid()`, booking_id: `'${B1}'`, player_id: `'${PL}'`, trainer_id: `'${TP}'`, rating: '5', ...over };
  return (await db.query<{ id: string }>(
    `INSERT INTO public.reviews (${Object.keys(cols).join(', ')}) VALUES (${Object.values(cols).join(', ')}) RETURNING id`)).rows[0].id;
};
const updateReviewAs = async (uid: string, id: string, setClause: string) => {
  try {
    await db.exec(`SET ROLE authenticated; SET test.uid = '${uid}';
      SELECT id FROM public.profiles WHERE user_id = auth.uid(); SELECT count(*) FROM public.bookings;
      UPDATE public.reviews SET ${setClause} WHERE id = '${id}';`);
  } finally {
    await db.exec(`RESET ROLE; RESET test.uid;`);
  }
};
// call the (auth-bound, DEFINER) helper as a given user
const canReviewAs = async (uid: string, bookingId: string, playerId: string, trainerId: string) => {
  await db.exec(`SET ROLE authenticated; SET test.uid = '${uid}';`);
  try {
    return (await db.query<{ ok: boolean }>(
      `SELECT public.is_reviewable_booking('${bookingId}','${playerId}','${trainerId}') AS ok`)).rows[0].ok;
  } finally {
    await db.exec(`RESET ROLE; RESET test.uid;`);
  }
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    -- auth.uid() reads a per-test GUC
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid $fn$;
    GRANT USAGE ON SCHEMA auth TO authenticated, anon;  -- Supabase grants this in prod
    -- admin detection stand-in
    CREATE TABLE public._test_admins (user_id uuid PRIMARY KEY);
    -- SECURITY DEFINER (like prod's is_admin) so the authenticated caller doesn't need
    -- privileges on the admin table when the policy evaluates is_admin(auth.uid()).
    CREATE OR REPLACE FUNCTION public.is_admin(_user_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
      SELECT EXISTS (SELECT 1 FROM public._test_admins WHERE user_id = _user_id) $fn$;
    -- referenced tables (no RLS on these stand-ins; the policy subqueries just read them)
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, trainer_id uuid NOT NULL REFERENCES public.trainer_profiles(id));
    CREATE TABLE public.bookings (id uuid PRIMARY KEY, slot_id uuid NOT NULL REFERENCES public.availability_slots(id),
      player_id uuid NOT NULL, status text NOT NULL DEFAULT 'pending');
    -- reviews in its PRE-hardening shape (the migration transforms it)
    CREATE TABLE public.reviews (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid NOT NULL,
      player_id uuid NOT NULL, trainer_id uuid NOT NULL,
      rating int NOT NULL CHECK (rating BETWEEN 1 AND 5), comment text,
      is_public boolean NOT NULL DEFAULT true, is_anonymous boolean NOT NULL DEFAULT false,
      reviewer_name text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT reviews_booking_id_key UNIQUE (booking_id));
    ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "Players can create reviews for their bookings" ON public.reviews FOR INSERT TO public
      WITH CHECK (player_id IN (SELECT id FROM public.profiles WHERE user_id = auth.uid()));
    CREATE POLICY "Admins can create reviews" ON public.reviews FOR INSERT TO public
      WITH CHECK (public.is_admin(auth.uid()));
    -- SELECT policy so an UPDATE can find its row (prod's "Anyone can view public reviews")
    CREATE POLICY "Anyone can view public reviews" ON public.reviews FOR SELECT TO public USING (is_public);
    GRANT SELECT ON public.profiles, public.bookings, public.availability_slots TO authenticated;
    GRANT SELECT, INSERT, UPDATE ON public.reviews TO authenticated;
  `);
  await db.exec(MIG('20260914100000_reviews_booking_integrity.sql'));
  await db.exec(`
    INSERT INTO auth.users (id) VALUES ('${U_PLAYER}'), ('${U_ADMIN}'), ('${U_OTHER}');
    INSERT INTO public._test_admins (user_id) VALUES ('${U_ADMIN}');
    INSERT INTO public.profiles (id, user_id) VALUES ('${PL}','${U_PLAYER}'), ('${ADM}','${U_ADMIN}'), ('${OTHER}','${U_OTHER}');
    INSERT INTO public.trainer_profiles (id, user_id) VALUES ('${TP}', gen_random_uuid()), ('${TP2}', gen_random_uuid());
    INSERT INTO public.availability_slots (id, trainer_id) VALUES ('${S1}','${TP}');
    INSERT INTO public.bookings (id, slot_id, player_id, status) VALUES
      ('${B1}','${S1}','${PL}','completed'), ('${BP}','${S1}','${PL}','pending');
  `);
});

beforeEach(async () => { await db.exec(`DELETE FROM public.reviews;`); });

describe('player INSERT RLS — must match a real completed/confirmed booking of that player+trainer', () => {
  it('ALLOWS a review of the player\'s own completed booking with the reviewed trainer', async () => {
    await insertReviewAs(U_PLAYER, { booking_id: `'${B1}'` });
    expect(await reviewCount()).toBe(1);
  });

  it('REJECTS a random / non-existent booking_id', async () => {
    await expect(insertReviewAs(U_PLAYER, { booking_id: `'${FAKE}'` })).rejects.toThrow(/row-level security|violates/i);
  });

  it('REJECTS a real booking with a FORGED trainer_id (booking is with a different trainer)', async () => {
    await expect(insertReviewAs(U_PLAYER, { booking_id: `'${B1}'`, trainer_id: `'${TP2}'` })).rejects.toThrow(/row-level security|violates/i);
  });

  it('REJECTS a review of a PENDING (not completed/confirmed) booking', async () => {
    await expect(insertReviewAs(U_PLAYER, { booking_id: `'${BP}'` })).rejects.toThrow(/row-level security|violates/i);
  });

  it('REJECTS a player review with a NULL booking_id (players must have a booking)', async () => {
    await expect(insertReviewAs(U_PLAYER, { booking_id: `NULL` })).rejects.toThrow(/row-level security|violates/i);
  });
});

describe('admin INSERT + FK/unique constraints', () => {
  it('ALLOWS an admin manual review with booking_id NULL', async () => {
    await insertReviewAs(U_ADMIN, { booking_id: `NULL`, player_id: `'${ADM}'` });
    expect(await reviewCount()).toBe(1);
  });

  it('allows MULTIPLE admin NULL-booking reviews (NULLs are distinct)', async () => {
    await insertReviewAs(U_ADMIN, { booking_id: `NULL`, player_id: `'${ADM}'` });
    await insertReviewAs(U_ADMIN, { booking_id: `NULL`, player_id: `'${ADM}'` });
    expect(await reviewCount()).toBe(2);
  });

  it('FK rejects a NON-NULL fake booking_id even from an admin', async () => {
    await expect(insertReviewAs(U_ADMIN, { booking_id: `'${FAKE}'`, player_id: `'${ADM}'` }))
      .rejects.toThrow(/foreign key|violates/i);
  });

  it('unique: two reviews for the SAME real booking are rejected', async () => {
    await insertReviewAs(U_PLAYER, { booking_id: `'${B1}'` });
    await expect(insertReviewAs(U_ADMIN, { booking_id: `'${B1}'`, player_id: `'${ADM}'` }))
      .rejects.toThrow(/duplicate key|unique|violates/i);
  });
});

describe('player UPDATE RLS — same booking-link rule (closes the insert-then-update bypass)', () => {
  it('ALLOWS editing rating/comment on a valid own review (booking + trainer unchanged)', async () => {
    const id = await seedReview();
    await updateReviewAs(U_PLAYER, id, `rating = 3, comment = 'edited'`);
    const r = (await db.query<{ rating: number }>(`SELECT rating FROM public.reviews WHERE id='${id}'`)).rows[0];
    expect(r.rating).toBe(3);
  });

  it('REJECTS updating booking_id to NULL', async () => {
    const id = await seedReview();
    await expect(updateReviewAs(U_PLAYER, id, `booking_id = NULL`)).rejects.toThrow(/row-level security|violates/i);
  });

  it('REJECTS updating trainer_id to another trainer', async () => {
    const id = await seedReview();
    await expect(updateReviewAs(U_PLAYER, id, `trainer_id = '${TP2}'`)).rejects.toThrow(/row-level security|violates/i);
  });

  it('REJECTS updating booking_id to a PENDING booking', async () => {
    const id = await seedReview();
    await expect(updateReviewAs(U_PLAYER, id, `booking_id = '${BP}'`)).rejects.toThrow(/row-level security|violates/i);
  });
});

describe('is_reviewable_booking is auth-bound + locked down (not an oracle)', () => {
  it('anon CANNOT execute the helper; authenticated + service_role can', async () => {
    const priv = async (role: string) => (await db.query<{ ok: boolean }>(
      `SELECT has_function_privilege($1, p.oid, 'EXECUTE') AS ok
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='is_reviewable_booking'`, [role])).rows[0].ok;
    expect(await priv('anon')).toBe(false);
    expect(await priv('authenticated')).toBe(true);
    expect(await priv('service_role')).toBe(true);
  });

  it('returns TRUE for the caller\'s OWN completed booking', async () => {
    expect(await canReviewAs(U_PLAYER, B1, PL, TP)).toBe(true);
  });

  it('returns FALSE when a caller asserts ANOTHER player\'s booking triple (oracle blocked)', async () => {
    // U_OTHER neither owns PL nor is admin → cannot probe PL's real booking, even though (B1,PL,TP) is real
    expect(await canReviewAs(U_OTHER, B1, PL, TP)).toBe(false);
  });
});
