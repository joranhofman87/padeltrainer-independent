// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// PTF export follow-up — get_players_overview_export's training / profile columns
// (20261208120000), proven on the REAL migration chain (the overview chain + 20261208100000 + the
// follow-up): currently_training equals the list's own "Currently training" filter; last / next
// training date and the past booking count read ONLY the academy's own confirmed/completed sessions,
// per canonical person, each session once; birth date and the list's authorized club chips; blanks for
// missing values; tenant isolation; and cost that grows proportionally with the data.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const A = 'a0000000-0000-0000-0000-00000000000a';
const B = 'b0000000-0000-0000-0000-00000000000b';
const P = 'd0000000-0000-0000-0000-00000000000d'; // the proportional-cost academy
const MGR_A = 'a0000000-0000-0000-0000-0000000000a1';
const MGR_B = 'b0000000-0000-0000-0000-0000000000b1';
const MGR_P = 'd0000000-0000-0000-0000-0000000000d1';
const STRANGER = 'f0000000-0000-0000-0000-0000000000f1';
const TS = 'c0000000-0000-0000-0000-000000000071'; // trains for A and B, and independently

const LOC_A1 = 'a0000000-0000-0000-0000-00000000e0a1';
const LOC_A2 = 'a0000000-0000-0000-0000-00000000e0a2';
const LOC_OLD = 'a0000000-0000-0000-0000-00000000e0ff'; // merged into LOC_A1
const LOC_TWIN = 'a0000000-0000-0000-0000-00000000e0a3'; // a second club also NAMED "Club A2"
const LOC_B = 'b0000000-0000-0000-0000-00000000e0b1';
const LOC_INACT = 'a0000000-0000-0000-0000-00000000e0a9'; // an INACTIVE club of A

const S = (n: number) => `5e000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const G = (n: number) => `9a000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const PR = (n: number) => `9b000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

// sessions
const S_PAST_TZ = S(1);    // 2026-03-10 23:30 UTC = 2026-03-11 00:30 Amsterdam (CET) @A1
const S_PAST_OLD = S(2);   // 2026-01-05 10:00 UTC @LOC_OLD (→ A1)
const S_PAST_CANC = S(3);  // 2026-03-20 10:00 UTC @A2 — only cancelled bookings for HIST
const S_NEXT = S(4);       // +2 days @A2, standalone
const S_SOONER_PEND = S(5);// +1 day @A1 — only a pending booking for HIST
const S_B_PAST = S(6);     // B's session, later than every A session in the past
const S_B_NEXT = S(7);     // B's session, sooner than S_NEXT
const S_INDEP = S(8);      // TS's own practice (no academy), +12 hours
const S_TWIN = S(9);       // 2025-12-01 @LOC_TWIN
const S_INPROG = S(10);    // in progress now @A1, standalone
const S_INACT = S(11);     // a past session at A's INACTIVE club

// people
const HIST = G(1);                 // the representative history (with DOB)
const NO_DOB = G(2);               // A-owned guest, nothing booked, no DOB
const GM = G(3), PM = PR(3);       // merged person: guest + profile, both booked on the SAME past session
const CHILD = G(4), PARENT = PR(4);// dual-keyed: the parent books the child's seat
const CANC_ONLY = G(5);            // only cancelled / pending A bookings (still listed: A-owned)
const BOTH = G(6);                 // A-owned guest also booked at B
const NOW_G = G(7);                // in an in-progress session
const REMOVED = G(8);              // soft-removed in A
const META_ONLY = G(9);            // admitted to A ONLY by an A metadata row (not A-owned, no A booking)
const FROZEN = G(10);              // linked to PM's person, but split-frozen: keys as ITSELF

type ExportRow = {
  person_id: string; full_name: string; email: string; phone: string; currently_training: boolean;
  last_training_date: string | null; next_training_date: string | null; past_bookings_count: number;
  birth_date: string | null; location_names: string[];
};

async function asUser<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET test.uid = '${uid}';`);
  try { return await fn(); } finally { await db.exec(`SET test.uid = '';`); }
}
async function exportCall(uid: string, academy: string, filters: Record<string, unknown> = {}, search: string | null = null) {
  return asUser(uid, async () => {
    const { rows } = await db.query<{ total: string | number; rows: ExportRow[] }>(
      `SELECT * FROM public.get_players_overview_export($1, $2, $3::jsonb, 'name', 'asc')`,
      [academy, search, JSON.stringify(filters)]);
    expect(rows).toHaveLength(1);
    return { total: Number(rows[0].total), rows: rows[0].rows };
  });
}
async function listPersons(uid: string, academy: string, filters: Record<string, unknown>) {
  return asUser(uid, async () => (await db.query<{ person_id: string }>(
    `SELECT person_id FROM public.get_players_overview('academy', $1, NULL, $2::jsonb, 'name', 'asc', 500, 0)`,
    [academy, JSON.stringify(filters)])).rows.map((r) => r.person_id).sort());
}
const byId = (rows: ExportRow[]) => new Map(rows.map((r) => [r.person_id, r]));
const errCode = (p: Promise<unknown>) => p.then(() => 'no error', (e: { code?: string }) => e.code ?? String(e));
/** Amsterdam calendar date of an instant, as the server renders it. */
const amsDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(d);
let nextAt: Date;

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
    INSERT INTO public.academy_profiles (id, timezone) VALUES ('${A}', 'Europe/Amsterdam'), ('${B}', NULL), ('${P}', NULL);
    INSERT INTO public.academy_managers VALUES ('${A}', '${MGR_A}'), ('${B}', '${MGR_B}'), ('${P}', '${MGR_P}');
    INSERT INTO public.trainer_profiles VALUES ('${TS}', NULL);
    INSERT INTO public.academy_trainers VALUES ('${A}', '${TS}', 'active'), ('${B}', '${TS}', 'active');
    INSERT INTO public.locations (id, name, merged_into) VALUES
      ('${LOC_A1}', 'Club A1', NULL), ('${LOC_A2}', 'Club A2', NULL), ('${LOC_OLD}', 'Club A1 (old)', '${LOC_A1}'),
      ('${LOC_TWIN}', 'Club A2', NULL), ('${LOC_B}', 'Club B', NULL), ('${LOC_INACT}', 'Club Inactive', NULL);
    INSERT INTO public.academy_locations VALUES
      ('${A}', '${LOC_A1}', true), ('${A}', '${LOC_A2}', true), ('${A}', '${LOC_TWIN}', true), ('${B}', '${LOC_B}', true),
      ('${A}', '${LOC_INACT}', false);
    INSERT INTO public.availability_slots (id, trainer_id, academy_profile_id, location_id, cyclus_id, start_time, end_time) VALUES
      ('${S_PAST_TZ}',     '${TS}', '${A}', '${LOC_A1}',  NULL, '2026-03-10T23:30:00Z', '2026-03-11T00:30:00Z'),
      ('${S_PAST_OLD}',    '${TS}', '${A}', '${LOC_OLD}', NULL, '2026-01-05T10:00:00Z', '2026-01-05T11:00:00Z'),
      ('${S_PAST_CANC}',   '${TS}', '${A}', '${LOC_A2}',  NULL, '2026-03-20T10:00:00Z', '2026-03-20T11:00:00Z'),
      ('${S_NEXT}',        '${TS}', '${A}', '${LOC_A2}',  NULL, now() + interval '2 days', now() + interval '2 days 1 hour'),
      ('${S_SOONER_PEND}', '${TS}', '${A}', '${LOC_A1}',  NULL, now() + interval '1 day',  now() + interval '1 day 1 hour'),
      ('${S_B_PAST}',      '${TS}', '${B}', '${LOC_B}',   NULL, now() - interval '1 day',  now() - interval '23 hours'),
      ('${S_B_NEXT}',      '${TS}', '${B}', '${LOC_B}',   NULL, now() + interval '3 hours', now() + interval '4 hours'),
      ('${S_INDEP}',       '${TS}', NULL,   '${LOC_A1}',  NULL, now() + interval '12 hours', now() + interval '13 hours'),
      ('${S_TWIN}',        '${TS}', '${A}', '${LOC_TWIN}', NULL, '2025-12-01T10:00:00Z', '2025-12-01T11:00:00Z'),
      ('${S_INPROG}',      '${TS}', '${A}', '${LOC_A1}',  NULL, now() - interval '30 minutes', now() + interval '30 minutes'),
      ('${S_INACT}',       '${TS}', '${A}', '${LOC_INACT}', NULL, '2026-02-01T10:00:00Z', '2026-02-01T11:00:00Z');
    -- every chip source, for the parity proof: intake, kept and dismissed associations, profile-side
    -- metadata, a preferred INACTIVE club (kept) vs a trained INACTIVE club (dropped)
    INSERT INTO public.intake_requests (guest_player_id, player_id, location_id, status) VALUES
      ('${CHILD}', NULL, '${LOC_A2}', 'confirmed'), (NULL, '${PM}', '${LOC_B}', 'confirmed');
    INSERT INTO public.academy_player_locations (academy_profile_id, guest_player_id, profile_id, location_id, dismissed) VALUES
      ('${A}', '${CHILD}', NULL, '${LOC_A1}', false),
      ('${A}', '${CHILD}', NULL, '${LOC_A2}', true),
      ('${A}', NULL, '${PM}', '${LOC_OLD}', false),
      ('${B}', '${HIST}', NULL, '${LOC_B}', false);
    INSERT INTO public.academy_player_metadata (academy_profile_id, profile_id, preferred_location_id) VALUES
      ('${A}', '${PM}', '${LOC_A2}');
    INSERT INTO public.guest_players (id, academy_profile_id, full_name, email, birth_date, preferred_location_id) VALUES
      ('${HIST}',      '${A}', 'Hist Player',   'hist@x.nl',  '2012-03-04', '${LOC_A1}'),
      ('${NO_DOB}',    '${A}', 'No Dob',        'nodob@x.nl', NULL,         NULL),
      ('${GM}',        '${A}', 'Merged Guest',  'm@x.nl',     NULL,         NULL),
      ('${CHILD}',     '${A}', 'Child Seat',    'kid@x.nl',   '2015-06-07', NULL),
      ('${CANC_ONLY}', '${A}', 'Cancelled Only','c@x.nl',     NULL,         '${LOC_INACT}'),
      ('${BOTH}',      '${A}', 'Both Academies','both@x.nl',  NULL,         NULL),
      ('${NOW_G}',     '${A}', 'Now Training',  'now@x.nl',   NULL,         NULL),
      ('${REMOVED}',   '${A}', 'Removed One',   'rem@x.nl',   NULL,         NULL),
      ('${META_ONLY}', NULL,   'Meta Only',     'meta@x.nl',  '2010-01-02', '${LOC_A2}'),
      ('${FROZEN}',    '${A}', 'Frozen Side',   'frozen@x.nl', NULL,        NULL);
    INSERT INTO public.profiles (id, full_name, email, birth_date) VALUES
      ('${PM}', 'Merged Person', 'm@x.nl', '2001-02-03'), ('${PARENT}', 'Parent', 'kid@x.nl', NULL);
    INSERT INTO public.persons (id, full_name, email, user_id) VALUES ('${PM}', 'Merged Person', 'm@x.nl', '${PM}');
    INSERT INTO public.person_links (person_id, profile_id) VALUES ('${PM}', '${PM}');
    INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PM}', '${GM}'), ('${PM}', '${FROZEN}');
    INSERT INTO public.person_merge_review (kind, status, guest_player_id, person_id)
      VALUES ('twin_detached_needs_split', 'pending', '${FROZEN}', '${PM}');
    INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id) VALUES ('${A}', '${META_ONLY}');
    INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id, removed_at) VALUES ('${A}', '${REMOVED}', now());
    INSERT INTO public.bookings (slot_id, guest_player_id, player_id, status) VALUES
      ('${S_PAST_TZ}',     '${HIST}', NULL, 'completed'),
      ('${S_PAST_OLD}',    '${HIST}', NULL, 'confirmed'),
      ('${S_PAST_CANC}',   '${HIST}', NULL, 'cancelled'),
      ('${S_PAST_CANC}',   '${HIST}', NULL, 'rejected'),
      ('${S_SOONER_PEND}', '${HIST}', NULL, 'pending'),
      ('${S_NEXT}',        '${HIST}', NULL, 'confirmed'),
      ('${S_TWIN}',        '${HIST}', NULL, 'completed'),
      ('${S_B_PAST}',      '${HIST}', NULL, 'completed'),
      ('${S_B_NEXT}',      '${HIST}', NULL, 'confirmed'),
      ('${S_INDEP}',       '${HIST}', NULL, 'confirmed'),
      -- merged person: the guest seat and a pure-profile booking on the SAME session count once
      ('${S_PAST_TZ}',     '${GM}',   NULL, 'completed'),
      ('${S_PAST_TZ}',     NULL,      '${PM}', 'completed'),
      ('${S_PAST_OLD}',    NULL,      '${PM}', 'completed'),
      -- dual-keyed: the child's session, never the parent's
      ('${S_PAST_OLD}',    '${CHILD}', '${PARENT}', 'completed'),
      ('${S_PAST_CANC}',   '${CANC_ONLY}', NULL, 'cancelled'),
      ('${S_NEXT}',        '${CANC_ONLY}', NULL, 'pending_approval'),
      ('${S_B_PAST}',      '${BOTH}', NULL, 'completed'),
      ('${S_B_NEXT}',      '${BOTH}', NULL, 'confirmed'),
      ('${S_INPROG}',      '${NOW_G}', NULL, 'confirmed'),
      ('${S_INACT}',       '${NOW_G}', NULL, 'completed'),
      ('${S_PAST_TZ}',     '${REMOVED}', NULL, 'completed'),
      -- META_ONLY trains only at B: listed in A (metadata) with no A history
      ('${S_B_PAST}',      '${META_ONLY}', NULL, 'completed'),
      -- FROZEN's sessions are its OWN, never the linked person's
      ('${S_PAST_CANC}',   '${FROZEN}', NULL, 'completed'),
      ('${S_PAST_TZ}',     '${FROZEN}', NULL, 'completed');
  `);
  nextAt = new Date((await db.query<{ t: string }>(`SELECT start_time::text AS t FROM public.availability_slots WHERE id = '${S_NEXT}'`)).rows[0].t);

  const migration = (f: string) =>
    readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8')
      .split('\n').filter((l) => !/^(REVOKE|GRANT)\b/.test(l)).join('\n');
  for (const f of [
    '20260827100000_phase32_players_overview_person_dedup.sql',
    '20260901110000_phase33e_overview_type_has_login.sql',
    '20261006120000_readers_canonical_is_suppressed.sql',
    '20261208100000_players_overview_current_training.sql',
    '20261208120000_players_overview_export_training_columns.sql', // under test
  ]) await db.exec(migration(f));
}, 120_000);

describe('get_players_overview_export — training and profile columns', () => {
  it('a representative history: last / next / count from confirmed+completed academy sessions only', async () => {
    const r = byId((await exportCall(MGR_A, A)).rows).get(HIST)!;
    // last: the latest ENDED A session it is booked on (the cancelled 03-20 session and B's later session never count),
    // as an Amsterdam calendar date: 23:30 UTC on 03-10 is 03-11 in Amsterdam
    expect(r.last_training_date).toBe('2026-03-11');
    // next: S_NEXT (+2 d). Not the sooner PENDING session, not B's sooner session, not the independent practice.
    expect(r.next_training_date).toBe(amsDate(nextAt));
    expect(r.past_bookings_count).toBe(3); // 2026-03-11, 2026-01-05, 2025-12-01 — never the cancelled/rejected one
    expect(r.currently_training).toBe(true);
    expect(r.birth_date).toBe('2012-03-04');
  });

  it('locations: the list chips, merged clubs resolved, names deduplicated and sorted; other tenants never appear', async () => {
    const r = byId((await exportCall(MGR_A, A)).rows).get(HIST)!;
    // trained A1 (+ merged OLD→A1), preferred A1, trained the twin "Club A2" (LOC_TWIN); B's club is excluded
    expect(r.location_names).toEqual(['Club A1', 'Club A2']);
    expect(r.location_names).not.toContain('Club B');
  });

  it('missing values are blanks and zero, never invented', async () => {
    const r = byId((await exportCall(MGR_A, A)).rows).get(NO_DOB)!;
    expect(r).toMatchObject({
      currently_training: false, last_training_date: null, next_training_date: null, past_bookings_count: 0,
      birth_date: null, location_names: [],
    });
  });

  it('cancelled, rejected, pending and pending_approval bookings never count', async () => {
    const r = byId((await exportCall(MGR_A, A)).rows).get(CANC_ONLY)!;
    expect(r).toMatchObject({ last_training_date: null, next_training_date: null, past_bookings_count: 0, currently_training: false });
  });

  it('a merged person counts a session once across its sides; the profile-side birth date is used', async () => {
    const r = byId((await exportCall(MGR_A, A)).rows).get(PM)!;
    expect(r.past_bookings_count).toBe(2); // S_PAST_TZ (guest seat + profile booking) once, S_PAST_OLD once
    expect(r.last_training_date).toBe('2026-03-11');
    expect(r.birth_date).toBe('2001-02-03');
  });

  it('a dual-keyed booking is the child\'s session, never the parent\'s', async () => {
    const rows = byId((await exportCall(MGR_A, A)).rows);
    expect(rows.get(CHILD)).toMatchObject({ past_bookings_count: 1, last_training_date: '2026-01-05', birth_date: '2015-06-07' });
    expect(rows.get(PARENT)).toMatchObject({ past_bookings_count: 0, last_training_date: null, next_training_date: null });
  });

  it('an in-progress session is the next training date and makes the person currently training', async () => {
    const r = byId((await exportCall(MGR_A, A)).rows).get(NOW_G)!;
    const startedAt = new Date((await db.query<{ t: string }>(`SELECT start_time::text AS t FROM public.availability_slots WHERE id = '${S_INPROG}'`)).rows[0].t);
    expect(r.next_training_date).toBe(amsDate(startedAt));
    expect(r).toMatchObject({ currently_training: true, past_bookings_count: 1, last_training_date: '2026-02-01' });
  });

  it('currently_training is exactly the list\'s "Currently training" filter, for every person', async () => {
    const { rows } = await exportCall(MGR_A, A);
    const exported = rows.filter((r) => r.currently_training).map((r) => r.person_id).sort();
    expect(exported).toEqual(await listPersons(MGR_A, A, { current_training: true }));
    expect(rows.filter((r) => !r.currently_training).map((r) => r.person_id).sort())
      .toEqual(await listPersons(MGR_A, A, { current_training: false }));
    // with the filter itself applied, the column agrees with it
    expect((await exportCall(MGR_A, A, { current_training: false })).rows.every((r) => !r.currently_training)).toBe(true);
    expect((await exportCall(MGR_A, A, { current_training: true })).rows.every((r) => r.currently_training)).toBe(true);
  });

  it('tenant isolation: each academy sees only its own sessions and clubs; a removed person is absent', async () => {
    const a = byId((await exportCall(MGR_A, A)).rows);
    const b = byId((await exportCall(MGR_B, B)).rows);
    expect(a.has(REMOVED)).toBe(false);
    // BOTH: listed in A (A-owned) with NO A history; in B with B's history only
    expect(a.get(BOTH)).toMatchObject({ past_bookings_count: 0, last_training_date: null, next_training_date: null, location_names: [] });
    expect(b.get(BOTH)!.past_bookings_count).toBe(1);
    expect(b.get(BOTH)!.location_names).toEqual(['Club B']);
    // HIST seen from B: B's sessions only (1 past, B's next), never A's clubs
    expect(b.get(HIST)).toMatchObject({ past_bookings_count: 1 });
    expect(b.get(HIST)!.location_names).toEqual(['Club B']);
    // authorization is unchanged
    expect(await errCode(exportCall(STRANGER, A))).toBe('42501');
    expect(await errCode(exportCall(MGR_B, A))).toBe('42501');
  });

  it('location_names equal the list\'s own club chips for every person, in both academies', async () => {
    for (const [mgr, academy] of [[MGR_A, A], [MGR_B, B]] as const) {
      const list = await asUser(mgr, async () => (await db.query<{ person_id: string; location_names: string[] }>(
        `SELECT person_id, location_names FROM public.get_players_overview('academy', $1, NULL, '{}'::jsonb, 'name', 'asc', 500, 0)`,
        [academy])).rows);
      const exported = byId((await exportCall(mgr, academy)).rows);
      expect(exported.size).toBe(list.length);
      for (const row of list) {
        expect([row.person_id, exported.get(row.person_id)!.location_names])
          .toEqual([row.person_id, [...new Set(row.location_names)].sort()]);
      }
    }
    const a = byId((await exportCall(MGR_A, A)).rows);
    expect(a.get(CHILD)!.location_names).toEqual(['Club A1']);                   // kept association; A2 dismissed
    expect(a.get(PM)!.location_names).toEqual(['Club A1', 'Club A2']);          // trained A1 + OLD→A1, metadata A2; intake at B dropped
    expect(a.get(CANC_ONLY)!.location_names).toEqual(['Club Inactive']);        // preferred inactive club is kept
    expect(a.get(NOW_G)!.location_names).toEqual(['Club A1']);                  // a trained inactive club is not
  });

  it('admission by an academy metadata row only: listed with its birth date and preferred club, no A history', async () => {
    const r = byId((await exportCall(MGR_A, A)).rows).get(META_ONLY)!;
    expect(r).toMatchObject({ past_bookings_count: 0, last_training_date: null, next_training_date: null,
      birth_date: '2010-01-02', location_names: ['Club A2'], currently_training: false });
  });

  it('a split-frozen guest keys as itself: its sessions never count for the linked person', async () => {
    const rows = byId((await exportCall(MGR_A, A)).rows);
    expect(rows.get(FROZEN)).toMatchObject({ past_bookings_count: 2, last_training_date: '2026-03-20' });
    expect(rows.get(PM)).toMatchObject({ past_bookings_count: 2, last_training_date: '2026-03-11' }); // unchanged
  });

  it('currently_training under training_location_id and under a non-object filters argument', async () => {
    const atA2 = await exportCall(MGR_A, A, { training_location_id: LOC_A2 });
    expect(atA2.rows.map((r) => r.person_id).sort()).toEqual(
      (await listPersons(MGR_A, A, { training_location_id: LOC_A2 })));
    expect(atA2.total).toBeGreaterThan(0);
    expect(atA2.rows.every((r) => r.currently_training)).toBe(true);
    const all = await exportCall(MGR_A, A);
    const training = await listPersons(MGR_A, A, { current_training: true });
    for (const odd of ['null', '[]', '"x"', '7']) {
      const res = await asUser(MGR_A, async () => (await db.query<{ total: string; rows: ExportRow[] }>(
        `SELECT * FROM public.get_players_overview_export($1, NULL, $2::jsonb, 'name', 'asc')`, [A, odd])).rows[0]);
      expect([odd, Number(res.total)]).toEqual([odd, all.total]); // no filter, as the authority reads it
      expect([odd, res.rows.filter((r) => r.currently_training).map((r) => r.person_id).sort()]).toEqual([odd, training]);
    }
  });

  it('the total and the rows still describe one evaluation, in list order', async () => {
    const { total, rows } = await exportCall(MGR_A, A);
    expect(rows).toHaveLength(total);
    expect(new Set(rows.map((r) => r.person_id)).size).toBe(total);
    expect(rows.map((r) => r.full_name)).toEqual([...rows.map((r) => r.full_name)].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase())));
  });
});

describe('cost grows proportionally with the data (set-level aggregation, no per-person query)', () => {
  async function seed(people: number, from: number) {
    // each person: 6 sessions of their own (4 past, 2 ahead) at P, one cancelled, two clubs
    await db.exec(`
      INSERT INTO public.locations (id, name) SELECT md5('pl' || i)::uuid, 'P Club ' || i FROM generate_series(1, 2) i
        ON CONFLICT DO NOTHING;
      INSERT INTO public.academy_locations SELECT '${P}', md5('pl' || i)::uuid, true FROM generate_series(1, 2) i
        WHERE NOT EXISTS (SELECT 1 FROM public.academy_locations WHERE academy_profile_id = '${P}');
      INSERT INTO public.guest_players (id, academy_profile_id, full_name, email)
        SELECT md5('pg' || i)::uuid, '${P}', 'P Person ' || i, 'p' || i || '@x.nl' FROM generate_series(${from}, ${from + people - 1}) i;
      INSERT INTO public.availability_slots (id, trainer_id, academy_profile_id, location_id, start_time, end_time)
        SELECT md5('ps' || i || '-' || k)::uuid, '${TS}', '${P}', md5('pl' || (1 + k % 2))::uuid,
               now() + (k - 4) * interval '7 days', now() + (k - 4) * interval '7 days' + interval '1 hour'
          FROM generate_series(${from}, ${from + people - 1}) i, generate_series(0, 5) k;
      INSERT INTO public.bookings (slot_id, guest_player_id, status)
        SELECT md5('ps' || i || '-' || k)::uuid, md5('pg' || i)::uuid, CASE WHEN k = 1 THEN 'cancelled' ELSE 'confirmed' END
          FROM generate_series(${from}, ${from + people - 1}) i, generate_series(0, 5) k;
    `);
  }
  async function timeAuthority(): Promise<number> {
    const runs: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const t0 = performance.now();
      await asUser(MGR_P, () => db.query(
        `SELECT count(*) FROM players_private.players_overview_rows('academy', $1, NULL, $2::jsonb, 'name', 'asc', 20000, 0, false)`,
        [P, '{}']));
      runs.push(performance.now() - t0);
    }
    return runs.sort((x, y) => x - y)[1];
  }
  async function timeExport(): Promise<{ ms: number; total: number }> {
    const runs: number[] = [];
    let total = 0;
    for (let i = 0; i < 3; i += 1) {
      const t0 = performance.now();
      total = (await exportCall(MGR_P, P)).total;
      runs.push(performance.now() - t0);
    }
    return { ms: runs.sort((x, y) => x - y)[1], total };
  }

  it('4x the people costs well under the 16x of a quadratic plan (linear; headroom for an index-less WASM engine and timer noise)', async () => {
    // warm the connection's plan cache on ANOTHER academy first: a reused generic plan was the measured
    // superlinear failure mode (fixed by plan_cache_mode = force_custom_plan)
    for (let i = 0; i < 8; i += 1) await exportCall(MGR_A, A);
    await seed(1000, 1);
    const small = await timeExport();
    const smallAuth = await timeAuthority();
    await seed(3000, 1001);
    const large = await timeExport();
    const largeAuth = await timeAuthority();
    console.log(`authority alone: ${smallAuth.toFixed(0)} ms -> ${largeAuth.toFixed(0)} ms (x${(largeAuth / smallAuth).toFixed(2)})`);
    expect(small.total).toBe(1000);
    expect(large.total).toBe(4000);
    const sample = byId((await exportCall(MGR_P, P)).rows).get(
      (await db.query<{ id: string }>(`SELECT md5('pg1')::uuid::text AS id`)).rows[0].id)!;
    expect(sample).toMatchObject({ past_bookings_count: 3, currently_training: true, location_names: ['P Club 1', 'P Club 2'] });
    console.log(`export median: 1000 people ${small.ms.toFixed(0)} ms, 4000 people ${large.ms.toFixed(0)} ms (x${(large.ms / small.ms).toFixed(2)})`);
    expect(large.ms / small.ms).toBeLessThan(8);
    expect(largeAuth).toBeGreaterThan(0);
  }, 300_000);
});
