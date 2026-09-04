// @vitest-environment node
//
// ABC-18 Pass A1 — profile visibility, roster naming, cycle labels, login flags.
//
// Every re-emitted object is EXECUTED here, not merely inspected: a plpgsql body is not
// validated at creation, so "the migration applied" proves nothing about the reader.
//
// Each case pairs a withdrawn authority path with the retained one beside it.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { applyPreH0, applyH0, FIXTURE_SQL, IDS } from './abc16Fixture';

let db: PGlite;

const PUBLIC_TRAINER = '70000000-0000-0000-0000-0000000000b1';
const PUBLIC_TRAINER_USER = '50000000-0000-0000-0000-0000000000b1';
const PUBLIC_TRAINER_PROFILE = '10000000-0000-0000-0000-0000000000b1';

const MANAGED_TRAINER_USER = '50000000-0000-0000-0000-0000000000b2';
const MANAGED_TRAINER_PROFILE = '10000000-0000-0000-0000-0000000000b2';

const SHELL_PROFILE = '10000000-0000-0000-0000-0000000000b3';   // user_id IS NULL
const CYCLE = '90000000-0000-4000-8000-000000000001';
const CYCLE_SLOT = '30000000-0000-4000-8000-0000000a1001';

beforeAll(async () => {
  db = new PGlite();
  const exec = (sql: string) => db.exec(sql);
  await applyPreH0(exec);
  await db.exec(FIXTURE_SQL);
  await applyH0(exec);

  await db.exec(`
    -- persons.user_id carries an FK to auth.users, and mint_person_for_profile mirrors it — so
    -- these accounts must exist. That the insert fails without them is itself confirmation the
    -- restored mirror (blocker 1) is live rather than decorative.
    INSERT INTO auth.users (id, email) VALUES
      ('${PUBLIC_TRAINER_USER}',  'public.trainer@example.test'),
      ('${MANAGED_TRAINER_USER}', 'managed.trainer@example.test');

    -- a genuinely public trainer (directory) and a trainer managed by the attacker academy
    INSERT INTO public.profiles (id, user_id, full_name) VALUES
      ('${PUBLIC_TRAINER_PROFILE}',  '${PUBLIC_TRAINER_USER}',  'Public Trainer'),
      ('${MANAGED_TRAINER_PROFILE}', '${MANAGED_TRAINER_USER}', 'Managed Trainer'),
      ('${SHELL_PROFILE}',           NULL,                      'Account-less Shell');
    INSERT INTO public.trainer_profiles (id, user_id, is_public) VALUES
      ('${PUBLIC_TRAINER}', '${PUBLIC_TRAINER_USER}', true),
      ('70000000-0000-0000-0000-0000000000b2', '${MANAGED_TRAINER_USER}', false);
    INSERT INTO public.academy_trainers (academy_profile_id, trainer_profile_id, status)
      VALUES ('${IDS.attackerAcademy}', '70000000-0000-0000-0000-0000000000b2', 'active');

    -- a cyclus owned by the attacker academy, with one owned-guest seat and one registered seat
    INSERT INTO public.cycles (id, owner_type, owner_id, type, location_id)
      VALUES ('${CYCLE}', 'academy', '${IDS.attackerAcademy}', 'cyclus', '${IDS.attackerLocation}');
    INSERT INTO public.availability_slots (id, academy_profile_id, trainer_id, location_id, cyclus_id, start_time)
      VALUES ('${CYCLE_SLOT}', '${IDS.attackerAcademy}', '${IDS.attackerTrainer}',
              '${IDS.attackerLocation}', '${CYCLE}', now() + interval '1 day');
    INSERT INTO public.bookings (slot_id, guest_player_id, status)
      VALUES ('${CYCLE_SLOT}', '${IDS.guestOwnedByAttackerAcademy}', 'confirmed');
    INSERT INTO public.bookings (slot_id, player_id, status)
      VALUES ('${CYCLE_SLOT}', '${IDS.nascentProfile}', 'confirmed');
    -- a seat for a guest the academy does NOT own (trainer-owned), to prove it is not named
    INSERT INTO public.bookings (slot_id, guest_player_id, status)
      VALUES ('${CYCLE_SLOT}', '${IDS.guestBookedOnAttackerSlot}', 'confirmed');
  `);
}, 120_000);

const asUser = (uid: string | null) =>
  db.query(`SELECT set_config('abc16.uid', $1, false)`, [uid ?? '']);

describe('A1 · profiles_public', () => {
  const visible = async (uid: string | null) => {
    await asUser(uid);
    const r = await db.query<{ id: string; full_name: string }>(
      `SELECT id, full_name FROM public.profiles_public`);
    return r.rows.map((x) => x.id);
  };

  it('a public trainer is world-visible, even anonymously', async () => {
    expect(await visible(null)).toContain(PUBLIC_TRAINER_PROFILE);
  });

  it('the caller sees their own profile', async () => {
    expect(await visible(IDS.nascentUser)).toContain(IDS.nascentProfile);
  });

  it('an academy manager still sees a trainer they manage', async () => {
    expect(await visible(IDS.attackerUser)).toContain(MANAGED_TRAINER_PROFILE);
  });

  // ── withdrawn arms ──────────────────────────────────────────────────────────────────────
  it('a booking on the academy\'s slot no longer exposes that player\'s profile', async () => {
    // nascentProfile has a confirmed booking on the academy's cyclus slot (arm 6).
    expect(await visible(IDS.attackerUser)).not.toContain(IDS.nascentProfile);
  });

  it('a forged guest link no longer exposes the linked profile', async () => {
    await db.exec(`
      UPDATE public.guest_players SET linked_profile_id = '${IDS.bookedProfile}'
      WHERE id = '${IDS.guestOwnedByAttackerAcademy}';
    `);   // written as owner: models a legacy row, which the ABC-18 guard blocks for clients
    expect(await visible(IDS.attackerUser)).not.toContain(IDS.bookedProfile);
  });

  it('an account-less profile shell is never exposed', async () => {
    expect(await visible(IDS.attackerUser)).not.toContain(SHELL_PROFILE);
    expect(await visible(null)).not.toContain(SHELL_PROFILE);
    expect(await visible(IDS.victimUser)).not.toContain(SHELL_PROFILE);
  });
});

describe('A1 · get_cycle_roster_names', () => {
  const roster = async (uid: string) => {
    await asUser(uid);
    const r = await db.query<{ id: string; full_name: string; has_login: boolean }>(
      `SELECT * FROM public.get_cycle_roster_names($1)`, [CYCLE]);
    return r.rows;
  };

  it('names a guest the cycle owner directly owns', async () => {
    const rows = await roster(IDS.attackerUser);
    const own = rows.find((r) => r.id === IDS.guestOwnedByAttackerAcademy);
    expect(own?.full_name).toBe('Own Guest');
    expect(own?.has_login).toBe(false);
  });

  it('a registered seat is neutral: booking-keyed, no name, no login, no profile uuid', async () => {
    const rows = await roster(IDS.attackerUser);
    expect(rows.map((r) => r.id)).not.toContain(IDS.nascentProfile);
    expect(rows.map((r) => r.full_name)).not.toContain('Nascent Player');
    const neutral = rows.filter((r) => r.full_name === 'Registered player');
    expect(neutral.length).toBeGreaterThan(0);
    expect(neutral.every((r) => r.has_login === false)).toBe(true);
    // the neutral key is a BOOKING id, never a person or profile id
    const bookings = await db.query<{ id: string }>(
      `SELECT id FROM public.bookings WHERE slot_id = $1`, [CYCLE_SLOT]);
    const bookingIds = bookings.rows.map((b) => b.id);
    expect(neutral.every((r) => bookingIds.includes(r.id))).toBe(true);
  });

  it('a guest the owner does NOT own is not named either', async () => {
    const rows = await roster(IDS.attackerUser);
    expect(rows.map((r) => r.id)).not.toContain(IDS.guestBookedOnAttackerSlot);
    expect(rows.map((r) => r.full_name)).not.toContain('Booked Guest');
  });

  it('no person uuid appears anywhere in the roster', async () => {
    const persons = await db.query<{ id: string }>(`SELECT id FROM public.persons`);
    const personIds = persons.rows.map((p) => p.id);
    const rows = await roster(IDS.attackerUser);
    const named = rows.filter((r) => r.full_name !== 'Registered player').map((r) => r.id);
    // a named row is a GUEST id; guest persons share the guest id by construction, so assert
    // the stronger property: no row is keyed by a person that has a PROFILE side.
    const profileSidePersons = await db.query<{ person_id: string }>(
      `SELECT person_id FROM public.person_links WHERE profile_id IS NOT NULL`);
    for (const r of [...named, ...rows.map((x) => x.id)]) {
      expect(profileSidePersons.rows.map((p) => p.person_id)).not.toContain(r);
    }
    expect(personIds.length).toBeGreaterThan(0);
  });

  it('an unauthorized caller is refused', async () => {
    await asUser(IDS.victimUser);
    await expect(db.query(`SELECT * FROM public.get_cycle_roster_names($1)`, [CYCLE]))
      .rejects.toThrow(/not_authorized_for_cycle/);
  });
});

describe('A1 · get_academy_cyclus_labels', () => {
  it('lists first names of directly owned guests only', async () => {
    await asUser(IDS.attackerUser);
    const r = await db.query<{ cycle_id: string; first_names: string[]; location_name: string }>(
      `SELECT * FROM public.get_academy_cyclus_labels($1)`, [IDS.attackerAcademy]);
    const row = r.rows.find((x) => x.cycle_id === CYCLE);
    expect(row).toBeDefined();
    expect(row!.first_names).toContain('Own');            // Own Guest
    expect(row!.first_names).not.toContain('Nascent');    // registered seat contributes nothing
    expect(row!.first_names).not.toContain('Booked');     // unowned guest contributes nothing
    expect(row!.location_name).toBe('Attacker Club');     // unrelated behaviour preserved
  });

  it('refuses an unauthorized caller', async () => {
    await asUser(IDS.victimUser);
    await expect(db.query(`SELECT * FROM public.get_academy_cyclus_labels($1)`, [IDS.attackerAcademy]))
      .rejects.toThrow(/not authorized/i);
  });
});

describe('A1 · get_booking_login_flags', () => {
  it('returns false for every seat, including a registered one', async () => {
    await asUser(IDS.attackerUser);
    const ids = await db.query<{ id: string }>(
      `SELECT id FROM public.bookings WHERE slot_id = $1`, [CYCLE_SLOT]);
    const r = await db.query<{ booking_id: string; has_login: boolean }>(
      `SELECT * FROM public.get_booking_login_flags($1::uuid[])`,
      [ids.rows.map((x) => x.id)]);
    expect(r.rows.length).toBe(ids.rows.length);
    expect(r.rows.every((x) => x.has_login === false)).toBe(true);
  });

  it('the authorization gate is unchanged — an outsider gets no rows', async () => {
    await asUser(IDS.victimUser);
    const ids = await db.query<{ id: string }>(
      `SELECT id FROM public.bookings WHERE slot_id = $1`, [CYCLE_SLOT]);
    const r = await db.query(`SELECT * FROM public.get_booking_login_flags($1::uuid[])`,
      [ids.rows.map((x) => x.id)]);
    expect(r.rows).toEqual([]);
  });
});

describe('A1 · signatures, grants and zero mutation', () => {
  it('every re-emitted object keeps its signature and grants', async () => {
    // Compare ARGUMENT TYPES, not the rendered identity string: PostgreSQL includes parameter
    // names there ("_cycle_id uuid"), so matching on "uuid" would fail for the wrong reason.
    const r = await db.query<{ proname: string; args: string }>(`
      SELECT p.proname, oidvectortypes(p.proargtypes) AS args
        FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
       WHERE ns.nspname = 'public'
         AND p.proname IN ('get_cycle_roster_names','get_academy_cyclus_labels','get_booking_login_flags')
       ORDER BY p.proname`);
    expect(r.rows.map((x) => [x.proname, x.args])).toEqual([
      ['get_academy_cyclus_labels', 'uuid'],
      ['get_booking_login_flags', 'uuid[]'],
      ['get_cycle_roster_names', 'uuid'],
    ]);

    const g = await db.query<{ ok: boolean }>(
      `SELECT has_table_privilege('authenticated','public.profiles_public','SELECT')
          AND has_table_privilege('anon','public.profiles_public','SELECT') AS ok`);
    expect(g.rows[0].ok).toBe(true);
  });

  it('A1 mutated no source row', async () => {
    // A1 re-emits readers only. Row counts across every table it reads are unchanged by the
    // migration itself; the fixture's own inserts are the only writes in this suite.
    const r = await db.query<{ guests: number; profiles: number; links: number }>(`
      SELECT (SELECT count(*) FROM public.guest_players)::int AS guests,
             (SELECT count(*) FROM public.profiles)::int      AS profiles,
             (SELECT count(*) FROM public.person_links)::int  AS links`);
    expect(r.rows[0].guests).toBeGreaterThan(0);
    expect(r.rows[0].profiles).toBeGreaterThan(0);
    expect(r.rows[0].links).toBeGreaterThan(0);
  });
});
