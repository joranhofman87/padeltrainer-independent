// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Roster-after-pay guard (migration 20260725100000): expire_lapsed_priority_claims() must NOT
// expire a held teammate seat whose group already has a 'claimed' captain (who paid the full
// court), but MUST still expire ungrouped claims and groups with no claimed member. Runs the real
// RPC against Postgres (PGlite).
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const S = '50000000-0000-0000-0000-000000000001'; // slot, priority window already closed
const G_PAID = 'a0000000-0000-0000-0000-000000000001'; // group with a claimed captain
const G_OPEN = 'a0000000-0000-0000-0000-000000000002'; // group, nobody claimed yet

const status = async (token: string) =>
  (await db.query<{ status: string }>(`SELECT status FROM public.slot_priority_claims WHERE claim_token=$1`, [token]))
    .rows[0]?.status;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE service_role;
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, priority_window_ends_at timestamptz);
    CREATE TABLE public.slot_priority_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, status text,
      rebook_group_id uuid, claim_token text, responded_at timestamptz);

    INSERT INTO public.availability_slots VALUES ('${S}', now() - interval '1 day');
    INSERT INTO public.slot_priority_claims (slot_id, status, rebook_group_id, claim_token) VALUES
      ('${S}', 'claimed', '${G_PAID}', 'captain'),       -- the paid captain (not pending)
      ('${S}', 'pending', '${G_PAID}', 'teammate'),      -- HELD seat in a paid group → protect
      ('${S}', 'pending', '${G_OPEN}', 'group-nocaptain'),-- group, nobody claimed → expire
      ('${S}', 'pending', NULL,        'ungrouped');      -- ungrouped → expire
  `);
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260725100000_protect_paid_group_from_expiry.sql'), 'utf8'));
});

describe('expire_lapsed_priority_claims — roster-after-pay guard', () => {
  it('protects a held teammate seat whose group has a claimed captain; expires the rest', async () => {
    const expired = (await db.query<{ n: number }>(`SELECT public.expire_lapsed_priority_claims() AS n`)).rows[0].n;
    expect(Number(expired)).toBe(2); // group-nocaptain + ungrouped

    expect(await status('teammate')).toBe('pending'); // protected — captain paid the court
    expect(await status('captain')).toBe('claimed'); // untouched (not pending)
    expect(await status('group-nocaptain')).toBe('expired');
    expect(await status('ungrouped')).toBe('expired');
  });
});
