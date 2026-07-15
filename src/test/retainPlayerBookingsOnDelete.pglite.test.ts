// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Theme A / R02 (audit, HIGH): deleting a player must RETAIN their bookings (anonymized), not
// cascade them away. Runs the REAL migration against Postgres and proves:
//   * the anonymize UPDATE (null player_id + stamp anonymized_at) is legal (was 23514 before);
//   * after anonymizing, deleting the player's profile KEEPS the booking (FK is SET NULL, not
//     CASCADE) — the core R02 fix;
//   * a profile delete that SKIPPED the anonymize step is now BLOCKED by the CHECK instead of
//     silently cascade-deleting the paid booking (no silent-loss path survives);
//   * a non-anonymized booking still requires an owner (the CHECK only widens for anonymized rows).
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const P1 = 'aa000000-0000-0000-0000-000000000001'; // player whose booking gets anonymized then profile deleted
const P2 = 'aa000000-0000-0000-0000-000000000002'; // player whose profile delete SKIPS anonymize (must be blocked)
const GUEST = 'bb000000-0000-0000-0000-000000000001';
const SLOT = 'cc000000-0000-0000-0000-000000000001';
const B1 = 'd0000000-0000-0000-0000-000000000001';
const B2 = 'd0000000-0000-0000-0000-000000000002';
const BG = 'd0000000-0000-0000-0000-000000000003';

const count = async (sql: string, params: unknown[] = []): Promise<number> => {
  const { rows } = await db.query<{ n: number }>(sql, params);
  return Number((rows[0] as { n: number }).n);
};
const failed = async (p: Promise<unknown>): Promise<boolean> => p.then(() => false, () => true);

beforeAll(async () => {
  db = new PGlite();
  // Pre-migration schema: bookings.player_id ON DELETE CASCADE + the strict booking_has_player
  // CHECK — exactly the shape the migration rewrites. Constraint names match so the migration's
  // DROP CONSTRAINT statements hit them.
  await db.exec(`
    CREATE TABLE public.profiles (id uuid PRIMARY KEY);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY);
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY);
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid NOT NULL REFERENCES public.availability_slots(id) ON DELETE CASCADE,
      player_id uuid CONSTRAINT bookings_player_id_fkey REFERENCES public.profiles(id) ON DELETE CASCADE,
      guest_player_id uuid REFERENCES public.guest_players(id) ON DELETE SET NULL,
      payment_status text NOT NULL DEFAULT 'paid',
      status text NOT NULL DEFAULT 'confirmed',
      CONSTRAINT booking_has_player CHECK (player_id IS NOT NULL OR guest_player_id IS NOT NULL)
    );
    INSERT INTO public.profiles (id) VALUES ('${P1}'), ('${P2}');
    INSERT INTO public.guest_players (id) VALUES ('${GUEST}');
    INSERT INTO public.availability_slots (id) VALUES ('${SLOT}');
    INSERT INTO public.bookings (id, slot_id, player_id) VALUES ('${B1}', '${SLOT}', '${P1}'), ('${B2}', '${SLOT}', '${P2}');
    INSERT INTO public.bookings (id, slot_id, guest_player_id) VALUES ('${BG}', '${SLOT}', '${GUEST}');
  `);
  await db.exec(
    readFileSync(
      join(process.cwd(), 'supabase', 'migrations', '20260826130000_a1_retain_player_bookings_on_delete.sql'),
      'utf8',
    ),
  );
});

describe('retain player bookings on account deletion (R02)', () => {
  it('the anonymize UPDATE (null player_id + stamp anonymized_at) is legal — was 23514 before', async () => {
    const blocked = await failed(db.query(
      `UPDATE public.bookings SET player_id = NULL, anonymized_at = now() WHERE id = $1`, [B1],
    ));
    expect(blocked).toBe(false);
    expect(await count(
      `SELECT count(*) n FROM public.bookings WHERE id = $1 AND player_id IS NULL AND anonymized_at IS NOT NULL`, [B1],
    )).toBe(1);
  });

  it('deleting the profile AFTER anonymize keeps the booking (SET NULL, not CASCADE)', async () => {
    await db.exec(`DELETE FROM public.profiles WHERE id = '${P1}'`);
    expect(await count(`SELECT count(*) n FROM public.bookings WHERE id = $1`, [B1])).toBe(1);
  });

  it('a profile delete that SKIPPED anonymize is BLOCKED by the CHECK — no silent cascade-loss', async () => {
    // B2 still references P2 and was never anonymized. The FK SET NULL would leave it owner-less,
    // which the CHECK rejects → the delete fails loudly instead of erasing the paid booking.
    const blocked = await failed(db.query(`DELETE FROM public.profiles WHERE id = $1`, [P2]));
    expect(blocked).toBe(true);
    expect(await count(`SELECT count(*) n FROM public.bookings WHERE id = $1`, [B2])).toBe(1);
    expect(await count(`SELECT count(*) n FROM public.profiles WHERE id = $1`, [P2])).toBe(1);
  });

  it('a non-anonymized booking still requires an owner (CHECK only widens for anonymized rows)', async () => {
    const blocked = await failed(db.query(
      `INSERT INTO public.bookings (slot_id, player_id, guest_player_id) VALUES ($1, NULL, NULL)`, [SLOT],
    ));
    expect(blocked).toBe(true);
  });

  it('the guest booking is untouched by the player deletion', async () => {
    expect(await count(
      `SELECT count(*) n FROM public.bookings WHERE id = $1 AND guest_player_id = $2`, [BG, GUEST],
    )).toBe(1);
  });
});
