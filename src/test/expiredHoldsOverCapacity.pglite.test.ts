// @vitest-environment node
// Audit Batch 3 (§4.1): the webhook oversell guard. expired_holds_over_capacity returns exactly the
// booking ids that are EXPIRED payment_pending holds whose slot is ALREADY full from OTHER occupying
// bookings (confirmed/pending/pending_approval + other LIVE holds). The webhook refuses to confirm
// those late payments (a padel court can't seat a 5th). Runs the REAL migration SQL against Postgres.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const S_FULL = '40000000-0000-0000-0000-0000000000f0'; // max 2, already 2 confirmed
const S_ROOM = '40000000-0000-0000-0000-0000000000f1'; // max 4, only 1 confirmed
const S_LIVE = '40000000-0000-0000-0000-0000000000f2'; // max 2, 2 confirmed + a LIVE hold
const H_OVERSOLD = '40000000-0000-0000-0000-00000000b001'; // expired hold on S_FULL → oversell
const H_OK = '40000000-0000-0000-0000-00000000b002';        // expired hold on S_ROOM → room, fine
const H_LIVE = '40000000-0000-0000-0000-00000000b003';      // LIVE hold on S_LIVE → not expired
const B_CONF = '40000000-0000-0000-0000-00000000b004';      // a plain confirmed booking

const oversold = async (ids: string[]): Promise<string[]> =>
  (await db.query<{ booking_id: string }>(
    `SELECT booking_id FROM public.expired_holds_over_capacity($1::uuid[]) ORDER BY booking_id`, [ids],
  )).rows.map((r) => r.booking_id);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE service_role;
    CREATE SCHEMA IF NOT EXISTS public;
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, max_participants int);
    CREATE TABLE public.bookings (id uuid PRIMARY KEY, slot_id uuid, status text, hold_expires_at timestamptz);

    INSERT INTO public.availability_slots (id, max_participants) VALUES
      ('${S_FULL}', 2), ('${S_ROOM}', 4), ('${S_LIVE}', 2);

    INSERT INTO public.bookings (id, slot_id, status, hold_expires_at) VALUES
      -- S_FULL: 2 confirmed (full) + the expired hold under test
      (gen_random_uuid(), '${S_FULL}', 'confirmed', NULL), (gen_random_uuid(), '${S_FULL}', 'confirmed', NULL),
      ('${H_OVERSOLD}', '${S_FULL}', 'payment_pending', now() - interval '1 min'),
      -- S_ROOM: 1 confirmed + the expired hold under test (room remains)
      (gen_random_uuid(), '${S_ROOM}', 'confirmed', NULL),
      ('${H_OK}', '${S_ROOM}', 'payment_pending', now() - interval '1 min'),
      -- S_LIVE: 2 confirmed + a LIVE hold (still within its window)
      (gen_random_uuid(), '${S_LIVE}', 'confirmed', NULL), (gen_random_uuid(), '${S_LIVE}', 'confirmed', NULL),
      ('${H_LIVE}', '${S_LIVE}', 'payment_pending', now() + interval '10 min'),
      -- a plain confirmed booking on the full slot (not a hold)
      ('${B_CONF}', '${S_FULL}', 'confirmed', NULL);
  `);
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260812100000_expired_holds_over_capacity.sql'), 'utf8'));
});

describe('expired_holds_over_capacity (audit Batch 3 §4.1)', () => {
  it('returns ONLY the expired hold whose slot is now full', async () => {
    expect(await oversold([H_OVERSOLD, H_OK, H_LIVE, B_CONF])).toEqual([H_OVERSOLD]);
  });

  it('an expired hold with room left is NOT flagged (no oversell)', async () => {
    expect(await oversold([H_OK])).toEqual([]);
  });

  it('a LIVE hold on a full slot is NOT flagged — its seat was reserved (on-time payment never dropped)', async () => {
    expect(await oversold([H_LIVE])).toEqual([]);
  });

  it('a confirmed (non-hold) booking is never flagged', async () => {
    expect(await oversold([B_CONF])).toEqual([]);
  });

  it('empty input → empty', async () => {
    expect(await oversold([])).toEqual([]);
  });
});
