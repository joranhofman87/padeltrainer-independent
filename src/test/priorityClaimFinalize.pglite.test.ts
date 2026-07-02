// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// P2-12 regression: a paid strict-hold booking confirmed via the SHARED side-effects
// (finalizePriorityClaims — the block runBookingPaidSideEffects now runs on BOTH the
// webhook and verify-mollie-payment paths) must settle its slot_priority_claims row to
// 'claimed'. Before the fix only mollie-webhook did this, so a webhook-loss left the
// claim 'pending' → the expiry cron expired it and computeReleasedSlotIds released the
// PAID seat to the public tier. We drive the shared helper against real Postgres (PGlite)
// and assert the seat's claim is settled, then simulate the expiry cron to prove it can
// no longer release the paid seat.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteSupabase } from '@/test/fixtures/pgliteSupabase';
import { finalizePriorityClaims } from '../../supabase/functions/_shared/mollie-booking-paid-side-effects.ts';

let db: PGlite;
let supa: ReturnType<typeof createPgliteSupabase>;
const noopLog = () => {};

const claim = async (id: string) =>
  (await db.query<{ status: string; booking_id: string | null; responded_at: string | null }>(
    `SELECT status, booking_id, responded_at FROM slot_priority_claims WHERE id = $1`, [id],
  )).rows[0];

beforeAll(async () => {
  db = new PGlite();
  supa = createPgliteSupabase(db);
  await db.exec(`
    CREATE TABLE bookings (
      id text PRIMARY KEY, slot_id text, guest_player_id text, player_id text,
      payment_status text NOT NULL DEFAULT 'pending', status text NOT NULL DEFAULT 'pending');
    CREATE TABLE slot_priority_claims (
      id text PRIMARY KEY, slot_id text, player_id text, guest_player_id text,
      status text NOT NULL DEFAULT 'pending', booking_id text, responded_at timestamptz);
  `);
});

beforeEach(async () => {
  await db.exec(`DELETE FROM bookings; DELETE FROM slot_priority_claims;`);
});

describe('finalizePriorityClaims (P2-12) settles the claim on any paid path', () => {
  it('guest-keyed strict hold paid → claim pending→claimed, stamped with booking_id (seat cannot be released)', async () => {
    await db.exec(`INSERT INTO bookings (id, slot_id, guest_player_id, payment_status, status) VALUES
      ('B1','S1','G1','paid','confirmed');`);
    await db.exec(`INSERT INTO slot_priority_claims (id, slot_id, guest_player_id, status) VALUES
      ('C1','S1','G1','pending');`);

    await finalizePriorityClaims(supa, ['B1'], noopLog);

    const c = await claim('C1');
    expect(c.status).toBe('claimed');
    expect(c.booking_id).toBe('B1');
    expect(c.responded_at).not.toBeNull();

    // Simulate the expiry cron + release: it only frees claims still 'pending'.
    // A settled claim is skipped → the PAID seat cannot be released.
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM slot_priority_claims WHERE slot_id = 'S1' AND status = 'pending'`);
    expect(rows).toHaveLength(0);
  });

  it('player-keyed strict hold paid → claim pending→claimed', async () => {
    await db.exec(`INSERT INTO bookings (id, slot_id, player_id, payment_status, status) VALUES
      ('B1','S1','P1','paid','confirmed');`);
    await db.exec(`INSERT INTO slot_priority_claims (id, slot_id, player_id, status) VALUES
      ('C1','S1','P1','pending');`);

    await finalizePriorityClaims(supa, ['B1'], noopLog);

    expect((await claim('C1')).status).toBe('claimed');
    expect((await claim('C1')).booking_id).toBe('B1');
  });

  it('IDEMPOTENT: an already-claimed claim is left untouched (re-run / duplicate delivery)', async () => {
    await db.exec(`INSERT INTO bookings (id, slot_id, guest_player_id, payment_status, status) VALUES
      ('B1','S1','G1','paid','confirmed');`);
    await db.exec(`INSERT INTO slot_priority_claims (id, slot_id, guest_player_id, status, booking_id, responded_at) VALUES
      ('C1','S1','G1','claimed','B_ORIG','2026-06-30T09:00:00Z');`);

    await finalizePriorityClaims(supa, ['B1'], noopLog);

    const c = await claim('C1');
    expect(c.status).toBe('claimed');
    expect(c.booking_id).toBe('B_ORIG'); // not overwritten — only status='pending' rows transition
    expect(new Date(c.responded_at as string).toISOString()).toBe('2026-06-30T09:00:00.000Z');
  });

  it('does not touch a DIFFERENT person\'s pending claim on the same slot', async () => {
    await db.exec(`INSERT INTO bookings (id, slot_id, guest_player_id, payment_status, status) VALUES
      ('B1','S1','G1','paid','confirmed');`);
    await db.exec(`INSERT INTO slot_priority_claims (id, slot_id, guest_player_id, status) VALUES
      ('C1','S1','G1','pending'),
      ('C2','S1','G2','pending');`);

    await finalizePriorityClaims(supa, ['B1'], noopLog);

    expect((await claim('C1')).status).toBe('claimed');
    expect((await claim('C2')).status).toBe('pending'); // other person's claim untouched
  });
});
