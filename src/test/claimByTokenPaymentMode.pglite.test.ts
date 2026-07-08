// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// The logged-out claim page must resolve the rebook payment mode WITHOUT the status='open'
// cycles_public read (which returns nothing once the cycle leaves 'open', silently downgrading
// an upfront cycle to pay-later). This runs the REAL migration (20260723100000) against Postgres
// (PGlite) and proves get_priority_claim_by_token returns the cycle's payment mode + split flag
// straight from the claim token, regardless of cycle status.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const UPFRONT = 'c1000000-0000-0000-0000-000000000001';
const DEFERRED = 'c1000000-0000-0000-0000-000000000002';
const UNSET = 'c1000000-0000-0000-0000-000000000003';
const S_UP = '50000000-0000-0000-0000-0000000000a1';
const S_DEF = '50000000-0000-0000-0000-0000000000a2';
const S_UNSET = '50000000-0000-0000-0000-0000000000a3';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function claim(token: string): Promise<any> {
  const r = await db.query<{ j: unknown }>(`SELECT public.get_priority_claim_by_token($1) AS j`, [token]);
  return r.rows[0]?.j ?? null;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE public.cycles (id uuid PRIMARY KEY, settings jsonb);
    CREATE TABLE public.availability_slots (
      id uuid PRIMARY KEY, start_time timestamptz, end_time timestamptz, cyclus_id uuid,
      cyclus_name text, location_id uuid, price_per_session numeric, total_price numeric,
      max_participants int, priority_window_ends_at timestamptz, trainer_id uuid, academy_profile_id uuid);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text, first_name text);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY, full_name text, first_name text);
    CREATE TABLE public.slot_priority_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text, claim_token text,
      slot_id uuid, rebook_group_id uuid, player_id uuid, guest_player_id uuid,
      booked_by_player_id uuid, booked_by_guest_player_id uuid);

    INSERT INTO public.cycles (id, settings) VALUES
      ('${UPFRONT}', '{"rebook_payment_mode":"upfront"}'::jsonb),
      ('${DEFERRED}', '{"rebook_payment_mode":"deferred_split","split_payment":true}'::jsonb),
      ('${UNSET}', '{}'::jsonb);
    INSERT INTO public.availability_slots (id, start_time, end_time, cyclus_id, trainer_id) VALUES
      ('${S_UP}', now(), now() + interval '1 hour', '${UPFRONT}', gen_random_uuid()),
      ('${S_DEF}', now(), now() + interval '1 hour', '${DEFERRED}', gen_random_uuid()),
      ('${S_UNSET}', now(), now() + interval '1 hour', '${UNSET}', gen_random_uuid());
    INSERT INTO public.slot_priority_claims (status, claim_token, slot_id) VALUES
      ('pending', 'tok-upfront', '${S_UP}'),
      ('pending', 'tok-deferred', '${S_DEF}'),
      ('pending', 'tok-unset', '${S_UNSET}');
  `);
  await db.exec(
    readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260723100000_claim_by_token_payment_mode.sql'), 'utf8'),
  );
});

describe('get_priority_claim_by_token — payment mode', () => {
  it('returns upfront for an upfront cycle', async () => {
    const j = await claim('tok-upfront');
    expect(j.rebook_payment_mode).toBe('upfront');
    expect(j.split_payment).toBe(false);
  });

  it('returns deferred_split + split flag for a deferred split cycle', async () => {
    const j = await claim('tok-deferred');
    expect(j.rebook_payment_mode).toBe('deferred_split');
    expect(j.split_payment).toBe(true);
  });

  it('defaults to deferred_split when the setting is unset (never silently upfront)', async () => {
    const j = await claim('tok-unset');
    expect(j.rebook_payment_mode).toBe('deferred_split');
    expect(j.split_payment).toBe(false);
  });

  it('returns null for an unknown token', async () => {
    expect(await claim('does-not-exist')).toBeNull();
  });
});
