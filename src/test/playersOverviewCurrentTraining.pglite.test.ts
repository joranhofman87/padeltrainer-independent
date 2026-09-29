// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// PTF-OPTION-A — get_players_overview `current_training` / `training_location_id` keys, academy
// membership A1 and the one-call export E1, proven on the REAL migration chain (the overview's existing
// harness + 20261208100000) against the effective functions, not the UI. Tom's option A: ongoing cycles
// + upcoming standalone sessions count; a cycle that has not started does not. One qualifying-session
// predicate drives both keys. A1: an academy sees a side only through its own guests, its own sessions
// and its own metadata — never through a shared trainer. The canonical body runs first on the same data,
// so the A1 difference and the unchanged trainer scope are measured, not assumed.
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
// registered-only profile booked on an A session of shared trainer TS: the canonical body showed it to
// BOTH academies (trainer union); under A1 only A sees it
const PR = '9b000000-0000-0000-0000-000000000030';
// unmerged family: parent profile books the child's guest seat (dual-keyed) — FAM-02: that session is
// the CHILD's training, never the parent's (the parent is still listed via the dual-keyed booking)
const P_PARENT = '9b000000-0000-0000-0000-000000000040';
const G_CHILD = G(40);

// ── A1 membership fixture (decision packet §1.6). T2 trains for A and B but has sessions only at B. ──
const T2 = 'c0000000-0000-0000-0000-000000000072';
const S_T2_B = S(20);                                  // T2's past session for academy B
const XG = (n: number) => `7a000000-0000-0000-0000-${String(n).padStart(12, '0')}`; // adversarial guests
const XP = (n: number) => `7b000000-0000-0000-0000-${String(n).padStart(12, '0')}`; // adversarial profiles
const LG = (n: number) => `7c000000-0000-0000-0000-${String(n).padStart(12, '0')}`; // legitimate guests
const LP = (n: number) => `7d000000-0000-0000-0000-${String(n).padStart(12, '0')}`; // legitimate profiles
// adversarial — each must be ABSENT from A under every filter and from A's export
const X1_PROFILE_B_SLOT = XP(1);   // 1. booked only on a B-owned session of shared trainer TS
const X2_T_GUEST = XG(2);          // 2. TS's independent guest (no academy, no A booking/metadata)
const X3_B_GUEST = XG(3);          // 3. B-owned guest of TS, booked on a B session
const X4_B_META_GUEST = XG(4);     // 4. TS's guest linked only by a B metadata row
const X5_PROFILE_INDEP = XP(5);    // 5. booked only on TS's independent (unstamped) session
const X6_PROFILE = XP(6);          // 6. merged person: A-side profile (booked on an A session) …
const X6_B_GUEST = XG(6);          //    … + a B-owned guest side with its own name / email / phone
const X7_GUEST = XG(7);            // 7. only pending / cancelled bookings on A sessions
const X7_PROFILE = XP(7);          //    only a cancelled booking on an A session
const ADVERSARIAL = [X1_PROFILE_B_SLOT, X2_T_GUEST, X3_B_GUEST, X4_B_META_GUEST, X5_PROFILE_INDEP, X6_B_GUEST, X7_GUEST, X7_PROFILE];
// legitimate — each must be PRESENT in A
const L9_A_GUEST = LG(9);          // 9. A-owned guest, no bookings
const L10_T_GUEST_ON_A = LG(10);   // 10. TS's guest booked (completed) on an A session
const L11_META_GUEST = LG(11);     // 11. guest linked only by an A metadata row
const L12_PROFILE_ON_A = LP(12);   // 12. profile booked on an A session
const L14_REMOVED_GUEST = LG(14);  // 14. soft-removed in A: still hidden
const L14_REMOVED_PROFILE = LP(14);

type Row = {
  player_key: string; person_id: string; guest_player_id: string | null; profile_id: string | null;
  full_name: string; email: string; phone: string; has_active_cyclus: boolean; email_undeliverable: boolean;
  trainer_ids: string[]; total_count: string | number;
};
type CallOpts = {
  scope?: 'academy' | 'trainer'; scopeId?: string; limit?: number; offset?: number;
  search?: string | null; sort?: string; dir?: string;
};

async function asUser<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET test.uid = '${uid}';`);
  try {
    return await fn();
  } finally {
    await db.exec(`SET test.uid = '';`);
  }
}

async function call(uid: string, filters: Record<string, unknown>, opts: CallOpts = {}): Promise<Row[]> {
  return asUser(uid, async () => (await db.query<Row>(
    `SELECT * FROM public.get_players_overview($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
    [opts.scope ?? 'academy', opts.scopeId ?? A, opts.search ?? null, JSON.stringify(filters),
      opts.sort ?? 'name', opts.dir ?? 'asc', opts.limit ?? 500, opts.offset ?? 0],
  )).rows);
}

type ExportRow = { person_id: string; full_name: string; email: string; phone: string };
async function exportCall(
  uid: string, filters: Record<string, unknown>, opts: { academy?: string; search?: string | null; sort?: string; dir?: string } = {},
): Promise<{ total: number; rows: ExportRow[] }> {
  return asUser(uid, async () => {
    const { rows } = await db.query<{ total: string | number; rows: ExportRow[] }>(
      `SELECT * FROM public.get_players_overview_export($1, $2, $3::jsonb, $4, $5)`,
      [opts.academy ?? A, opts.search ?? null, JSON.stringify(filters), opts.sort ?? 'name', opts.dir ?? 'asc'],
    );
    expect(rows).toHaveLength(1); // always ONE row
    return { total: Number(rows[0].total), rows: rows[0].rows };
  });
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
      -- registered-only profile: an A-owned session of shared trainer TS
      ('${S_ON_NEXT}',  NULL,                   '${PR}', 'confirmed'),
      ('${S_ON_NEXT}',  '${G_CHILD}',           '${P_PARENT}', 'confirmed');
  `);

  // A1 membership fixture (decision packet §1.6)
  await db.exec(`
    INSERT INTO public.trainer_profiles VALUES ('${T2}', NULL);
    INSERT INTO public.academy_trainers VALUES ('${A}', '${T2}', 'active'), ('${B}', '${T2}', 'active');
    INSERT INTO public.availability_slots (id, trainer_id, academy_profile_id, location_id, cyclus_id, start_time, end_time) VALUES
      ('${S_T2_B}', '${T2}', '${B}', '${LOC_B}', NULL, now() - interval '3 days', now() - interval '3 days' + interval '1 hour');
    INSERT INTO public.guest_players (id, trainer_id, academy_profile_id, full_name, email, phone) VALUES
      ('${X2_T_GUEST}',          '${TS}', NULL,   'Adv Trainer Guest',   'adv2@x.nl',     NULL),
      ('${X3_B_GUEST}',          '${TS}', '${B}', 'Adv B Guest',         'adv3@x.nl',     NULL),
      ('${X4_B_META_GUEST}',     '${TS}', NULL,   'Adv B Meta Guest',    'adv4@x.nl',     NULL),
      ('${X6_B_GUEST}',          '${TS}', '${B}', 'Secret B Side',       'secret-b@x.nl', '0699999999'),
      ('${X7_GUEST}',            NULL,    NULL,   'Adv Pending Guest',   'adv7@x.nl',     NULL),
      ('${L9_A_GUEST}',          NULL,    '${A}', 'Legit No Bookings',   'l9@x.nl',       NULL),
      ('${L10_T_GUEST_ON_A}',    '${TS}', NULL,   'Legit T Guest On A',  'l10@x.nl',      NULL),
      ('${L11_META_GUEST}',      NULL,    NULL,   'Legit Meta Guest',    'l11@x.nl',      NULL),
      ('${L14_REMOVED_GUEST}',   NULL,    '${A}', 'Legit Removed Guest', 'l14@x.nl',      NULL);
    INSERT INTO public.profiles (id, full_name, email) VALUES
      ('${X1_PROFILE_B_SLOT}',   'Adv Profile B Slot',    'adv1@x.nl'),
      ('${X5_PROFILE_INDEP}',    'Adv Profile Indep',     'adv5@x.nl'),
      ('${X6_PROFILE}',          'Merged A Profile',      'p6@x.nl'),
      ('${X7_PROFILE}',          'Adv Cancelled Profile', 'adv7p@x.nl'),
      ('${L12_PROFILE_ON_A}',    'Legit Profile On A',    'l12@x.nl'),
      ('${L14_REMOVED_PROFILE}', 'Legit Removed Profile', 'l14p@x.nl');
    INSERT INTO public.persons (id, full_name, email, user_id) VALUES
      ('${X6_PROFILE}', 'Merged Person Six', 'p6@x.nl', '${X6_PROFILE}');
    INSERT INTO public.person_links (person_id, profile_id) VALUES ('${X6_PROFILE}', '${X6_PROFILE}');
    INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${X6_PROFILE}', '${X6_B_GUEST}');
    INSERT INTO public.email_address_state (email, state) VALUES ('secret-b@x.nl', 'hard_bounced');
    INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id, profile_id, notes, removed_at) VALUES
      ('${B}', '${X4_B_META_GUEST}',   NULL,                       'b note', NULL),
      ('${A}', '${L11_META_GUEST}',    NULL,                       'a note', NULL),
      ('${A}', '${L14_REMOVED_GUEST}', NULL,                       NULL,     now()),
      ('${A}', NULL,                   '${L14_REMOVED_PROFILE}',   NULL,     now());
    INSERT INTO public.bookings (slot_id, guest_player_id, player_id, status) VALUES
      ('${S_B_PAST}',   NULL,                    '${X1_PROFILE_B_SLOT}',   'completed'),
      ('${S_INDEP}',    '${X2_T_GUEST}',         NULL,                     'confirmed'),
      ('${S_B_PAST}',   '${X3_B_GUEST}',         NULL,                     'completed'),
      ('${S_INDEP}',    NULL,                    '${X5_PROFILE_INDEP}',    'confirmed'),
      ('${S_ON_PAST}',  NULL,                    '${X6_PROFILE}',          'completed'),
      ('${S_B_PAST}',   '${X6_B_GUEST}',         NULL,                     'completed'),
      ('${S_ON_NEXT}',  '${X7_GUEST}',           NULL,                     'pending'),
      ('${S_SA_FAR}',   '${X7_GUEST}',           NULL,                     'cancelled'),
      ('${S_ON_NEXT}',  NULL,                    '${X7_PROFILE}',          'cancelled'),
      ('${S_SA_ENDED}', '${L10_T_GUEST_ON_A}',   NULL,                     'completed'),
      ('${S_ON_PAST}',  NULL,                    '${L12_PROFILE_ON_A}',    'completed'),
      ('${S_ON_PAST}',  NULL,                    '${L14_REMOVED_PROFILE}', 'completed'),
      ('${S_T2_B}',     '${G_ONGOING}',          NULL,                     'completed');
  `);

  const migration = (f: string) =>
    readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8')
      .split('\n').filter((l) => !/^(REVOKE|GRANT)\b/.test(l)).join('\n');
  for (const f of [
    '20260827100000_phase32_players_overview_person_dedup.sql',
    '20260901110000_phase33e_overview_type_has_login.sql',
    '20261006120000_readers_canonical_is_suppressed.sql',
  ]) await db.exec(migration(f));
  before = await snapshot(); // the canonical (live) body on the same data
  await db.exec(migration('20261208100000_players_overview_current_training.sql')); // under test
});

// Trainer-scope calls compared byte-for-byte before/after (case 16): every sort, paging and filter.
const TRAINER_CALLS: Array<[string, Record<string, unknown>, CallOpts]> = [
  ['name asc', {}, {}],
  ['name desc', {}, { dir: 'desc' }],
  ['email asc', {}, { sort: 'email' }],
  ['email desc', {}, { sort: 'email', dir: 'desc' }],
  ['skill asc', {}, { sort: 'skill' }],
  ['created desc', {}, { sort: 'created_at', dir: 'desc' }],
  ['page 2 of 3', {}, { limit: 3, offset: 3 }],
  ['trainer filter', { trainer_id: TS }, {}],
  ['club chip', { location_id: LOC_A1 }, {}],
  ['active cycle', { has_active_cyclus: true }, {}],
  ['no active cycle', { has_active_cyclus: false }, {}],
  ['payment ok', { payment: 'ok' }, {}],
  ['untagged', { tag_id: 'untagged' }, {}],
  ['unrated', { level_unrated: true }, {}],
  ['search text', {}, { search: 'adv' }],
  ['search digits', {}, { search: '0699' }],
];
async function snapshot() {
  const trainer: Record<string, Row[]> = {};
  for (const [label, filters, opts] of TRAINER_CALLS) {
    trainer[label] = await call(TS_USER, filters, { ...opts, scope: 'trainer', scopeId: TS });
  }
  return {
    trainer,
    a: await call(MGR_A, {}),
    b: await call(MGR_B, {}, { scopeId: B }),
    aTrainerT2: await call(MGR_A, { trainer_id: T2 }),
    aSearchSecret: await call(MGR_A, {}, { search: 'secret-b' }),
  };
}
let before: Awaited<ReturnType<typeof snapshot>>;
const ids = (rows: Row[]) => rows.flatMap((r) => [r.person_id, r.guest_player_id, r.profile_id]).filter(Boolean);

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

  it("B sees only B-owned training; A's session no longer admits a person to B (A1)", async () => {
    expect(names(before.b)).toContain('Registered Shared'); // the canonical trainer-union leak …
    const bAll = names(await call(MGR_B, {}, { scopeId: B }));
    expect(bAll).not.toContain('Registered Shared');       // … closed: PR only ever booked A's sessions
    const bTraining = names(await call(MGR_B, { current_training: true }, { scopeId: B }));
    // A's guest G_B_ONLY holds a confirmed booking on B's ongoing cycle, so B now sees it (A1 booking arm)
    expect(bTraining).toEqual(['B Own Guest', 'Trains At B']);
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

// ── A1: academy membership through the academy's own guests, sessions and metadata only ──────────────
const EVERY_FILTER: Array<Record<string, unknown>> = [
  {}, { current_training: false }, { current_training: true }, { training_location_id: LOC_A1 },
  { location_id: LOC_A1 }, { location_id: LOC_B }, { trainer_id: TS }, { has_active_cyclus: true },
  { has_active_cyclus: false }, { payment: 'ok' }, { payment: 'overdue' }, { tag_id: 'untagged' },
  { level_unrated: true },
];
const personIds = (rows: Array<{ person_id: string }>) => rows.map((r) => r.person_id);

describe('A1 — academy membership (decision packet §1.6)', () => {
  it('the canonical body admitted every adversarial side to A through the shared trainer (the defect)', () => {
    const leaked = new Set(ids(before.a));
    for (const x of [X1_PROFILE_B_SLOT, X2_T_GUEST, X3_B_GUEST, X4_B_META_GUEST, X5_PROFILE_INDEP, X6_B_GUEST]) {
      expect(leaked.has(x)).toBe(true);
    }
  });

  it('cases 1–7: no adversarial side reaches A under any filter or search', async () => {
    for (const filters of EVERY_FILTER) {
      for (const search of [null, 'adv', 'secret', '0699']) {
        const rows = await call(MGR_A, filters, { search });
        const leaked = ids(rows).filter((id) => ADVERSARIAL.includes(id));
        expect(leaked, `${JSON.stringify(filters)} search=${search}`).toEqual([]);
      }
    }
  });

  it("cases 1–7: nor A's export, under the complement filter and a search", async () => {
    for (const filters of [{}, { current_training: false }]) {
      for (const search of [null, 'adv']) {
        const { rows } = await exportCall(MGR_A, filters, { search });
        expect(personIds(rows).filter((id) => ADVERSARIAL.includes(id))).toEqual([]);
      }
    }
  });

  it('case 6: a merged person shows only its A side — no B name, email, phone or bounce', async () => {
    const was = before.a.find((r) => r.person_id === X6_PROFILE)!;
    expect(was.guest_player_id).toBe(X6_B_GUEST);        // canonical: B's guest side was folded in …
    expect(was.email_undeliverable).toBe(true);          // … with B's bounce
    expect(names(before.aSearchSecret)).toEqual(['Merged Person Six']); // … and B's email searchable

    const rows = (await call(MGR_A, {})).filter((r) => r.person_id === X6_PROFILE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      guest_player_id: null, profile_id: X6_PROFILE, full_name: 'Merged A Profile', email: 'p6@x.nl', phone: '',
      email_undeliverable: false,
    });
    for (const search of ['secret-b', 'Secret B', '0699999999']) expect(await call(MGR_A, {}, { search })).toEqual([]);
    const exported = (await exportCall(MGR_A, {})).rows.find((r) => r.person_id === X6_PROFILE);
    expect(exported).toEqual({ person_id: X6_PROFILE, full_name: 'Merged A Profile', email: 'p6@x.nl', phone: '' });
    // symmetric: B sees its own guest side of the same person and nothing of A's profile side
    const inB = (await call(MGR_B, {}, { scopeId: B })).filter((r) => r.person_id === X6_PROFILE);
    expect(inB).toHaveLength(1);
    expect(inB[0]).toMatchObject({ guest_player_id: X6_B_GUEST, profile_id: null, email: 'secret-b@x.nl' });
  });

  it('case 7: pending and cancelled bookings on A sessions admit nobody', async () => {
    const all = ids(await call(MGR_A, {}));
    expect(all).not.toContain(X7_GUEST);
    expect(all).not.toContain(X7_PROFILE);
  });

  it('case 8: callers — another academy, a stranger, anonymous (42501); trainer scope refuses training keys (22023)', async () => {
    for (const uid of [MGR_B, STRANGER, '']) {
      expect(await errCode(call(uid, {}))).toBe('42501');
      expect(await errCode(exportCall(uid, {}))).toBe('42501');
    }
    expect(await errCode(call(TS_USER, { current_training: false }, { scope: 'trainer', scopeId: TS }))).toBe('22023');
  });

  it('cases 9–13: legitimate sides are present, in the list and the export', async () => {
    const list = await call(MGR_A, {});
    const exported = personIds((await exportCall(MGR_A, {})).rows);
    for (const id of [L9_A_GUEST, L10_T_GUEST_ON_A, L11_META_GUEST, L12_PROFILE_ON_A, X6_PROFILE, PM]) {
      expect(personIds(list)).toContain(id);
      expect(exported).toContain(id);
    }
    // 13: the merged guest-A + profile is ONE row keyed by the canonical person
    const merged = list.filter((r) => r.person_id === PM);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ guest_player_id: GM, profile_id: PM });
  });

  it('case 14: a soft-removed guest or profile stays hidden', async () => {
    const all = [...ids(await call(MGR_A, {})), ...personIds((await exportCall(MGR_A, {})).rows)];
    expect(all).not.toContain(L14_REMOVED_GUEST);
    expect(all).not.toContain(L14_REMOVED_PROFILE);
  });

  it("case 15: the trainer filter asks for that trainer's activity inside A only", async () => {
    expect(names(before.aTrainerT2)).toEqual(['Ongoing Cycle']); // canonical: T2's B session counted for A
    expect(await call(MGR_A, { trainer_id: T2 })).toEqual([]);    // A1: T2 has no A session
    const withTs = personIds(await call(MGR_A, { trainer_id: TS }));
    expect(withTs).toEqual(expect.arrayContaining([L10_T_GUEST_ON_A, PR, L12_PROFILE_ON_A]));
    for (const x of ADVERSARIAL) expect(withTs).not.toContain(x);
  });

  it('case 16: trainer scope is byte-for-byte unchanged (every sort, page and filter)', async () => {
    for (const [label, filters, opts] of TRAINER_CALLS) {
      const now = await call(TS_USER, filters, { ...opts, scope: 'trainer', scopeId: TS });
      expect(now, label).toEqual(before.trainer[label]);
      expect(now.length, label).toBeGreaterThan(0);
    }
  });

  it("A's universe differs from the canonical one exactly by the A1 rule", async () => {
    const was = new Set(personIds(before.a));
    const now = new Set(personIds(await call(MGR_A, {})));
    const dropped = [...was].filter((id) => !now.has(id)).sort();
    const added = [...now].filter((id) => !was.has(id)).sort();
    // X6's B guest side is folded into X6's profile person, which stays (with its A side only)
    expect(dropped).toEqual([X1_PROFILE_B_SLOT, X2_T_GUEST, X3_B_GUEST, X4_B_META_GUEST, X5_PROFILE_INDEP].sort());
    expect(added).toEqual([L11_META_GUEST]); // metadata link: a relationship the canonical body ignored
  });

  it("B's universe is B's own guests, sessions and metadata", async () => {
    expect(names(await call(MGR_B, {}, { scopeId: B }))).toEqual([
      'Adv B Guest', 'Adv B Meta Guest', 'Adv Profile B Slot', 'B Own Guest', 'Ongoing Cycle', 'Secret B Side', 'Trains At B',
    ]);
  });

  it("booking-derived chips read A's own sessions (a B cycle is not A's active cycle)", async () => {
    const was = before.a.find((r) => r.person_id === G_B_ONLY)!;
    const now = (await call(MGR_A, {})).find((r) => r.person_id === G_B_ONLY)!;
    expect(was.has_active_cyclus).toBe(true);   // canonical: B's cycle, via the shared trainer
    expect(now.has_active_cyclus).toBe(false);
    expect(was.trainer_ids).toEqual([TS]);
    expect(now.trainer_ids).toEqual([]);
  });
});

// ── E1: the export is the list's own authority, evaluated once ───────────────────────────────────────
describe('E1 — get_players_overview_export', () => {
  const COMBOS: Array<[Record<string, unknown>, CallOpts]> = [
    [{}, {}], [{}, { dir: 'desc' }], [{}, { sort: 'email' }], [{}, { sort: 'email', dir: 'desc' }],
    [{}, { sort: 'skill' }], [{}, { sort: 'created_at', dir: 'desc' }], [{ current_training: true }, {}],
    [{ current_training: false }, { sort: 'email' }], [{ training_location_id: LOC_A1 }, {}],
    [{ trainer_id: TS }, {}], [{}, { search: 'a' }], [{ current_training: true }, { search: 'cycle' }],
  ];

  it('returns exactly the list: same people, same order, same name / email / phone, same total', async () => {
    for (const [filters, opts] of COMBOS) {
      const list = await call(MGR_A, filters, { ...opts, limit: 500 });
      const exp = await exportCall(MGR_A, filters, { search: opts.search, sort: opts.sort, dir: opts.dir });
      const label = JSON.stringify([filters, opts]);
      expect(exp.total, label).toBe(list.length);
      expect(exp.rows, label).toEqual(list.map((r) => ({ person_id: r.person_id, full_name: r.full_name, email: r.email, phone: r.phone })));
      if (list.length) expect(Number(list[0].total_count), label).toBe(exp.total);
    }
  });

  it('list pages partition the export order exactly', async () => {
    const exp = await exportCall(MGR_A, {}, { sort: 'email', dir: 'desc' });
    const paged: string[] = [];
    for (let offset = 0; offset < exp.total; offset += 3) {
      paged.push(...personIds(await call(MGR_A, {}, { sort: 'email', dir: 'desc', limit: 3, offset })));
    }
    expect(paged).toEqual(personIds(exp.rows));
  });

  it('an empty match is still ONE row: total 0 and an empty array', async () => {
    expect(await exportCall(MGR_A, {}, { search: 'nobody-matches-this' })).toEqual({ total: 0, rows: [] });
  });

  it('a NULL academy is refused, not treated as "all"', async () => {
    expect(await errCode(asUser(MGR_A, () => db.query(
      `SELECT * FROM public.get_players_overview_export(NULL, NULL, '{}'::jsonb, 'name', 'asc')`)))).toBe('42501');
  });
});

describe('E1 — authorization at every entry, and the private authority', () => {
  const authority = (scope: string, scopeId: string, limit = 10, offset = 0, enrich: boolean | null = true) =>
    db.query(`SELECT * FROM players_private.players_overview_rows($1, $2, NULL, '{}'::jsonb, 'name', 'asc', $3, $4, $5)`,
      [scope, scopeId, limit, offset, enrich]);

  it('the authority re-checks authorization itself when called directly', async () => {
    expect(await errCode(asUser(STRANGER, () => authority('academy', A)))).toBe('42501');
    expect(await errCode(asUser(MGR_B, () => authority('academy', A)))).toBe('42501');
    expect(await errCode(asUser(STRANGER, () => authority('trainer', TS)))).toBe('42501');
    expect(await errCode(asUser(MGR_A, () => authority('nonsense', A)))).not.toBe('no error');
    expect((await asUser(MGR_A, () => authority('academy', A))).rows.length).toBeGreaterThan(0);
  });

  it('the page-only enrichment runs only when asked (the export skips it; identity and order are the same)', async () => {
    type AuthRow = { person_id: string; full_name: string; location_ids: string[]; trainer_ids: string[];
      has_active_cyclus: boolean; email_undeliverable: boolean; sort_ord: string | number };
    const run = async (enrich: boolean) => (await asUser(MGR_A, () => authority('academy', A, 500, 0, enrich))).rows as AuthRow[];
    const on = await run(true);
    const off = await run(false);
    expect(off.map((r) => [r.person_id, r.full_name, Number(r.sort_ord)])).toEqual(on.map((r) => [r.person_id, r.full_name, Number(r.sort_ord)]));
    const ongoingOn = on.find((r) => r.person_id === G_ONGOING)!;
    const ongoingOff = off.find((r) => r.person_id === G_ONGOING)!;
    expect(ongoingOn).toMatchObject({ location_ids: [LOC_A1], trainer_ids: [TS], has_active_cyclus: true });
    expect(ongoingOff).toMatchObject({ location_ids: [], trainer_ids: [], has_active_cyclus: false });
    expect(off.every((r) => r.location_ids.length === 0 && !r.has_active_cyclus && !r.email_undeliverable)).toBe(true);
  });

  it('the authority refuses a malformed window (22023)', async () => {
    for (const [limit, offset, enrich] of [[0, 0, true], [10, -1, true], [10, 0, null]] as const) {
      expect(await errCode(asUser(MGR_A, () => authority('academy', A, limit, offset, enrich)))).toBe('22023');
    }
  });

  it("each public entry refuses on its own, even with the authority's check removed", async () => {
    // Swap in a PERMISSIVE authority stub (same signature and return type) for this transaction only.
    const src = readFileSync(join(process.cwd(), 'supabase', 'migrations', '20261208100000_players_overview_current_training.sql'), 'utf8');
    const start = src.indexOf('CREATE OR REPLACE FUNCTION players_private.players_overview_rows(');
    const header = src.slice(start, src.indexOf('\nLANGUAGE plpgsql', start));
    const LIST = `SELECT person_id FROM public.get_players_overview($1, $2, NULL, '{}'::jsonb, 'name', 'asc', 50, 0)`;
    const EXPORT = `SELECT total FROM public.get_players_overview_export($1, NULL, '{}'::jsonb, 'name', 'asc')`;
    // each probe in its own savepoint: an expected refusal must not abort the stub's transaction
    const probe = async (uid: string, sql: string, params: unknown[]) => {
      await db.exec('SAVEPOINT probe');
      try {
        await db.exec(`SET LOCAL test.uid = '${uid}'`);
        return { code: 'no error', rows: (await db.query<{ person_id?: string }>(sql, params)).rows };
      } catch (e) {
        return { code: (e as { code?: string }).code ?? String(e), rows: [] };
      } finally {
        await db.exec('ROLLBACK TO SAVEPOINT probe');
      }
    };
    await db.exec('BEGIN');
    try {
      await db.exec(`${header}
        LANGUAGE plpgsql AS $stub$ BEGIN person_id := '${L9_A_GUEST}'; total_count := 1; sort_ord := 1; RETURN NEXT; END $stub$;`);
      const managerSees = await probe(MGR_A, LIST, ['academy', A]);
      expect(managerSees.rows.map((r) => r.person_id)).toEqual([L9_A_GUEST]); // the stub is what runs
      for (const uid of [STRANGER, MGR_B, '']) {
        expect((await probe(uid, LIST, ['academy', A])).code).toBe('42501');
        expect((await probe(uid, EXPORT, [A])).code).toBe('42501');
      }
      expect((await probe(STRANGER, LIST, ['trainer', TS])).code).toBe('42501');
    } finally {
      await db.exec('ROLLBACK');
    }
    expect((await call(MGR_A, {})).length).toBeGreaterThan(1); // the real authority is back
  });

  it('the list keeps its paging bounds (limit clamped to 1..500, offset to >= 0)', async () => {
    expect(await call(MGR_A, {}, { limit: 0 })).toHaveLength(1);
    const first = await call(MGR_A, {}, { limit: 2, offset: -5 });
    expect(personIds(first)).toEqual(personIds(await call(MGR_A, {}, { limit: 2, offset: 0 })));
  });
});

describe('E1 — the 20,000-row bound', () => {
  const C = 'cc0000aa-0000-0000-0000-00000000000c';
  const MGR_C = 'cc0000aa-0000-0000-0000-0000000000c1';

  it('more than 20,000 matches is refused (54000) with the real total; exactly 20,000 is exported', async () => {
    await db.exec(`
      INSERT INTO public.academy_profiles (id) VALUES ('${C}');
      INSERT INTO public.academy_managers VALUES ('${C}', '${MGR_C}');
      INSERT INTO public.guest_players (id, academy_profile_id, full_name, email)
        SELECT gen_random_uuid(), '${C}', 'Bulk ' || i, 'bulk' || i || '@x.nl' FROM generate_series(1, 20001) i;
    `);
    const err = await exportCall(MGR_C, {}, { academy: C }).catch((e: { code?: string; detail?: string }) => e);
    expect(err).toMatchObject({ code: '54000', detail: 'total=20001 max=20000' });

    await db.exec(`DELETE FROM public.guest_players WHERE id = (SELECT id FROM public.guest_players WHERE academy_profile_id = '${C}' LIMIT 1)`);
    const ok = await exportCall(MGR_C, {}, { academy: C });
    expect(ok.total).toBe(20000);
    expect(ok.rows).toHaveLength(20000);
    expect(new Set(personIds(ok.rows)).size).toBe(20000);
  }, 120_000);
});
