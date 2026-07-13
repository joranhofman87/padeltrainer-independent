// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// PR B (paid group keeps its court private): a rebook slot whose group paid the full court
// upfront (invoices.rebook_group_id = 'paid') is FULL to outsiders — get_public_slot_occupancy
// reports max_participants, book_slot_for_payment / book_guest_slot_for_payment refuse with
// 'reserved_group', and the member-open notifier skips it — while an UNPAID group's slot keeps
// today's per-booking behavior and the group's own raw-count fills still work. Runs the REAL
// migration (20260817100000) against Postgres (PGlite).
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const PAID = '10000000-0000-0000-0000-000000000001';   // slot held by a PAID group (1 of 4 booked)
const UNPAID = '10000000-0000-0000-0000-000000000002'; // slot with a group whose invoice is NOT paid
const PLAIN = '10000000-0000-0000-0000-000000000003';  // ordinary public slot, no group
const GRP_PAID = 'a0000000-0000-0000-0000-000000000001';
const GRP_UNPAID = 'a0000000-0000-0000-0000-000000000002';
const CAPTAIN = '90000000-0000-0000-0000-000000000001';
const PUBLIC_PLAYER = '90000000-0000-0000-0000-000000000009';
const CYCLE = 'c0000000-0000-0000-0000-000000000001';

const occupancy = async (ids: string[]): Promise<Record<string, number>> => {
  const { rows } = await db.query<{ slot_id: string; occupied: number }>(
    `SELECT * FROM public.get_public_slot_occupancy($1::uuid[])`, [ids],
  );
  return Object.fromEntries(rows.map((r) => [r.slot_id, Number(r.occupied)]));
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA IF NOT EXISTS public;

    CREATE TABLE public.availability_slots (
      id uuid PRIMARY KEY, is_public boolean NOT NULL DEFAULT true, max_participants int DEFAULT 4,
      allow_single_booking boolean DEFAULT true, whole_slot_booking boolean DEFAULT false,
      split_payment boolean DEFAULT false, cyclus_id uuid, source_cycle_id uuid,
      priority_window_ends_at timestamptz, member_window_ends_at timestamptz);
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid NOT NULL,
      player_id uuid, guest_player_id uuid, status text NOT NULL, payment_status text,
      hold_expires_at timestamptz, payment_amount numeric, notes text);
    CREATE TABLE public.slot_priority_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid NOT NULL, rebook_group_id uuid);
    CREATE TABLE public.invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rebook_group_id uuid, status text);
    CREATE TABLE public.cycles (id uuid PRIMARY KEY, owner_type text, settings jsonb);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid);
    -- Stub the tier gate that book_slot_for_payment calls (allow → '').
    CREATE OR REPLACE FUNCTION public.can_book_slot(_slot_id uuid, _user_id uuid)
      RETURNS text LANGUAGE sql STABLE AS $fn$ SELECT ''::text $fn$;

    INSERT INTO public.profiles (id, user_id) VALUES ('${PUBLIC_PLAYER}', gen_random_uuid());

    INSERT INTO public.availability_slots (id, max_participants, source_cycle_id, priority_window_ends_at, member_window_ends_at) VALUES
      ('${PAID}',   4, '${CYCLE}', now() - interval '1 day', now() + interval '1 day'),
      ('${UNPAID}', 4, '${CYCLE}', now() - interval '1 day', now() + interval '1 day'),
      ('${PLAIN}',  4, NULL, NULL, NULL);

    -- PAID slot: a claimed group + a PAID group invoice + 1 real booking (3 seats empty).
    INSERT INTO public.slot_priority_claims (slot_id, rebook_group_id) VALUES ('${PAID}', '${GRP_PAID}');
    INSERT INTO public.invoices (rebook_group_id, status) VALUES ('${GRP_PAID}', 'paid');
    INSERT INTO public.bookings (slot_id, player_id, status, payment_status) VALUES ('${PAID}', '${CAPTAIN}', 'confirmed', 'paid');

    -- UNPAID slot: a group whose invoice is only 'sent', 1 booking.
    INSERT INTO public.slot_priority_claims (slot_id, rebook_group_id) VALUES ('${UNPAID}', '${GRP_UNPAID}');
    INSERT INTO public.invoices (rebook_group_id, status) VALUES ('${GRP_UNPAID}', 'sent');
    INSERT INTO public.bookings (slot_id, player_id, status, payment_status) VALUES ('${UNPAID}', gen_random_uuid(), 'confirmed', 'pending');

    -- PLAIN slot: 1 ordinary booking, no group.
    INSERT INTO public.bookings (slot_id, player_id, status, payment_status) VALUES ('${PLAIN}', gen_random_uuid(), 'confirmed', 'pending');

    -- The member-open round cycle.
    INSERT INTO public.cycles (id, owner_type, settings) VALUES ('${CYCLE}', 'academy', '{"rebook_payment_mode":"upfront"}'::jsonb);
  `);
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260817100000_paid_group_keeps_court_private.sql'), 'utf8'));
});

describe('slot_held_by_paid_group', () => {
  it('true only for a slot whose group has a PAID invoice', async () => {
    const held = async (id: string) =>
      (await db.query<{ h: boolean }>(`SELECT public.slot_held_by_paid_group($1) AS h`, [id])).rows[0].h;
    expect(await held(PAID)).toBe(true);
    expect(await held(UNPAID)).toBe(false); // invoice only 'sent'
    expect(await held(PLAIN)).toBe(false);  // no group
  });
});

describe('get_public_slot_occupancy — paid group reads FULL to outsiders', () => {
  it('reports max_participants for the paid-group slot, raw count otherwise', async () => {
    const occ = await occupancy([PAID, UNPAID, PLAIN]);
    expect(occ[PAID]).toBe(4);   // held → full, even though only 1 booking exists
    expect(occ[UNPAID]).toBe(1); // not held → raw count
    expect(occ[PLAIN]).toBe(1);
  });
});

describe('book_slot_for_payment / book_guest_slot_for_payment — outsiders refused on a paid-group court', () => {
  it('authed pay-first booking of a paid-group seat raises reserved_group', async () => {
    await expect(
      db.query(`SELECT public.book_slot_for_payment($1, $2, 20, NULL)`, [PAID, PUBLIC_PLAYER]),
    ).rejects.toThrow(/reserved_group/);
  });
  it('guest pay-first booking of a paid-group seat raises reserved_group', async () => {
    await expect(
      db.query(`SELECT public.book_guest_slot_for_payment($1, $2, 20, 20, NULL)`, [PAID, PUBLIC_PLAYER]),
    ).rejects.toThrow(/reserved_group/);
  });
  it('an UNPAID group slot still lets an outsider book its freed seat', async () => {
    const { rows } = await db.query<{ id: string }>(
      `SELECT public.book_slot_for_payment($1, $2, 20, NULL) AS id`, [UNPAID, PUBLIC_PLAYER],
    );
    expect(rows[0].id).toBeTruthy();
  });
});

describe('rebook_cycles_needing_member_open_notice — paid-group seats never blast', () => {
  // Only PAID + UNPAID belong to CYCLE. PAID is always private (held by a paid group). We drive
  // UNPAID's state explicitly each time (bookings accumulate across the shared setup).
  const fillUnpaid = async (occupying: number) => {
    await db.exec(`UPDATE public.bookings SET status='cancelled' WHERE slot_id='${UNPAID}';`);
    for (let i = 0; i < occupying; i++) {
      await db.exec(`INSERT INTO public.bookings (slot_id, player_id, status, payment_status) VALUES ('${UNPAID}', gen_random_uuid(), 'confirmed', 'pending');`);
    }
  };
  const notified = async () =>
    (await db.query<{ cycle_id: string }>(`SELECT * FROM public.rebook_cycles_needing_member_open_notice()`))
      .rows.map((r) => r.cycle_id);

  it('a round whose only freed seats are on paid-group courts is NOT notified', async () => {
    await fillUnpaid(4); // UNPAID full → the only freed-capacity slot would be PAID (private)
    expect(await notified()).not.toContain(CYCLE);
  });

  it('a genuinely freed non-group seat DOES notify', async () => {
    await fillUnpaid(3); // UNPAID 3/4 → a real freed seat on a NON-held slot
    expect(await notified()).toContain(CYCLE);
  });
});
