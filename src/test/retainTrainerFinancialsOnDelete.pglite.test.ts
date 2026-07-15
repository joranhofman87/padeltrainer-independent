// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Theme A / R03 (audit, HIGH): deleting a trainer must RETAIN their invoices + the bookings on
// their slots, not cascade them away. Runs the REAL migration against Postgres and drives the
// delete-user-data trainer sequence (anonymize the trainer_profiles shell → delete guests → delete
// the auth user), proving: invoices, slots and bookings survive; the trainer row is kept as an
// anonymized shell (user_id detached, anonymized_at stamped); the guest master row is still erased
// while the invoice keeps its denormalized customer name; and a direct trainer delete detaches
// invoices (SET NULL) instead of erasing them.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const U = 'aa000000-0000-0000-0000-0000000000a0'; // auth user
const T = 'aa000000-0000-0000-0000-0000000000a1'; // trainer_profiles
const G = 'bb000000-0000-0000-0000-0000000000b1'; // guest_player (student)
const S = 'cc000000-0000-0000-0000-0000000000c1'; // slot
const INV = 'd0000000-0000-0000-0000-000000000001'; // invoice
const B = 'd0000000-0000-0000-0000-000000000002'; // paid booking on the slot
const T2 = 'aa000000-0000-0000-0000-0000000000a2'; // second trainer (direct-delete defense case)
const U2 = 'aa000000-0000-0000-0000-0000000000a3';
const INV2 = 'd0000000-0000-0000-0000-000000000003';

const count = async (sql: string, params: unknown[] = []): Promise<number> => {
  const { rows } = await db.query<{ n: number }>(sql, params);
  return Number((rows[0] as { n: number }).n);
};
const failed = async (p: Promise<unknown>): Promise<boolean> => p.then(() => false, () => true);

beforeAll(async () => {
  db = new PGlite();
  // Pre-migration schema: the exact CASCADE/NO ACTION shapes the migration rewrites, constraint
  // names matching so its DROP CONSTRAINT statements hit them.
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE TABLE public.trainer_profiles (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL CONSTRAINT trainer_profiles_user_id_fkey REFERENCES auth.users(id) ON DELETE CASCADE,
      is_public boolean DEFAULT true,
      is_verified boolean DEFAULT false,
      business_name text
    );
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY, trainer_id uuid, full_name text);
    CREATE TABLE public.availability_slots (
      id uuid PRIMARY KEY,
      trainer_id uuid NOT NULL CONSTRAINT availability_slots_trainer_id_fkey REFERENCES public.trainer_profiles(id) ON DELETE CASCADE
    );
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY,
      trainer_id uuid CONSTRAINT invoices_trainer_id_fkey REFERENCES public.trainer_profiles(id) ON DELETE CASCADE,
      guest_player_id uuid CONSTRAINT invoices_guest_player_id_fkey REFERENCES public.guest_players(id),
      player_name text,
      status text DEFAULT 'sent'
    );
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY,
      slot_id uuid NOT NULL REFERENCES public.availability_slots(id) ON DELETE CASCADE,
      guest_player_id uuid REFERENCES public.guest_players(id) ON DELETE SET NULL,
      payment_status text DEFAULT 'paid'
    );

    INSERT INTO auth.users (id) VALUES ('${U}'), ('${U2}');
    INSERT INTO public.trainer_profiles (id, user_id, business_name) VALUES ('${T}', '${U}', 'Padel Pro BV'), ('${T2}', '${U2}', 'Second Trainer');
    INSERT INTO public.guest_players (id, trainer_id, full_name) VALUES ('${G}', '${T}', 'Student Name');
    INSERT INTO public.availability_slots (id, trainer_id) VALUES ('${S}', '${T}');
    INSERT INTO public.invoices (id, trainer_id, guest_player_id, player_name) VALUES
      ('${INV}', '${T}', '${G}', 'Student Name'), ('${INV2}', '${T2}', NULL, 'Someone');
    INSERT INTO public.bookings (id, slot_id, guest_player_id) VALUES ('${B}', '${S}', '${G}');
  `);
  await db.exec(
    readFileSync(
      join(process.cwd(), 'supabase', 'migrations', '20260826140000_a2_retain_trainer_financials_on_delete.sql'),
      'utf8',
    ),
  );
});

describe('retain trainer financials on account deletion (R03)', () => {
  it('runs the full delete sequence (anonymize shell → delete guests → delete auth user) with the financials RETAINED', async () => {
    // 1) Anonymize the trainer_profiles into a shell (as delete-user-data now does).
    await db.exec(
      `UPDATE public.trainer_profiles
         SET user_id = NULL, anonymized_at = now(), is_public = false, business_name = NULL
       WHERE id = '${T}'`,
    );
    // 2) Erase the trainer's guest players — now allowed because invoices.guest_player_id is SET NULL.
    const guestDeleteBlocked = await failed(db.query(`DELETE FROM public.guest_players WHERE trainer_id = $1`, [T]));
    expect(guestDeleteBlocked).toBe(false);
    // 3) Delete the auth user (final step) — must NOT cascade the shell / financials away.
    await db.exec(`DELETE FROM auth.users WHERE id = '${U}'`);

    // Financial records all retained.
    expect(await count(`SELECT count(*) n FROM public.invoices WHERE id = $1`, [INV])).toBe(1);
    expect(await count(`SELECT count(*) n FROM public.availability_slots WHERE id = $1`, [S])).toBe(1);
    expect(await count(`SELECT count(*) n FROM public.bookings WHERE id = $1`, [B])).toBe(1);
  });

  it('keeps the trainer as an anonymized shell (retained row, user_id detached, anonymized_at set)', async () => {
    expect(await count(
      `SELECT count(*) n FROM public.trainer_profiles WHERE id = $1 AND user_id IS NULL AND anonymized_at IS NOT NULL AND is_public = false`,
      [T],
    )).toBe(1);
    // The invoice still points at the shell (join for display resolves, not null).
    expect(await count(`SELECT count(*) n FROM public.invoices WHERE id = $1 AND trainer_id = $2`, [INV, T])).toBe(1);
  });

  it('erases the guest master row but keeps the invoice + its denormalized customer name', async () => {
    expect(await count(`SELECT count(*) n FROM public.guest_players WHERE id = $1`, [G])).toBe(0);
    expect(await count(
      `SELECT count(*) n FROM public.invoices WHERE id = $1 AND guest_player_id IS NULL AND player_name = 'Student Name'`,
      [INV],
    )).toBe(1);
    // The retained booking's guest reference was nulled, booking kept.
    expect(await count(`SELECT count(*) n FROM public.bookings WHERE id = $1 AND guest_player_id IS NULL`, [B])).toBe(1);
  });

  it('defense: a DIRECT trainer_profiles delete detaches the invoice (SET NULL) instead of erasing it', async () => {
    await db.exec(`DELETE FROM public.trainer_profiles WHERE id = '${T2}'`);
    expect(await count(`SELECT count(*) n FROM public.invoices WHERE id = $1 AND trainer_id IS NULL`, [INV2])).toBe(1);
  });
});
