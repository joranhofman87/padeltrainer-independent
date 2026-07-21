// @vitest-environment node
// Player self-booking minimum notice ("booking cutoff"), migration 20260925100000.
//
// The rule is easy to state and easy to get subtly wrong, so the pins are about the edges:
//   * default 0 must change NOTHING — this ships to live academies,
//   * the STRICTER of academy/trainer wins, in both directions,
//   * STAFF booking on someone's behalf is exempt, or last-minute admin breaks,
//   * and the DATABASE clock decides, never the client's.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;
const MIG = (n: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', n), 'utf8');

const A1 = '0a000000-0000-0000-0000-0000000000a1';   // academy
const T1 = '0c000000-0000-0000-0000-0000000000c1';   // trainer in the academy
const T2 = '0c000000-0000-0000-0000-0000000000c2';   // independent trainer
const U_P = '0e000000-0000-0000-0000-0000000000e1';  // a player's login
const PR_P = '0f000000-0000-0000-0000-0000000000f1'; // that player's profile
const U_T = '0e000000-0000-0000-0000-0000000000e2';  // the trainer's login
const PR_T = '0f000000-0000-0000-0000-0000000000f2';
const U_M = '0e000000-0000-0000-0000-0000000000e3';  // an academy manager's login
const PR_M = '0f000000-0000-0000-0000-0000000000f3';

const as = (uid: string | null) =>
  db.exec(`SELECT set_config('test.uid', ${uid ? `'${uid}'` : `''`}, false);`);

/** A slot starting `hours` from now, under the given tenant. */
const slot = async (id: string, hours: number, opts: { academy?: string | null; trainer?: string } = {}) => {
  await db.exec(`
    INSERT INTO public.availability_slots (id, trainer_id, academy_profile_id, start_time, end_time, max_participants)
    VALUES ('${id}', '${opts.trainer ?? T1}',
            ${opts.academy === null ? 'NULL' : `'${opts.academy ?? A1}'`},
            now() + make_interval(mins => ${Math.round(hours * 60)}),
            now() + make_interval(mins => ${Math.round(hours * 60) + 60}), 4)
    ON CONFLICT (id) DO UPDATE SET start_time = excluded.start_time, end_time = excluded.end_time;`);
  return id;
};

const setNotice = (opts: { academy?: number; trainer?: number; trainerId?: string }) =>
  db.exec(`
    ${opts.academy !== undefined ? `UPDATE public.academy_profiles SET player_booking_min_notice_minutes = ${opts.academy} WHERE id = '${A1}';` : ''}
    ${opts.trainer !== undefined ? `UPDATE public.trainer_profiles SET player_booking_min_notice_minutes = ${opts.trainer} WHERE id = '${opts.trainerId ?? T1}';` : ''}`);

const effectiveNotice = async (slotId: string) =>
  (await db.query<{ v: number | null }>(
    `SELECT public.get_slot_player_booking_min_notice_minutes('${slotId}') AS v`)).rows[0].v;

const withinCutoff = async (slotId: string) =>
  (await db.query<{ v: boolean }>(
    `SELECT public.is_slot_within_player_booking_cutoff('${slotId}') AS v`)).rows[0].v;

const canBook = async (slotId: string, uid: string) =>
  (await db.query<{ v: string }>(`SELECT public.can_book_slot('${slotId}', '${uid}') AS v`)).rows[0].v;

/** Insert a booking the way the relevant actor would. */
const bookAsSelf = (slotId: string) =>
  db.exec(`INSERT INTO public.bookings (slot_id, player_id, status) VALUES ('${slotId}', '${PR_P}', 'confirmed');`);
const bookForGuest = (slotId: string) =>
  db.exec(`INSERT INTO public.bookings (slot_id, guest_player_id, status)
           VALUES ('${slotId}', '0b000000-0000-0000-0000-0000000000b1', 'confirmed');`);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid $fn$;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.availability_slots (
      id uuid PRIMARY KEY, trainer_id uuid NOT NULL, academy_profile_id uuid,
      start_time timestamptz NOT NULL, end_time timestamptz NOT NULL,
      max_participants integer DEFAULT 1, source_cycle_id uuid);
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid NOT NULL,
      player_id uuid, guest_player_id uuid, status text DEFAULT 'confirmed',
      payment_status text, paid_at timestamptz, hold_expires_at timestamptz);
    CREATE TABLE public.slot_priority_claims (slot_id uuid, player_id uuid, status text);

    CREATE OR REPLACE FUNCTION public.get_profile_id_for_user(_user_id uuid) RETURNS uuid
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
      SELECT id FROM public.profiles WHERE user_id = _user_id LIMIT 1 $fn$;
    -- every slot in these tests is 'public' tier; the tier machinery has its own suite
    CREATE OR REPLACE FUNCTION public.resolve_slot_booking_tier(_slot_id uuid) RETURNS text
      LANGUAGE sql STABLE AS $fn$ SELECT 'public'::text $fn$;
    CREATE OR REPLACE FUNCTION public.can_book_member_window(_user_id uuid, _cycle uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $fn$ SELECT true $fn$;
  `);

  await db.exec(MIG('20260925100000_player_booking_min_notice.sql'));

  // The real trigger, reproduced in the shape that matters here: skip service-role, skip staff
  // booking for someone else, otherwise consult can_book_slot. (Capacity/UPDATE handling is
  // the tier suite's business.)
  await db.exec(`
    CREATE OR REPLACE FUNCTION public.enforce_booking_slot_tier() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
    DECLARE v_caller_profile uuid; v_reason text;
    BEGIN
      IF auth.uid() IS NULL THEN RETURN NEW; END IF;
      v_caller_profile := public.get_profile_id_for_user(auth.uid());
      IF NEW.player_id IS NULL OR NEW.player_id <> v_caller_profile THEN RETURN NEW; END IF;
      v_reason := public.can_book_slot(NEW.slot_id, auth.uid());
      IF v_reason <> '' THEN
        RAISE EXCEPTION USING MESSAGE = v_reason, ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END; $fn$;
    CREATE TRIGGER trg_enforce_booking_slot_tier BEFORE INSERT OR UPDATE ON public.bookings
      FOR EACH ROW EXECUTE FUNCTION public.enforce_booking_slot_tier();

    INSERT INTO auth.users (id) VALUES ('${U_P}'), ('${U_T}'), ('${U_M}');
    INSERT INTO public.profiles (id, user_id) VALUES ('${PR_P}','${U_P}'), ('${PR_T}','${U_T}'), ('${PR_M}','${U_M}');
    INSERT INTO public.academy_profiles (id) VALUES ('${A1}');
    INSERT INTO public.trainer_profiles (id, user_id) VALUES ('${T1}','${U_T}'), ('${T2}', NULL);
  `);
});

beforeEach(async () => {
  await db.exec(`DELETE FROM public.bookings;`);
  await setNotice({ academy: 0, trainer: 0 });
  await db.exec(`UPDATE public.trainer_profiles SET player_booking_min_notice_minutes = 0 WHERE id = '${T2}';`);
  await as(null);
});

describe('the default changes nothing', () => {
  it('defaults to 0 on both tenants', async () => {
    const r = await db.query<{ a: number; t: number }>(`
      SELECT (SELECT player_booking_min_notice_minutes FROM public.academy_profiles WHERE id='${A1}') AS a,
             (SELECT player_booking_min_notice_minutes FROM public.trainer_profiles WHERE id='${T1}') AS t`);
    expect(r.rows[0]).toEqual({ a: 0, t: 0 });
  });

  it('with no cutoff, a slot that ALREADY STARTED is still not "within cutoff"', async () => {
    // The subtle one. `start_time - now() < interval '0 min'` is TRUE for anything in the past,
    // so without the `mins > 0` guard a cutoff of 0 would silently start blocking late/ongoing
    // sessions on every live academy — a behaviour change disguised as a no-op default.
    const s = await slot('01000000-0000-0000-0000-000000000010', -2);
    expect(await effectiveNotice(s)).toBe(0);
    expect(await withinCutoff(s)).toBe(false);
    expect(await canBook(s, U_P)).toBe('');
  });

  it('with no cutoff set, a player can still book a slot starting in 10 minutes', async () => {
    // this is the property that makes the change safe to deploy to live academies
    const s = await slot('01000000-0000-0000-0000-000000000001', 10 / 60);
    expect(await withinCutoff(s)).toBe(false);
    expect(await canBook(s, U_P)).toBe('');
    await as(U_P);
    await expect(bookAsSelf(s)).resolves.toBeDefined();
  });
});

describe('effective cutoff is the STRICTER of academy and trainer', () => {
  it('academy 48h alone', async () => {
    const s = await slot('01000000-0000-0000-0000-000000000002', 100);
    await setNotice({ academy: 48 * 60 });
    expect(await effectiveNotice(s)).toBe(48 * 60);
  });

  it('trainer 72h + academy 48h => 72h (a trainer may TIGHTEN)', async () => {
    const s = await slot('01000000-0000-0000-0000-000000000003', 100);
    await setNotice({ academy: 48 * 60, trainer: 72 * 60 });
    expect(await effectiveNotice(s)).toBe(72 * 60);
  });

  it('trainer 24h + academy 48h => 48h (a trainer may NOT loosen)', async () => {
    // the review trap: the academy's rule has to survive a laxer trainer setting
    const s = await slot('01000000-0000-0000-0000-000000000004', 100);
    await setNotice({ academy: 48 * 60, trainer: 24 * 60 });
    expect(await effectiveNotice(s)).toBe(48 * 60);
  });

  it('an INDEPENDENT trainer slot uses the trainer setting', async () => {
    const s = await slot('01000000-0000-0000-0000-000000000005', 100, { academy: null, trainer: T2 });
    await db.exec(`UPDATE public.trainer_profiles SET player_booking_min_notice_minutes = ${36 * 60} WHERE id = '${T2}';`);
    expect(await effectiveNotice(s)).toBe(36 * 60);
  });

  it('returns NULL for a slot that does not exist, and callers coalesce', async () => {
    expect(await effectiveNotice('01000000-0000-0000-0000-0000000000ff')).toBeNull();
    expect(await withinCutoff('01000000-0000-0000-0000-0000000000ff')).toBe(false);
  });
});

describe('the boundary', () => {
  it('academy 48h: blocks at 47h, allows at 49h', async () => {
    await setNotice({ academy: 48 * 60 });
    const late = await slot('01000000-0000-0000-0000-000000000006', 47);
    const ok = await slot('01000000-0000-0000-0000-000000000007', 49);
    expect(await withinCutoff(late)).toBe(true);
    expect(await withinCutoff(ok)).toBe(false);
  });

  it('a slot that has already started is inside any cutoff', async () => {
    await setNotice({ academy: 60 });
    const past = await slot('01000000-0000-0000-0000-000000000008', -2);
    expect(await withinCutoff(past)).toBe(true);
  });

  it('uses the DATABASE clock, not any value a caller supplies', async () => {
    // there is no parameter for "now" anywhere in the API — moving the slot is the only way to
    // change the answer, which is the point
    await setNotice({ academy: 48 * 60 });
    const s = await slot('01000000-0000-0000-0000-000000000009', 10);
    expect(await withinCutoff(s)).toBe(true);
    await db.exec(`UPDATE public.availability_slots SET start_time = now() + interval '60 hours' WHERE id = '${s}';`);
    expect(await withinCutoff(s)).toBe(false);
  });
});

describe('enforcement on the player self-booking path', () => {
  it('REJECTS an authenticated player booking themselves inside the cutoff', async () => {
    await setNotice({ academy: 48 * 60 });
    const s = await slot('01000000-0000-0000-0000-00000000000a', 5);
    expect(await canBook(s, U_P)).toBe('booking_cutoff');
    await as(U_P);
    await expect(bookAsSelf(s)).rejects.toThrow(/booking_cutoff/);
  });

  it('allows that same player outside the cutoff', async () => {
    await setNotice({ academy: 48 * 60 });
    const s = await slot('01000000-0000-0000-0000-00000000000b', 72);
    await as(U_P);
    await expect(bookAsSelf(s)).resolves.toBeDefined();
  });

  it('reports the tier reason FIRST — a hidden slot never reveals it is merely late', async () => {
    // visibility outranks the cutoff, so we do not leak the existence of an unreleased slot
    await db.exec(`CREATE OR REPLACE FUNCTION public.resolve_slot_booking_tier(_slot_id uuid)
      RETURNS text LANGUAGE sql STABLE AS $fn$ SELECT 'hidden'::text $fn$;`);
    await setNotice({ academy: 48 * 60 });
    const s = await slot('01000000-0000-0000-0000-00000000000c', 5);
    expect(await canBook(s, U_P)).toBe('slot_not_released');
    await db.exec(`CREATE OR REPLACE FUNCTION public.resolve_slot_booking_tier(_slot_id uuid)
      RETURNS text LANGUAGE sql STABLE AS $fn$ SELECT 'public'::text $fn$;`);
  });
});

describe('staff are exempt — last-minute admin must keep working', () => {
  it('the TRAINER can still add a player inside the cutoff', async () => {
    await setNotice({ academy: 48 * 60 });
    const s = await slot('01000000-0000-0000-0000-00000000000d', 2);
    await as(U_T);
    await expect(bookForGuest(s)).resolves.toBeDefined();
  });

  it('an ACADEMY MANAGER can still add a player inside the cutoff', async () => {
    await setNotice({ academy: 48 * 60 });
    const s = await slot('01000000-0000-0000-0000-00000000000e', 2);
    await as(U_M);
    await expect(bookForGuest(s)).resolves.toBeDefined();
  });

  it('staff booking a REGISTERED player on their behalf is exempt too', async () => {
    // the trigger's staff test is "this row's player_id is not mine", which covers it
    await setNotice({ academy: 48 * 60 });
    const s = await slot('01000000-0000-0000-0000-00000000000f', 2);
    await as(U_T);
    await expect(
      db.exec(`INSERT INTO public.bookings (slot_id, player_id, status) VALUES ('${s}', '${PR_P}', 'confirmed');`),
    ).resolves.toBeDefined();
  });
});

describe('lockdown — the helpers answer questions about arbitrary slots', () => {
  it('is service_role only; anon and authenticated cannot execute either helper', async () => {
    // this project auto-grants EXECUTE on new functions to anon/authenticated via ALTER DEFAULT
    // PRIVILEGES, and a bare REVOKE FROM PUBLIC does not undo it — so this pin is load-bearing
    const r = await db.query<{ role: string; notice: boolean; cutoff: boolean }>(`
      SELECT role,
        has_function_privilege(role, 'public.get_slot_player_booking_min_notice_minutes(uuid)', 'EXECUTE') AS notice,
        has_function_privilege(role, 'public.is_slot_within_player_booking_cutoff(uuid)', 'EXECUTE') AS cutoff
      FROM unnest(ARRAY['anon','authenticated','service_role']) AS role`);
    for (const role of ['anon', 'authenticated']) {
      const row = r.rows.find((x) => x.role === role)!;
      expect(row.notice, `${role} must not read cutoffs`).toBe(false);
      expect(row.cutoff, `${role} must not probe cutoffs`).toBe(false);
    }
    const svc = r.rows.find((x) => x.role === 'service_role')!;
    expect(svc.notice).toBe(true);
    expect(svc.cutoff).toBe(true);
  });
});

describe('the settings themselves', () => {
  it('rejects a negative value and one over 7 days on both tables', async () => {
    for (const [table, id] of [['academy_profiles', A1], ['trainer_profiles', T1]] as const) {
      await expect(db.exec(
        `UPDATE public.${table} SET player_booking_min_notice_minutes = -1 WHERE id = '${id}';`),
      ).rejects.toThrow();
      await expect(db.exec(
        `UPDATE public.${table} SET player_booking_min_notice_minutes = 10081 WHERE id = '${id}';`),
      ).rejects.toThrow();
    }
  });

  it('accepts exactly 7 days', async () => {
    await expect(db.exec(
      `UPDATE public.academy_profiles SET player_booking_min_notice_minutes = 10080 WHERE id = '${A1}';`),
    ).resolves.toBeDefined();
  });
});
