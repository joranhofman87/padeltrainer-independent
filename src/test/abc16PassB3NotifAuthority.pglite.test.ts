// @vitest-environment node
//
// Pass B §3 — notification authority and private history, EXECUTED.
//
// The two functions here decide (a) which academies a signed-in account is treated as belonging
// to, and (b) whether one account may read another's message history. Both used to answer from
// evidence the subject did not control: a booking whose subject columns are chosen by the slot
// owner, and the legacy person bridge.
//
// The bodies are lifted verbatim out of the containment migration and created in an isolated
// database, so what runs here is the definition that ships — not a paraphrase.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const MIG = join(process.cwd(),
  'supabase/migrations/20261118110000_abc16_abc17_relationship_evidence_containment.sql');

/** Lift one function definition out of the migration exactly as written. */
function lift(name: string): string {
  const src = readFileSync(MIG, 'utf8');
  const i = src.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  if (i < 0) throw new Error(`${name} not found in the containment migration`);
  // the §3 section is EXECUTEd inside a DO block, so its lines carry a two-space indent
  const m = /\n {0,4}\$\$;/.exec(src.slice(i));
  if (!m) throw new Error(`${name} body not terminated`);
  return src.slice(i, i + m.index + m[0].length).replace(/^ {2}/gm, '');
}

const MANAGER = '70000000-0000-4000-8000-000000000001';
const PLAYER = '70000000-0000-4000-8000-000000000002';
const OTHER = '70000000-0000-4000-8000-000000000003';
const ACADEMY_A = '80000000-0000-4000-8000-000000000001';
const ACADEMY_B = '80000000-0000-4000-8000-000000000002';
const TRAINER = '90000000-0000-4000-8000-000000000001';
const MY_PERSON = 'a0000000-0000-4000-8000-000000000001';

const uid = (u: string | null) =>
  db.query(`SELECT set_config('abc16.uid', $1, false)`, [u ?? '']);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT NULLIF(current_setting('abc16.uid', true), '')::uuid
    $fn$;

    CREATE TABLE public.academy_managers (academy_profile_id uuid, user_id uuid, role text);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.bookings (id uuid PRIMARY KEY, slot_id uuid, player_id uuid, status text);
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, trainer_id uuid);
    CREATE TABLE public.academy_trainers (academy_profile_id uuid, trainer_profile_id uuid, status text);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.guest_players (
      id uuid PRIMARY KEY, academy_profile_id uuid, trainer_id uuid,
      linked_profile_id uuid, twin_of_profile_id uuid);
    CREATE TABLE public.person_links (person_id uuid, guest_player_id uuid, profile_id uuid);

    -- admin is a real gate here (an admin must still see everything), and the person helper
    -- exists so that "the narrowed body does not call it" is a claim about the body, not about
    -- a missing function.
    CREATE TABLE public.admins (user_id uuid PRIMARY KEY);
    CREATE OR REPLACE FUNCTION public.is_admin(_uid uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $fn$ SELECT EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = _uid) $fn$;
    CREATE OR REPLACE FUNCTION public.is_academy_manager(_uid uuid, _academy uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $fn$
        SELECT EXISTS (SELECT 1 FROM public.academy_managers m
                        WHERE m.user_id = _uid AND m.academy_profile_id = _academy) $fn$;
    CREATE OR REPLACE FUNCTION public.get_my_person_id() RETURNS uuid
      LANGUAGE sql STABLE AS $fn$ SELECT '${MY_PERSON}'::uuid $fn$;
    CREATE OR REPLACE FUNCTION public.is_guest_split_frozen(_g uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $fn$ SELECT false $fn$;

    INSERT INTO public.academy_managers (academy_profile_id, user_id, role)
      VALUES ('${ACADEMY_A}', '${MANAGER}', 'owner');
    INSERT INTO public.trainer_profiles (id, user_id) VALUES ('${TRAINER}', '${OTHER}');
    INSERT INTO public.profiles (id, user_id) VALUES
      ('c0000000-0000-4000-8000-000000000001', '${PLAYER}');
    -- the withdrawn evidence, all still STORED: a seat at academy B's active trainer, plus a
    -- guest row bridged to the player's profile by twin, link and a curated person link.
    INSERT INTO public.availability_slots (id, trainer_id) VALUES ('d0000000-0000-4000-8000-000000000001', '${TRAINER}');
    INSERT INTO public.academy_trainers (academy_profile_id, trainer_profile_id, status)
      VALUES ('${ACADEMY_B}', '${TRAINER}', 'active');
    INSERT INTO public.bookings (id, slot_id, player_id, status)
      VALUES ('e0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001',
              'c0000000-0000-4000-8000-000000000001', 'confirmed');
    INSERT INTO public.guest_players (id, academy_profile_id, trainer_id, linked_profile_id, twin_of_profile_id)
      VALUES ('f0000000-0000-4000-8000-000000000001', '${ACADEMY_B}', '${TRAINER}',
              'c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001');
    INSERT INTO public.person_links (person_id, guest_player_id, profile_id) VALUES
      ('${MY_PERSON}', 'f0000000-0000-4000-8000-000000000001', NULL),
      ('${MY_PERSON}', NULL, 'c0000000-0000-4000-8000-000000000001');
  `);
  await db.exec(lift('notif_my_academy_ids'));
  await db.exec(lift('notification_row_visible_to_caller'));
}, 120_000);

const myAcademies = async (u: string | null) => {
  await uid(u);
  const r = await db.query<{ notif_my_academy_ids: string }>(`SELECT public.notif_my_academy_ids()`);
  return r.rows.map((x) => x.notif_my_academy_ids).filter(Boolean).sort();
};

describe('§3 · notif_my_academy_ids', () => {
  it('an ordinary player account gets NO academies, despite a seat and a bridged guest row', async () => {
    expect(await myAcademies(PLAYER)).toEqual([]);
  });

  it('POSITIVE CONTROL: a real manager still gets their own academy, so the denial is not vacuous', async () => {
    expect(await myAcademies(MANAGER)).toEqual([ACADEMY_A]);
  });

  it('an anonymous caller gets nothing', async () => {
    expect(await myAcademies(null)).toEqual([]);
  });

  it('MUTATION: the withdrawn evidence is all still present, so the denial is a decision', async () => {
    const r = await db.query<{ bookings: number; bridged: number; links: number }>(`
      SELECT (SELECT count(*) FROM public.bookings WHERE status = 'confirmed')::int AS bookings,
             (SELECT count(*) FROM public.guest_players
               WHERE linked_profile_id IS NOT NULL AND twin_of_profile_id IS NOT NULL)::int AS bridged,
             (SELECT count(*) FROM public.person_links)::int AS links`);
    expect(r.rows[0]).toEqual({ bookings: 1, bridged: 1, links: 2 });
  });
});

describe('§3 · notification_row_visible_to_caller', () => {
  const visible = async (
    caller: string | null,
    scope: string,
    academy: string | null,
    trainer: string | null,
    person: string | null,
    user: string | null,
  ) => {
    await uid(caller);
    const r = await db.query<{ v: boolean }>(
      `SELECT public.notification_row_visible_to_caller($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid) AS v`,
      [scope, academy, trainer, person, user]);
    return r.rows[0].v;
  };

  it('RETAINED: a user sees their own private row addressed directly to them', async () => {
    expect(await visible(PLAYER, 'private_user_only', null, null, null, PLAYER)).toBe(true);
  });

  it('the "my person" expansion is GONE — a shared person no longer opens another’s history', async () => {
    // the row is addressed to a DIFFERENT user but carries the caller's person: previously visible
    expect(await visible(PLAYER, 'private_user_only', null, null, MY_PERSON, OTHER)).toBe(false);
    // and a person-only row is not the caller's history either
    expect(await visible(PLAYER, 'private_user_only', null, null, MY_PERSON, null)).toBe(false);
  });

  it('a private row for someone else stays invisible', async () => {
    expect(await visible(PLAYER, 'private_user_only', null, null, null, OTHER)).toBe(false);
  });

  it('RETAINED: admin sees everything, including admin_only', async () => {
    await db.exec(`INSERT INTO public.admins (user_id) VALUES ('${OTHER}') ON CONFLICT DO NOTHING`);
    expect(await visible(OTHER, 'admin_only', null, null, null, PLAYER)).toBe(true);
    await db.exec(`DELETE FROM public.admins WHERE user_id = '${OTHER}'`);
  });

  it('admin_only is never tenant-visible to a manager', async () => {
    expect(await visible(MANAGER, 'admin_only', ACADEMY_A, null, null, null)).toBe(false);
  });

  it('RETAINED: tenant staff see tenant_visible rows inside their own tenant only', async () => {
    expect(await visible(MANAGER, 'tenant_visible', ACADEMY_A, null, null, null)).toBe(true);
    expect(await visible(MANAGER, 'tenant_visible', ACADEMY_B, null, null, null)).toBe(false);
  });

  it('RETAINED: a trainer sees their own tenant rows', async () => {
    expect(await visible(OTHER, 'tenant_visible_limited', null, TRAINER, null, null)).toBe(true);
    expect(await visible(PLAYER, 'tenant_visible_limited', null, TRAINER, null, null)).toBe(false);
  });

  it('being a tenant row’s addressee is still not a bypass', async () => {
    // a tenant_visible row addressed to the caller must still clear the tenant arm
    expect(await visible(PLAYER, 'tenant_visible', ACADEMY_B, null, null, PLAYER)).toBe(false);
  });
});
