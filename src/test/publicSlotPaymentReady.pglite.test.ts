// @vitest-environment node
// Public-booking audit P1-7: get_public_slot_payment_ready is the anon-safe "is this priced slot
// actually bookable" source for the public availability pages — the FE drops priced slots whose
// payment owner has no working Mollie so a guest never dead-ends. Exercised against real Postgres.
// The function is loaded from the REAL migration file(s) so a hotfix to the live SQL fails here.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

function readMigrations(): string {
  return [
    '20260706150000_public_slot_payment_ready_rpc.sql',
    '20260826100000_f06_academy_mollie_soft_disconnect.sql',
  ]
    .map((f) => readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8'))
    .join('\n')
    .split('\n')
    .filter((l) => !/^(REVOKE|GRANT)\b/.test(l)) // anon/authenticated roles don't exist in PGlite
    .join('\n');
}

const A = (n: string) => `10000000-0000-0000-0000-0000000000${n}`; // slots
const ACA = '20000000-0000-0000-0000-00000000000a'; // academy (ready)
const ACX = '20000000-0000-0000-0000-00000000000b'; // academy (not ready)
const ACD = '20000000-0000-0000-0000-00000000000c'; // academy (ready but soft-disconnected, F06)
const TRR = '30000000-0000-0000-0000-00000000000a'; // trainer (ready)
const TRX = '30000000-0000-0000-0000-00000000000b'; // trainer (not ready)

const ready = async (ids: string[]): Promise<Record<string, boolean>> => {
  const { rows } = await db.query<{ slot_id: string; payment_ready: boolean }>(
    `SELECT * FROM public.get_public_slot_payment_ready($1::uuid[])`,
    [ids],
  );
  return Object.fromEntries(rows.map((r) => [r.slot_id, r.payment_ready]));
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS public;
    CREATE TABLE public.availability_slots (
      id uuid PRIMARY KEY, is_public boolean NOT NULL DEFAULT true,
      trainer_id uuid, academy_profile_id uuid,
      price_per_session numeric, total_price numeric
    );
    CREATE TABLE public.academy_mollie_accounts (
      academy_profile_id uuid PRIMARY KEY, onboarding_complete boolean,
      charges_enabled boolean, access_token text
    );
    CREATE TABLE public.trainer_mollie_accounts (
      trainer_id uuid PRIMARY KEY, onboarding_complete boolean,
      charges_enabled boolean, access_token text
    );
    INSERT INTO public.academy_mollie_accounts VALUES
      ('${ACA}', true, true, 'tok'),      -- fully ready
      ('${ACX}', true, false, 'tok');     -- onboarded but charges_enabled false → NOT ready
    INSERT INTO public.trainer_mollie_accounts VALUES
      ('${TRR}', true, true, 'tok'),      -- fully ready
      ('${TRX}', true, true, NULL);       -- no access_token → NOT ready

    INSERT INTO public.availability_slots (id, is_public, trainer_id, academy_profile_id, price_per_session, total_price) VALUES
      ('${A('01')}', true, '${TRR}', NULL, 0, NULL),           -- FREE trainer slot → ready
      ('${A('02')}', true, '${TRR}', NULL, 25, NULL),          -- priced, trainer ready → ready
      ('${A('03')}', true, '${TRX}', NULL, 25, NULL),          -- priced, trainer NOT ready → false
      ('${A('04')}', true, '${TRR}', '${ACA}', 25, NULL),      -- academy slot, academy ready → ready
      ('${A('05')}', true, '${TRR}', '${ACX}', 25, NULL),      -- academy slot, academy NOT ready → false (hard refuse: trainer ready but ignored)
      ('${A('06')}', true, '${TRR}', NULL, NULL, 200),         -- priced via total_price, trainer ready → ready
      ('${A('07')}', false, '${TRR}', NULL, 25, NULL);         -- private slot → excluded from results
  `);
  await db.exec(readMigrations());
  // F06 fixtures AFTER the migrations: the soft-disconnect column only exists once
  // 20260826100000 has run. A fully KYC-ready but soft-disconnected academy.
  await db.exec(`
    INSERT INTO public.academy_mollie_accounts (academy_profile_id, onboarding_complete, charges_enabled, access_token, disconnected_at)
      VALUES ('${ACD}', true, true, 'tok', now());
    INSERT INTO public.availability_slots (id, is_public, trainer_id, academy_profile_id, price_per_session, total_price)
      VALUES ('${A('08')}', true, '${TRR}', '${ACD}', 25, NULL);
  `);
});

describe('get_public_slot_payment_ready', () => {
  it('a FREE slot is always bookable (no online payment needed)', async () => {
    expect((await ready([A('01')]))[A('01')]).toBe(true);
  });

  it('priced trainer slot: ready when the trainer Mollie is charge-ready, else false', async () => {
    const r = await ready([A('02'), A('03')]);
    expect(r[A('02')]).toBe(true);
    expect(r[A('03')]).toBe(false); // trainer has no access_token
  });

  it('priced total_price slot follows the same readiness', async () => {
    expect((await ready([A('06')]))[A('06')]).toBe(true);
  });

  it('academy slot: gated on the ACADEMY Mollie (hard-refuse the trainer fallback)', async () => {
    const r = await ready([A('04'), A('05')]);
    expect(r[A('04')]).toBe(true);  // academy ready
    // academy NOT charge-ready → false EVEN THOUGH the trainer is ready (money must go to academy)
    expect(r[A('05')]).toBe(false);
  });

  it('never returns a private (is_public=false) slot', async () => {
    expect((await ready([A('07')]))[A('07')]).toBeUndefined();
  });

  it('academy slot: a soft-disconnected academy is NOT payment-ready even when KYC-ready (F06)', async () => {
    expect((await ready([A('08')]))[A('08')]).toBe(false);
  });
});
