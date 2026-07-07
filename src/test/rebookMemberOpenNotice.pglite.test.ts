// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Slice 3: the "sessions opened" notifier's SQL core. Runs the ACTUAL migration
// (20260714110000) against real Postgres (PGlite) and proves the detection predicate
// (member window live + freed seat + not-yet-notified) and the atomic idempotency
// claim/unclaim. The guarded pg_cron DO block RETURNs early (no pg_cron in PGlite).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

let db: PGlite;

const FREED = 'c0000000-0000-0000-0000-0000000000f1';   // rebook round with a freed seat
const FULL = 'c0000000-0000-0000-0000-0000000000f2';    // fully rebooked round
const NOTIFIED = 'c0000000-0000-0000-0000-0000000000f3'; // already notified
const PRIORITY = 'c0000000-0000-0000-0000-0000000000f4'; // still in the priority window
const FREED_SLOT = 'd0000000-0000-0000-0000-0000000000f1';
const FULL_SLOT = 'd0000000-0000-0000-0000-0000000000f2';
const NOTIFIED_SLOT = 'd0000000-0000-0000-0000-0000000000f3';
const PRIORITY_SLOT = 'd0000000-0000-0000-0000-0000000000f4';

function readMigration(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  return readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '20260714110000_notify_rebook_member_open_cron.sql'),
    'utf8',
  );
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE service_role;
    CREATE TABLE public.cycles (id uuid PRIMARY KEY, owner_type text, settings jsonb DEFAULT '{}'::jsonb);
    CREATE TABLE public.availability_slots (
      id uuid PRIMARY KEY, source_cycle_id uuid, max_participants integer,
      priority_window_ends_at timestamptz, member_window_ends_at timestamptz);
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, status text, hold_expires_at timestamptz);
  `);
  await db.exec(readMigration());
});

// Rebuild the four rounds fresh before each case.
beforeEach(async () => {
  await db.exec(`DELETE FROM public.bookings; DELETE FROM public.availability_slots; DELETE FROM public.cycles;`);
  const rebookSettings = `jsonb_build_object('rebook_payment_mode','upfront')`;
  await db.exec(`
    INSERT INTO public.cycles (id, owner_type, settings) VALUES
      ('${FREED}', 'academy', ${rebookSettings}),
      ('${FULL}', 'academy', ${rebookSettings}),
      ('${NOTIFIED}', 'academy', jsonb_build_object('rebook_payment_mode','upfront','rebook_member_open_notified_at', to_jsonb(now()))),
      ('${PRIORITY}', 'academy', ${rebookSettings});
    -- Each round: one slot, capacity 2. Member window live except PRIORITY's.
    INSERT INTO public.availability_slots (id, source_cycle_id, max_participants, priority_window_ends_at, member_window_ends_at) VALUES
      ('${FREED_SLOT}', '${FREED}', 2, now() - interval '1 day', now() + interval '7 days'),
      ('${FULL_SLOT}', '${FULL}', 2, now() - interval '1 day', now() + interval '7 days'),
      ('${NOTIFIED_SLOT}', '${NOTIFIED}', 2, now() - interval '1 day', now() + interval '7 days'),
      ('${PRIORITY_SLOT}', '${PRIORITY}', 2, now() + interval '5 days', now() + interval '12 days');
    -- Occupancy: FREED has 1/2 (a freed seat); FULL has 2/2; the others 0.
    INSERT INTO public.bookings (slot_id, status) VALUES
      ('${FREED_SLOT}', 'confirmed'),
      ('${FULL_SLOT}', 'confirmed'), ('${FULL_SLOT}', 'confirmed');
  `);
});

async function candidates(): Promise<string[]> {
  const r = await db.query<{ cycle_id: string }>(`SELECT cycle_id FROM public.rebook_cycles_needing_member_open_notice()`);
  return r.rows.map((row) => row.cycle_id).sort();
}
async function claim(id: string): Promise<boolean> {
  const r = await db.query<{ claim_rebook_member_open_notice: boolean }>(
    `SELECT public.claim_rebook_member_open_notice($1) AS claim_rebook_member_open_notice`, [id]);
  return r.rows[0].claim_rebook_member_open_notice;
}

describe('rebook member-open notifier SQL', () => {
  it('detects only a live member window with a freed seat, not yet notified', async () => {
    // FREED qualifies; FULL (no freed seat), NOTIFIED (marker set), PRIORITY (window open) do not.
    expect(await candidates()).toEqual([FREED]);
  });

  it('claim is atomic + idempotent: first true, second false', async () => {
    expect(await claim(FREED)).toBe(true);
    expect(await claim(FREED)).toBe(false);
    // After claiming, the round is no longer a candidate.
    expect(await candidates()).toEqual([]);
  });

  it('unclaim makes the round eligible again (retry after a failed send)', async () => {
    expect(await claim(FREED)).toBe(true);
    expect(await candidates()).toEqual([]);
    await db.query(`SELECT public.unclaim_rebook_member_open_notice($1)`, [FREED]);
    expect(await candidates()).toEqual([FREED]);
    // And it can be claimed once more.
    expect(await claim(FREED)).toBe(true);
  });

  it('a round whose last freed seat gets taken drops out of detection', async () => {
    await db.query(`INSERT INTO public.bookings (slot_id, status) VALUES ($1, 'confirmed')`, [FREED_SLOT]);
    expect(await candidates()).toEqual([]);
  });
});
