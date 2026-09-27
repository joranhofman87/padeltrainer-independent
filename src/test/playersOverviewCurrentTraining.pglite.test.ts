// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// PTF-OPTION-A — get_players_overview `current_training` / `training_location_id` keys, proven on the
// REAL migration chain (the overview's existing harness + 20261208100000) against the effective
// function, not the UI. Tom's option A: ongoing cycles + upcoming standalone sessions count; a cycle
// that has not started does not. One qualifying-session predicate drives both keys.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const A = 'a0000000-0000-0000-0000-00000000000a';
const B = 'b0000000-0000-0000-0000-00000000000b';
const MGR_A = 'a0000000-0000-0000-0000-0000000000a1';
const MGR_B = 'b0000000-0000-0000-0000-0000000000b1';
const STRANGER = 'f0000000-0000-0000-0000-0000000000f1';
// TS trains for BOTH academies and runs an independent practice.
const TS = 'c0000000-0000-0000-0000-000000000071';
const TS_USER = 'c0000000-0000-0000-0000-0000000000c7';

const LOC_A1 = 'a0000000-0000-0000-0000-00000000e0a1';
const LOC_A2 = 'a0000000-0000-0000-0000-00000000e0a2';
const LOC_OLD = 'a0000000-0000-0000-0000-00000000e0ff'; // merged into LOC_A1
const LOC_B = 'b0000000-0000-0000-0000-00000000e0b1';

const CYC_ONGOING = 'cc000000-0000-0000-0000-0000000000c1';
const CYC_FUTURE = 'cc000000-0000-0000-0000-0000000000c2';
const CYC_STARTS_SOON = 'cc000000-0000-0000-0000-0000000000c3';
const CYC_JUST_STARTED = 'cc000000-0000-0000-0000-0000000000c4';
const CYC_B = 'cc000000-0000-0000-0000-0000000000cb';

const S = (n: number) => `5e000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const S_ON_PAST = S(1), S_ON_NEXT = S(2);             // ongoing cycle @A1
const S_FU1 = S(3), S_FU2 = S(4);                      // future cycle @A2 (not started)
const S_SOON1 = S(5), S_SOON2 = S(6);                  // cycle starting in 1 minute @A1
const S_JUST1 = S(7), S_JUST2 = S(8);                  // cycle whose 1st session started 1 min ago @A1
const S_SA_FAR = S(9);                                 // standalone, 400 days ahead @A2
const S_SA_ENDED = S(10);                              // standalone, ended 1 second ago @A1
const S_SA_NOW = S(11);                                // standalone, in progress @LOC_OLD (→ A1)
const S_B_PAST = S(12), S_B_NEXT = S(13);              // academy B's ongoing cycle @B (trainer TS)
const S_INDEP = S(14);                                 // TS's own practice (no academy), ahead

const G = (n: number) => `9a000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const G_ONGOING = G(1);
const G_FUTURE_CYCLE = G(2);
const G_STANDALONE_FAR = G(3);
const G_PAST_ONLY = G(4);
const G_CANCELLED = G(5);
const G_PENDING = G(6);
const G_DROPPED = G(7);
const G_IN_PROGRESS = G(8);
const G_B_ONLY = G(9);          // A's guest (preferred club A1) who trains only at academy B
const G_INDEP = G(10);
const G_SOON = G(11);
const G_JUST = G(12);
const G_COMPLETED_AHEAD = G(13);
const G_OF_B = G(14);           // academy B's own guest, training at B
// merged human: A's guest GM + profile PM → one person (person id = profile id)
const GM = G(20);
const PM = '9b000000-0000-0000-0000-000000000020';
// registered-only profile seen by BOTH academies through shared trainer TS (pre-existing universe)
const PR = '9b000000-0000-0000-0000-000000000030';
// unmerged family: parent profile books the child's guest seat (dual-keyed) — FAM-02: that session is
// the CHILD's training, never the parent's (the parent is still listed via the dual-keyed booking)
const P_PARENT = '9b000000-0000-0000-0000-000000000040';
const G_CHILD = G(40);

type Row = {
  player_key: string; person_id: string; guest_player_id: string | null; profile_id: string | null;
  full_name: string; has_active_cyclus: boolean; total_count: string | number;
};

async function call(
  uid: string,
  filters: Record<string, unknown>,
  opts: { scope?: 'academy' | 'trainer'; scopeId?: string; limit?: number; offset?: number } = {},
): Promise<Row[]> {
  await db.exec(`SET test.uid = '${uid}';`);
  try {
    const { rows } = await db.query<Row>(
      `SELECT * FROM public.get_players_overview($1, $2, NULL, $3::jsonb, 'name', 'asc', $4, $5)`,
      [opts.scope ?? 'academy', opts.scopeId ?? A, JSON.stringify(filters), opts.limit ?? 500, opts.offset ?? 0],
    );
    return rows;
  } finally {
    await db.exec(`SET test.uid = '';`);
  }
}
const names = (rows: Row[]) => rows.map((r) => r.full_name).sort();
const errCode = (p: Promise<unknown>) =>
  p.then(() => 'no error', (e: { code?: string }) => e.code ?? String(e));

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid $fn$;

    -- minimal prod-shaped tables: the same shape as playersOverviewPersonDedup.pglite.test.ts
    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY, timezone text);
    CREATE TABLE public.academy_managers (academy_profile_id uuid, user_id uuid);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.academy_trainers (academy_profile_id uuid, trainer_profile_id uuid, status text);
    CREATE TABLE public.profiles (
      id uuid PRIMARY KEY, user_id uuid, full_name text, email text, phone text,
      billing_business_name text, billing_address text, billing_btw_number text,
      skill_rating numeric, rating_system text, birth_date date);
    CREATE TABLE public.guest_players (
      id uuid PRIMARY KEY, trainer_id uuid, academy_profile_id uuid, full_name text, email text,
      phone text, billing_business_name text, billing_address text, billing_btw_number text,
      skill_rating numeric, rating_system text, notes text, source text, birth_date date,
      has_trained boolean, preferred_location_id uuid, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.persons (
      id uuid PRIMARY KEY, full_name text, email text, phone text, birth_date date,
      skill_rating numeric, rating_system text, user_id uuid,
      billing_business_name text, billing_address text, billing_btw_number text);
    CREATE TABLE public.person_links (person_id uuid, profile_id uuid, guest_player_id uuid);
    CREATE TABLE public.person_merge_review (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text, status text,
      guest_player_id uuid, person_id uuid, email text);
    CREATE TABLE public.availability_slots (
      id uuid PRIMARY KEY, trainer_id uuid, academy_profile_id uuid, location_id uuid,
      cyclus_id uuid, cyclus_name text, start_time timestamptz, end_time timestamptz,
      max_participants integer, is_public boolean, price_per_session numeric);
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid,
      guest_player_id uuid, person_id uuid, status text, payment_status text,
      paid_externally boolean, hold_expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.academy_player_metadata (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), academy_profile_id uuid, trainer_profile_id uuid,
      guest_player_id uuid, profile_id uuid, notes text, tag_ids uuid[],
      preferred_location_id uuid, removed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.intake_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cycle_id uuid, player_id uuid,
      guest_player_id uuid, location_id uuid, status text);
    CREATE TABLE public.academy_player_locations (
      academy_profile_id uuid, profile_id uuid, guest_player_id uuid, location_id uuid, dismissed boolean);
    CREATE TABLE public.locations (id uuid PRIMARY KEY, name text, merged_into uuid);
    CREATE TABLE public.academy_locations (academy_profile_id uuid, location_id uuid, is_active boolean);
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), academy_profile_id uuid, trainer_id uuid,
      player_id uuid, guest_player_id uuid, status text, due_date date, paid_at timestamptz);
    CREATE TABLE public.email_address_state (email text, state text,
      provider_suppressed_active boolean NOT NULL DEFAULT false,
      is_suppressed boolean GENERATED ALWAYS AS ((state IN ('hard_bounced','complained')) OR provider_suppressed_active) STORED);
    CREATE TABLE public.cycles (
      id uuid PRIMARY KEY, name text, owner_type text, owner_id uuid, status text, type text,
      start_date date, end_date date, price_per_session numeric, location_id uuid, category_id uuid,
      settings jsonb);
    CREATE TABLE public.academy_cycle_categories (id uuid PRIMARY KEY, name text, color text);

    CREATE OR REPLACE FUNCTION public.is_academy_manager(_user_id uuid, _academy_profile_id uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
        SELECT EXISTS (SELECT 1 FROM public.academy_managers
                       WHERE user_id = _user_id AND academy_profile_id = _academy_profile_id) $fn$;
    CREATE OR REPLACE FUNCTION public.get_user_academy_ids(_u uuid) RETURNS SETOF uuid LANGUAGE sql STABLE
      SECURITY DEFINER SET search_path = public AS $fn$
        SELECT academy_profile_id FROM public.academy_managers WHERE user_id = _u $fn$;
    CREATE OR REPLACE FUNCTION public.fold_search_text(_value text)
      RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public AS $fn$
        SELECT translate(lower(coalesce(_value, '')),
          'áàâäãåāăąçćčďđéèêëēĕėęěğģíìîïĩīĭįıķĺļľłñńņňóòôöõøōŏőŕŗřśšşťţúùûüũūŭůűųýÿžźż',
          'aaaaaaaaacccddeeeeeeeeeggiiiiiiiiikllllnnnnooooooooorrrsssttuuuuuuuuuuyyzzz') $fn$;
    CREATE OR REPLACE FUNCTION public.digits_only(_value text)
      RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public AS $fn$
        SELECT regexp_replace(coalesce(_value, ''), '\\D', '', 'g') $fn$;
    CREATE OR REPLACE FUNCTION public.booking_occupies_seat(p_status text, p_hold_expires_at timestamptz)
      RETURNS boolean LANGUAGE sql STABLE AS $fn$
        SELECT COALESCE(p_status, 'confirmed') IN ('confirmed', 'pending', 'pending_approval')
            OR (p_status = 'payment_pending' AND p_hold_expires_at IS NOT NULL AND p_hold_expires_at > now()) $fn$;
  `);

  await db.exec(`
    INSERT INTO public.academy_profiles (id, timezone) VALUES ('${A}', 'Europe/Amsterdam'), ('${B}', 'Europe/Amsterdam');
    INSERT INTO public.academy_managers VALUES ('${A}', '${MGR_A}'), ('${B}', '${MGR_B}');
    INSERT INTO public.trainer_profiles VALUES ('${TS}', '${TS_USER}');
    INSERT INTO public.academy_trainers VALUES ('${A}', '${TS}', 'active'), ('${B}', '${TS}', 'active');
    INSERT INTO public.locations (id, name, merged_into) VALUES
      ('${LOC_A1}', 'Club A1', NULL), ('${LOC_A2}', 'Club A2', NULL),
      ('${LOC_OLD}', 'Club A1 (old)', '${LOC_A1}'), ('${LOC_B}', 'Club B', NULL);
    INSERT INTO public.academy_locations VALUES
      ('${A}', '${LOC_A1}', true), ('${A}', '${LOC_A2}', true), ('${B}', '${LOC_B}', true);

    INSERT INTO public.availability_slots (id, trainer_id, academy_profile_id, location_id, cyclus_id, start_time, end_time) VALUES
      ('${S_ON_PAST}',  '${TS}', '${A}', '${LOC_A1}', '${CYC_ONGOING}',      now() - interval '7 days',   now() - interval '7 days' + interval '1 hour'),
      ('${S_ON_NEXT}',  '${TS}', '${A}', '${LOC_A1}', '${CYC_ONGOING}',      now() + interval '1 day',    now() + interval '1 day 1 hour'),
      ('${S_FU1}',      '${TS}', '${A}', '${LOC_A2}', '${CYC_FUTURE}',       now() + interval '3 days',   now() + interval '3 days 1 hour'),
      ('${S_FU2}',      '${TS}', '${A}', '${LOC_A2}', '${CYC_FUTURE}',       now() + interval '10 days',  now() + interval '10 days 1 hour'),
      ('${S_SOON1}',    '${TS}', '${A}', '${LOC_A1}', '${CYC_STARTS_SOON}',  now() + interval '1 minute', now() + interval '61 minutes'),
      ('${S_SOON2}',    '${TS}', '${A}', '${LOC_A1}', '${CYC_STARTS_SOON}',  now() + interval '7 days',   now() + interval '7 days 1 hour'),
      ('${S_JUST1}',    '${TS}', '${A}', '${LOC_A1}', '${CYC_JUST_STARTED}', now() - interval '1 minute', now() + interval '59 minutes'),
      ('${S_JUST2}',    '${TS}', '${A}', '${LOC_A1}', '${CYC_JUST_STARTED}', now() + interval '7 days',   now() + interval '7 days 1 hour'),
      ('${S_SA_FAR}',   '${TS}', '${A}', '${LOC_A2}', NULL,                  now() + interval '400 days', now() + interval '400 days 1 hour'),
      ('${S_SA_ENDED}', '${TS}', '${A}', '${LOC_A1}', NULL,                  now() - interval '1 hour',   now() - interval '1 second'),
      ('${S_SA_NOW}',   '${TS}', '${A}', '${LOC_OLD}', NULL,                 now() - interval '30 minutes', now() + interval '1 minute'),
      ('${S_B_PAST}',   '${TS}', '${B}', '${LOC_B}',  '${CYC_B}',            now() - interval '7 days',   now() - interval '7 days' + interval '1 hour'),
      ('${S_B_NEXT}',   '${TS}', '${B}', '${LOC_B}',  '${CYC_B}',            now() + interval '1 day',    now() + interval '1 day 1 hour'),
      ('${S_INDEP}',    '${TS}', NULL,   '${LOC_A1}', NULL,                  now() + interval '2 days',   now() + interval '2 days 1 hour');

    INSERT INTO public.guest_players (id, academy_profile_id, full_name, email, phone, preferred_location_id) VALUES
      ('${G_ONGOING}',         '${A}', 'Ongoing Cycle',       'ongoing@x.nl',   '+31611111111', NULL),
      ('${G_FUTURE_CYCLE}',    '${A}', 'Future Cycle Only',   'future@x.nl',    NULL,           NULL),
      ('${G_STANDALONE_FAR}',  '${A}', 'Standalone Far',      'far@x.nl',       NULL,           NULL),
      ('${G_PAST_ONLY}',       '${A}', 'Past Only',           'past@x.nl',      NULL,           NULL),
      ('${G_CANCELLED}',       '${A}', 'Cancelled',           'cancel@x.nl',    NULL,           NULL),
      ('${G_PENDING}',         '${A}', 'Pending',             'pending@x.nl',   NULL,           NULL),
      ('${G_DROPPED}',         '${A}', 'Dropped Out',         'dropped@x.nl',   NULL,           NULL),
      ('${G_IN_PROGRESS}',     '${A}', 'In Progress',         'now@x.nl',       NULL,           NULL),
      ('${G_B_ONLY}',          '${A}', 'Trains At B',         'b-only@x.nl',    NULL,           '${LOC_A1}'),
      ('${G_INDEP}',           '${A}', 'Independent Only',    'indep@x.nl',     NULL,           NULL),
      ('${G_SOON}',            '${A}', 'Cycle Starts Soon',   'soon@x.nl',      NULL,           NULL),
      ('${G_JUST}',            '${A}', 'Cycle Just Started',  'just@x.nl',      NULL,           NULL),
      ('${G_COMPLETED_AHEAD}', '${A}', 'Completed Ahead',     'done@x.nl',      NULL,           NULL),
      ('${G_OF_B}',            '${B}', 'B Own Guest',         'bown@x.nl',      NULL,           NULL),
      ('${GM}',                '${A}', 'Merged Guest Side',   'merged@x.nl',    NULL,           NULL),
      ('${G_CHILD}',           '${A}', 'Child Guest',         'family@x.nl',    NULL,           NULL);

    INSERT INTO public.profiles (id, full_name, email) VALUES
      ('${PM}', 'Merged Person', 'merged@x.nl'),
      ('${PR}', 'Registered Shared', 'reg@x.nl'),
      ('${P_PARENT}', 'Parent Profile', 'family@x.nl');
    INSERT INTO public.persons (id, full_name, email, user_id) VALUES
      ('${PM}', 'Merged Person', 'merged@x.nl', '${PM}'),
      ('${PR}', 'Registered Shared', 'reg@x.nl', '${PR}');
    INSERT INTO public.person_links (person_id, profile_id) VALUES ('${PM}', '${PM}');
    INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PM}', '${GM}');

    INSERT INTO public.bookings (slot_id, guest_player_id, player_id, status) VALUES
      ('${S_ON_NEXT}',  '${G_ONGOING}',         NULL, 'confirmed'),
      ('${S_ON_PAST}',  '${G_ONGOING}',         NULL, 'completed'),
      ('${S_FU1}',      '${G_FUTURE_CYCLE}',    NULL, 'confirmed'),
      ('${S_FU2}',      '${G_FUTURE_CYCLE}',    NULL, 'confirmed'),
      ('${S_SA_FAR}',   '${G_STANDALONE_FAR}',  NULL, 'confirmed'),
      ('${S_SA_ENDED}', '${G_PAST_ONLY}',       NULL, 'completed'),
      ('${S_ON_NEXT}',  '${G_CANCELLED}',       NULL, 'cancelled'),
      ('${S_ON_NEXT}',  '${G_PENDING}',         NULL, 'pending'),
      ('${S_ON_PAST}',  '${G_DROPPED}',         NULL, 'completed'),
      ('${S_ON_NEXT}',  '${G_DROPPED}',         NULL, 'cancelled'),
      ('${S_SA_NOW}',   '${G_IN_PROGRESS}',     NULL, 'confirmed'),
      ('${S_B_NEXT}',   '${G_B_ONLY}',          NULL, 'confirmed'),
      ('${S_INDEP}',    '${G_INDEP}',           NULL, 'confirmed'),
      ('${S_SOON1}',    '${G_SOON}',            NULL, 'confirmed'),
      ('${S_SOON2}',    '${G_SOON}',            NULL, 'confirmed'),
      ('${S_JUST2}',    '${G_JUST}',            NULL, 'confirmed'),
      ('${S_ON_NEXT}',  '${G_COMPLETED_AHEAD}', NULL, 'completed'),
      ('${S_B_NEXT}',   '${G_OF_B}',            NULL, 'confirmed'),
      -- merged person: a pure-profile booking AND a guest-seat booking → still ONE row
      ('${S_ON_NEXT}',  NULL,                   '${PM}', 'confirmed'),
      ('${S_SA_FAR}',   '${GM}',                NULL, 'confirmed'),
      -- registered-only profile: an A-owned session via shared trainer TS → in BOTH universes
      ('${S_ON_NEXT}',  NULL,                   '${PR}', 'confirmed'),
      ('${S_ON_NEXT}',  '${G_CHILD}',           '${P_PARENT}', 'confirmed');
  `);

  for (const f of [
    '20260827100000_phase32_players_overview_person_dedup.sql',
    '20260901110000_phase33e_overview_type_has_login.sql',
    '20261006120000_readers_canonical_is_suppressed.sql',
    '20261208100000_players_overview_current_training.sql', // under test
  ]) {
    await db.exec(
      readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8')
        .split('\n').filter((l) => !/^(REVOKE|GRANT)\b/.test(l)).join('\n'),
    );
  }
});

const TRAINING_AT_A = [
  'Child Guest', 'Completed Ahead', 'Cycle Just Started', 'In Progress', 'Merged Person', 'Ongoing Cycle',
  'Registered Shared', 'Standalone Far',
];

describe('current_training — option A qualifying sessions (effective function)', () => {
  it('includes ongoing cycles + upcoming/in-progress standalone sessions, nothing else', async () => {
    expect(names(await call(MGR_A, { current_training: true }))).toEqual(TRAINING_AT_A);
  });

  it('excludes a cycle that has not started, even with every session booked', async () => {
    const training = names(await call(MGR_A, { current_training: true }));
    expect(training).not.toContain('Future Cycle Only');
    expect(training).not.toContain('Cycle Starts Soon'); // first session starts in 1 minute
    expect(training).toContain('Cycle Just Started');    // first session started 1 minute ago
  });

  it('has no future horizon for standalone sessions (400 days ahead still counts)', async () => {
    expect(names(await call(MGR_A, { current_training: true }))).toContain('Standalone Far');
  });

  it('time boundary: ended 1s ago does not count; in progress (ends in 1 min) does', async () => {
    const training = names(await call(MGR_A, { current_training: true }));
    expect(training).not.toContain('Past Only');
    expect(training).toContain('In Progress');
  });

  it('only confirmed/completed bookings qualify; cancelled, pending and dropped-out never do', async () => {
    const training = names(await call(MGR_A, { current_training: true }));
    for (const n of ['Cancelled', 'Pending', 'Dropped Out']) expect(training).not.toContain(n);
    expect(training).toContain('Completed Ahead');
  });

  it('current_training=false is the exact complement within the unchanged universe', async () => {
    const all = names(await call(MGR_A, {}));
    const yes = names(await call(MGR_A, { current_training: true }));
    const no = names(await call(MGR_A, { current_training: false }));
    expect([...yes, ...no].sort()).toEqual(all);
    expect(yes.filter((n) => no.includes(n))).toEqual([]);
  });

  it('does not redefine has_active_cyclus (a future-cycle booking keeps its old flag)', async () => {
    const [row] = (await call(MGR_A, {})).filter((r) => r.full_name === 'Future Cycle Only');
    expect(row.has_active_cyclus).toBe(true);
    expect(names(await call(MGR_A, { has_active_cyclus: true }))).toContain('Future Cycle Only');
  });

  it("a dual-keyed family booking is the child's training, not the unmerged parent's (FAM-02)", async () => {
    expect(names(await call(MGR_A, {}))).toContain('Parent Profile'); // still listed (unchanged universe)
    const training = names(await call(MGR_A, { current_training: true }));
    expect(training).toContain('Child Guest');
    expect(training).not.toContain('Parent Profile');
    expect(names(await call(MGR_A, { training_location_id: LOC_A1 }))).not.toContain('Parent Profile');
  });

  it('a merged guest/account person is ONE row, keyed by the canonical person', async () => {
    const rows = (await call(MGR_A, { current_training: true })).filter((r) => r.person_id === PM);
    expect(rows).toHaveLength(1);
    expect(rows[0].guest_player_id).toBe(GM);
    expect(rows[0].profile_id).toBe(PM);
  });
});

describe('tenant authority — shared trainer, shared person, other academies', () => {
  it("another academy's session never makes a person 'training at A' (shared trainer)", async () => {
    const training = names(await call(MGR_A, { current_training: true }));
    expect(training).not.toContain('Trains At B');
    expect(training).not.toContain('Independent Only'); // TS's own practice, no academy
  });

  it("B sees only B-owned training, even for a person A's session admits to B's universe", async () => {
    const bAll = names(await call(MGR_B, {}, { scopeId: B }));
    expect(bAll).toContain('Registered Shared'); // pre-existing universe (shared trainer) — unchanged
    const bTraining = names(await call(MGR_B, { current_training: true }, { scopeId: B }));
    expect(bTraining).toEqual(['B Own Guest']);
  });

  it('the filtered set is always a subset of what the manager already sees (no new contacts)', async () => {
    for (const [uid, scopeId] of [[MGR_A, A], [MGR_B, B]] as const) {
      const all = new Set((await call(uid, {}, { scopeId })).map((r) => r.player_key));
      for (const f of [{ current_training: true }, { training_location_id: LOC_A1 }, { training_location_id: LOC_B }]) {
        for (const r of await call(uid, f, { scopeId })) expect(all.has(r.player_key)).toBe(true);
      }
    }
  });

  it('refuses a manager of another academy, a stranger and anonymous callers (42501)', async () => {
    expect(await errCode(call(MGR_B, { current_training: true }))).toBe('42501');
    expect(await errCode(call(STRANGER, { current_training: true }))).toBe('42501');
    expect(await errCode(call('', { training_location_id: LOC_A1 }))).toBe('42501');
  });

  it('refuses the training keys in trainer scope instead of ignoring them (22023)', async () => {
    const opts = { scope: 'trainer' as const, scopeId: TS };
    expect(await errCode(call(TS_USER, { current_training: true }, opts))).toBe('22023');
    expect(await errCode(call(TS_USER, { training_location_id: LOC_A1 }, opts))).toBe('22023');
    expect((await call(TS_USER, {}, opts)).length).toBeGreaterThan(0); // trainer scope otherwise unchanged
  });
});

describe('training_location_id — the same qualifying sessions, at one club', () => {
  it('club A1: only people with a qualifying session there (merged old club resolves to A1)', async () => {
    expect(names(await call(MGR_A, { training_location_id: LOC_A1 }))).toEqual([
      'Child Guest', 'Completed Ahead', 'Cycle Just Started', 'In Progress', 'Merged Person', 'Ongoing Cycle', 'Registered Shared',
    ]);
  });

  it('club A2: a not-started cycle there does not count; the far standalone session does', async () => {
    expect(names(await call(MGR_A, { training_location_id: LOC_A2 }))).toEqual(['Merged Person', 'Standalone Far']);
  });

  it('a preferred/historical club is not a training club (existing chip filter keeps its meaning)', async () => {
    expect(names(await call(MGR_A, { training_location_id: LOC_A1 }))).not.toContain('Trains At B');
    expect(names(await call(MGR_A, { location_id: LOC_A1 }))).toContain('Trains At B');
  });

  it("another academy's club never matches for A", async () => {
    expect(await call(MGR_A, { training_location_id: LOC_B })).toEqual([]);
  });

  it('every training-club match is also current_training (one predicate)', async () => {
    const training = new Set(names(await call(MGR_A, { current_training: true })));
    for (const loc of [LOC_A1, LOC_A2]) {
      for (const n of names(await call(MGR_A, { training_location_id: loc }))) expect(training.has(n)).toBe(true);
    }
  });
});

describe('multi-page correctness under the new filter', () => {
  it('pages partition the filtered set exactly: no duplicate, no gap, stable total', async () => {
    const full = await call(MGR_A, { current_training: true });
    const pageSize = 2;
    const seen: string[] = [];
    for (let offset = 0; offset < full.length; offset += pageSize) {
      const page = await call(MGR_A, { current_training: true }, { limit: pageSize, offset });
      for (const r of page) expect(Number(r.total_count)).toBe(full.length);
      seen.push(...page.map((r) => r.person_id));
    }
    expect(seen).toEqual(full.map((r) => r.person_id));
    expect(new Set(seen).size).toBe(seen.length);
  });
});
