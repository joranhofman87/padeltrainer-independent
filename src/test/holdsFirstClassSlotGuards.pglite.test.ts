// @vitest-environment node
// Audit Batch 3 (§4.1): the slot delete + capacity-shrink guards must count LIVE payment_pending
// holds (status='payment_pending' AND hold_expires_at > now()) as occupancy, like the capacity
// trigger + public occupancy read already do. Runs the REAL migration SQL against Postgres (PGlite):
//   • a slot whose only occupant is a LIVE hold is PROTECTED from delete (was cascade-deleted → the
//     later paid webhook found no booking: money captured, no seat);
//   • an EXPIRED hold does NOT protect (the seat is genuinely free);
//   • a shrink below (confirmed + live holds) is BLOCKED (was ignored → oversell on hold-convert);
//   • an expired hold does not count toward the shrink occupancy.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const S_HOLD = '20000000-0000-0000-0000-000000000001'; // only a LIVE hold
const S_EXP = '20000000-0000-0000-0000-000000000002';  // only an EXPIRED hold
const S_EMPTY = '20000000-0000-0000-0000-000000000003'; // no bookings
const S_SHRINK = '20000000-0000-0000-0000-000000000004'; // 2 confirmed + 1 live hold (occ 3), cap 4
const S_SHRINK_EXP = '20000000-0000-0000-0000-000000000005'; // 2 confirmed + 1 expired hold (occ 2), cap 4

const del = async (slotIds: string[]) =>
  (await db.query<{ deleted_count: number; protected_count: number; protected_slot_ids: string[] }>(
    `SELECT * FROM public.apply_slot_delete_to_cycle(NULL, $1::uuid[])`, [slotIds],
  )).rows[0];
const edit = async (slotIds: string[], patch: Record<string, unknown>) =>
  (await db.query<{ updated_count: number; blocked_count: number; blocked_slot_ids: string[] }>(
    `SELECT * FROM public.apply_slot_edit_to_cycle(NULL, $1::uuid[], $2::jsonb)`, [slotIds, JSON.stringify(patch)],
  )).rows[0];
const slotExists = async (id: string): Promise<boolean> =>
  Number((await db.query<{ n: string }>(`SELECT count(*) n FROM public.availability_slots WHERE id = $1`, [id])).rows[0].n) > 0;
const slotMax = async (id: string): Promise<number> =>
  Number((await db.query<{ m: number }>(`SELECT max_participants m FROM public.availability_slots WHERE id = $1`, [id])).rows[0].m);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA IF NOT EXISTS public;
    CREATE TABLE public.cycles (id uuid PRIMARY KEY);
    CREATE TABLE public.availability_slots (
      id uuid PRIMARY KEY, cyclus_id uuid, max_participants int, trainer_id uuid, is_public boolean,
      location_id uuid, rating_system text, min_rating numeric, max_rating numeric, cyclus_name text,
      start_time timestamptz DEFAULT now(), end_time timestamptz DEFAULT now() + interval '1 hour');
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid NOT NULL, status text, hold_expires_at timestamptz);

    INSERT INTO public.availability_slots (id, max_participants) VALUES
      ('${S_HOLD}', 4), ('${S_EXP}', 4), ('${S_EMPTY}', 4), ('${S_SHRINK}', 4), ('${S_SHRINK_EXP}', 4);

    INSERT INTO public.bookings (slot_id, status, hold_expires_at) VALUES
      ('${S_HOLD}', 'payment_pending', now() + interval '10 min'),
      ('${S_EXP}',  'payment_pending', now() - interval '1 min'),
      ('${S_SHRINK}', 'confirmed', NULL), ('${S_SHRINK}', 'confirmed', NULL),
      ('${S_SHRINK}', 'payment_pending', now() + interval '10 min'),
      ('${S_SHRINK_EXP}', 'confirmed', NULL), ('${S_SHRINK_EXP}', 'confirmed', NULL),
      ('${S_SHRINK_EXP}', 'payment_pending', now() - interval '1 min');
  `);
  // Load ONLY the new guard definitions (NULL cycle_id → recalc_cycle_split_count is never called).
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260810100000_holds_first_class_slot_guards.sql'), 'utf8'));
});

describe('apply_slot_delete_to_cycle — live holds protect the seat (audit Batch 3 §4.1)', () => {
  it('protects a slot whose only occupant is a LIVE hold; deletes the expired-hold + empty ones', async () => {
    const r = await del([S_HOLD, S_EXP, S_EMPTY]);
    expect(Number(r.deleted_count)).toBe(2);   // expired-hold slot + empty slot
    expect(Number(r.protected_count)).toBe(1); // the live-hold slot
    expect(r.protected_slot_ids).toEqual([S_HOLD]);

    expect(await slotExists(S_HOLD)).toBe(true);   // live hold saved it (money-in-flight seat kept)
    expect(await slotExists(S_EXP)).toBe(false);   // expired hold → genuinely free → deleted
    expect(await slotExists(S_EMPTY)).toBe(false);
  });
});

describe('apply_slot_edit_to_cycle — shrink guard counts live holds (audit Batch 3 §4.1)', () => {
  it('BLOCKS a shrink below (2 confirmed + 1 live hold = 3); an expired hold does not count', async () => {
    // occ 3 (incl. the live hold) → shrinking to 2 must be refused (would oversell on hold-convert).
    const blocked = await edit([S_SHRINK], { max_participants: 2 });
    expect(Number(blocked.blocked_count)).toBe(1);
    expect(blocked.blocked_slot_ids).toEqual([S_SHRINK]);
    expect(await slotMax(S_SHRINK)).toBe(4); // unchanged — refused

    // The expired-hold slot has occ 2 (hold ignored) → shrinking to 2 is allowed.
    const allowed = await edit([S_SHRINK_EXP], { max_participants: 2 });
    expect(Number(allowed.updated_count)).toBe(1);
    expect(Number(allowed.blocked_count)).toBe(0);
    expect(await slotMax(S_SHRINK_EXP)).toBe(2);

    // Shrinking S_SHRINK to exactly its live occupancy (3) is allowed.
    const toThree = await edit([S_SHRINK], { max_participants: 3 });
    expect(Number(toThree.updated_count)).toBe(1);
    expect(await slotMax(S_SHRINK)).toBe(3);
  });
});
