// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Task #30 (auth-hardening): public.is_cycle_member(uuid, uuid) is redefined GUEST-SAFE — it keys
// membership on the person (via guest_verified_account_profile, the same person_links → twin → linked
// + split-freeze precedence as can_book_member_window clause a), NOT the raw bookings.player_id — and
// is LOCKED to service_role (closing the anon/authenticated oracle). These tests prove:
//   (identity) a dual-key booking grants the guest's VERIFIED account and DENIES the raw parent (FAM-02),
//   (ACL) EXECUTE is service_role only, and no migration ever re-grants it to anon/authenticated.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

// profiles (p) + their auth user_id (u)
const OWNER = { p: '11111111-0000-0000-0000-000000000001', u: '11111111-0000-0000-0000-0000000000a1' }; // pure-profile member
const OTHER = { p: '11111111-0000-0000-0000-000000000002', u: '11111111-0000-0000-0000-0000000000a2' }; // no booking
const ACCT = { p: '11111111-0000-0000-0000-000000000003', u: '11111111-0000-0000-0000-0000000000a3' };  // guest's verified account
const PARENT = { p: '11111111-0000-0000-0000-000000000004', u: '11111111-0000-0000-0000-0000000000a4' };// raw dual-key player_id (captain)
const FACCT = { p: '11111111-0000-0000-0000-000000000005', u: '11111111-0000-0000-0000-0000000000a5' }; // split-frozen guest's account
const CANC = { p: '11111111-0000-0000-0000-000000000006', u: '11111111-0000-0000-0000-0000000000a6' };  // only a cancelled booking

const PER = '22222222-0000-0000-0000-000000000001';   // person linking GUEST → ACCT
const PERF = '22222222-0000-0000-0000-000000000002';  // person linking GUEST_FROZEN → FACCT
const GUEST = '33333333-0000-0000-0000-000000000001'; // dual-key guest, person_links → ACCT
const GUEST_FROZEN = '33333333-0000-0000-0000-000000000002'; // split-frozen guest → account resolves NULL

const CYCLE = '44444444-0000-0000-0000-000000000001';
const CYCLE2 = '44444444-0000-0000-0000-000000000002'; // exists, OWNER has NO booking here
const SLOT = '55555555-0000-0000-0000-000000000001';
const SLOT2 = '55555555-0000-0000-0000-000000000002';

const member = async (user: string, cycle: string) =>
  (await db.query<{ m: boolean }>(`SELECT public.is_cycle_member('${user}','${cycle}') AS m`)).rows[0].m;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;

    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY, twin_of_profile_id uuid, linked_profile_id uuid, split_frozen boolean DEFAULT false);
    CREATE TABLE public.person_links (person_id uuid, profile_id uuid, guest_player_id uuid);
    CREATE TABLE public.cycles (id uuid PRIMARY KEY);
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, cyclus_id uuid);
    CREATE TABLE public.bookings (id uuid PRIMARY KEY, slot_id uuid, player_id uuid, guest_player_id uuid, status text);

    -- guest identity resolvers (prod: 20260927100000; inlined here, same person_links → twin → linked,
    -- split-freeze body that guest_verified_account_profile has in prod).
    CREATE FUNCTION public.is_guest_split_frozen(_guest_id uuid)
      RETURNS boolean LANGUAGE sql STABLE AS $f$
        SELECT COALESCE((SELECT split_frozen FROM public.guest_players WHERE id = _guest_id), false) $f$;
    CREATE FUNCTION public.guest_verified_account_profile(_guest_id uuid)
      RETURNS uuid LANGUAGE sql STABLE AS $g$
        SELECT CASE WHEN public.is_guest_split_frozen(_guest_id) THEN NULL ELSE COALESCE(
          (SELECT plp.profile_id FROM public.person_links plg JOIN public.person_links plp ON plp.person_id = plg.person_id
            WHERE plg.guest_player_id = _guest_id AND plp.profile_id IS NOT NULL LIMIT 1),
          (SELECT gp.twin_of_profile_id FROM public.guest_players gp WHERE gp.id = _guest_id),
          (SELECT gp.linked_profile_id FROM public.guest_players gp WHERE gp.id = _guest_id AND gp.twin_of_profile_id IS NULL)
        ) END $g$;

    INSERT INTO public.profiles (id, user_id) VALUES
      ('${OWNER.p}','${OWNER.u}'), ('${OTHER.p}','${OTHER.u}'), ('${ACCT.p}','${ACCT.u}'),
      ('${PARENT.p}','${PARENT.u}'), ('${FACCT.p}','${FACCT.u}'), ('${CANC.p}','${CANC.u}');
    INSERT INTO public.cycles (id) VALUES ('${CYCLE}'), ('${CYCLE2}');
    INSERT INTO public.availability_slots (id, cyclus_id) VALUES ('${SLOT}','${CYCLE}'), ('${SLOT2}','${CYCLE2}');
    INSERT INTO public.guest_players (id, split_frozen) VALUES ('${GUEST}', false), ('${GUEST_FROZEN}', true);

    -- GUEST → person PER → account ACCT (verified account = ACCT)
    INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PER}','${GUEST}');
    INSERT INTO public.person_links (person_id, profile_id)      VALUES ('${PER}','${ACCT.p}');
    -- GUEST_FROZEN → person PERF → account FACCT, but split-frozen ⇒ resolves to NULL
    INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PERF}','${GUEST_FROZEN}');
    INSERT INTO public.person_links (person_id, profile_id)      VALUES ('${PERF}','${FACCT.p}');

    INSERT INTO public.bookings (id, slot_id, player_id, guest_player_id, status) VALUES
      ('66666666-0000-0000-0000-000000000001','${SLOT}','${OWNER.p}', NULL, 'confirmed'),                 -- pure-profile member
      ('66666666-0000-0000-0000-000000000002','${SLOT}','${PARENT.p}','${GUEST}', 'confirmed'),           -- dual-key: raw parent + guest→ACCT
      ('66666666-0000-0000-0000-000000000003','${SLOT}','${PARENT.p}','${GUEST_FROZEN}', 'confirmed'),    -- dual-key: split-frozen guest
      ('66666666-0000-0000-0000-000000000004','${SLOT}','${CANC.p}', NULL, 'cancelled');                  -- cancelled only
  `);
  // The migration under test (WITH its REVOKE/GRANT, so the ACL assertions are real).
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20261001100000_is_cycle_member_guest_safe_lockdown.sql'), 'utf8'));
});

describe('is_cycle_member — guest-safe identity (task #30)', () => {
  it('a pure-profile booking → the owner is a member; a stranger is not', async () => {
    expect(await member(OWNER.u, CYCLE)).toBe(true);
    expect(await member(OTHER.u, CYCLE)).toBe(false);
  });

  it("FAM-02: a dual-key booking grants the guest's VERIFIED account and DENIES the raw parent", async () => {
    expect(await member(ACCT.u, CYCLE)).toBe(true);    // guest → person_links → ACCT
    expect(await member(PARENT.u, CYCLE)).toBe(false); // the raw player_id is NOT identity proof
  });

  it('a split-frozen guest resolves to no account → grants nobody via the guest arm', async () => {
    expect(await member(FACCT.u, CYCLE)).toBe(false);
  });

  it('a cancelled booking does not confer membership', async () => {
    expect(await member(CANC.u, CYCLE)).toBe(false);
  });

  it('membership is per-cycle (a member of one cycle is not a member of another)', async () => {
    expect(await member(OWNER.u, CYCLE)).toBe(true);
    expect(await member(OWNER.u, CYCLE2)).toBe(false); // OWNER has no booking in CYCLE2
  });

  it('an unknown user id is not a member (empty me → no match)', async () => {
    expect(await member('99999999-0000-0000-0000-0000000000ff', CYCLE)).toBe(false);
  });
});

describe('is_cycle_member — ACL lockdown (oracle closed)', () => {
  it('EXECUTE is service_role only — anon + authenticated are revoked', async () => {
    const r = (await db.query<{ anon: boolean; auth: boolean; svc: boolean }>(`
      SELECT has_function_privilege('anon','public.is_cycle_member(uuid,uuid)','EXECUTE') AS anon,
             has_function_privilege('authenticated','public.is_cycle_member(uuid,uuid)','EXECUTE') AS auth,
             has_function_privilege('service_role','public.is_cycle_member(uuid,uuid)','EXECUTE') AS svc`)).rows[0];
    expect(r.anon).toBe(false);
    expect(r.auth).toBe(false);
    expect(r.svc).toBe(true);
  });

  it('no migration ever GRANTs is_cycle_member to anon/authenticated (defense-in-depth textual guard)', () => {
    const dir = join(process.cwd(), 'supabase', 'migrations');
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
        if (/\bGRANT\b/i.test(line) && /is_cycle_member/i.test(line) && /\b(anon|authenticated)\b/i.test(line)) {
          offenders.push(`${f}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
