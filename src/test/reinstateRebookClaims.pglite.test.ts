// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// PR A (reinstate a declined rebook player): reinstate_rebook_claims flips a player's DECLINED
// claims back to 'claimed' and (re)books each seat — COVERED (paid, paid_by=captain) when the
// group paid the full court upfront, else UNPAID — capacity-guarded so a taken seat comes back
// as 'seat_full', M-17-safe, and IDOR-gated to the caller's academy. Runs the REAL migration
// (20260817110000) against Postgres (PGlite).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const ACAD = '50000000-0000-0000-0000-0000000000a0';
const MGR_UID = '50000000-0000-0000-0000-0000000000e0';
const SLOT = '70000000-0000-0000-0000-000000000001';
const SLOT_FOREIGN = '70000000-0000-0000-0000-0000000000ff'; // another academy's slot (IDOR)
const GRP = 'a0000000-0000-0000-0000-000000000001';
const CAPTAIN = '90000000-0000-0000-0000-000000000001';
const KID = '90000000-0000-0000-0000-000000000002'; // the accidentally-declined player

const claim = async (id: string) =>
  (await db.query<{ status: string; booking_id: string | null; decline_reason: string | null; booked_by_player_id: string | null }>(
    `SELECT status, booking_id, decline_reason, booked_by_player_id FROM public.slot_priority_claims WHERE id=$1`, [id])).rows[0];
const booking = async (player: string, slot: string) =>
  (await db.query<{ status: string; payment_status: string; paid_by_player_id: string | null }>(
    `SELECT status, payment_status, paid_by_player_id FROM public.bookings WHERE player_id=$1 AND slot_id=$2 AND status<>'cancelled'`, [player, slot])).rows[0];
const reinstate = async (ids: string[]) =>
  Object.fromEntries((await db.query<{ claim_id: string; outcome: string }>(
    `SELECT * FROM public.reinstate_rebook_claims($1::uuid[])`, [ids])).rows.map((r) => [r.claim_id, r.outcome]));

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT '${MGR_UID}'::uuid $fn$;
    CREATE OR REPLACE FUNCTION public.get_user_academy_ids(_uid uuid) RETURNS SETOF uuid LANGUAGE sql STABLE AS $fn$ SELECT '${ACAD}'::uuid $fn$;

    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, academy_profile_id uuid, max_participants int DEFAULT 4);
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid, guest_player_id uuid,
      status text, payment_status text, paid_at timestamptz, hold_expires_at timestamptz,
      paid_by_player_id uuid, paid_by_guest_player_id uuid, created_at timestamptz, updated_at timestamptz);
    CREATE TABLE public.slot_priority_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid, guest_player_id uuid,
      rebook_group_id uuid, status text, responded_at timestamptz, decline_reason text, booking_id uuid,
      booked_by_player_id uuid, booked_by_guest_player_id uuid);
    CREATE TABLE public.invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rebook_group_id uuid,
      player_id uuid, guest_player_id uuid, status text, booking_ids uuid[]);

    INSERT INTO public.availability_slots (id, academy_profile_id, max_participants) VALUES
      ('${SLOT}', '${ACAD}', 4), ('${SLOT_FOREIGN}', '99999999-9999-9999-9999-999999999999', 4);
  `);
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260817110000_reinstate_rebook_claims.sql'), 'utf8'));
});

beforeEach(async () => {
  await db.exec(`DELETE FROM public.slot_priority_claims; DELETE FROM public.bookings; DELETE FROM public.invoices;`);
});

describe('reinstate_rebook_claims', () => {
  it('PAID group: covered re-seat — booking paid + paid_by captain, claim claimed, decline_reason cleared, invoice linked', async () => {
    // Captain paid the full court (3 seats booked+paid); the kid declined.
    await db.exec(`
      INSERT INTO public.invoices (id, rebook_group_id, player_id, status, booking_ids)
        VALUES ('b0000000-0000-0000-0000-000000000001', '${GRP}', '${CAPTAIN}', 'paid', '{}');
      INSERT INTO public.bookings (slot_id, player_id, status, payment_status) VALUES
        ('${SLOT}', '${CAPTAIN}', 'confirmed', 'paid');
      INSERT INTO public.slot_priority_claims (id, slot_id, player_id, rebook_group_id, status, decline_reason) VALUES
        ('c0000000-0000-0000-0000-000000000001', '${SLOT}', '${KID}', '${GRP}', 'declined', 'accidental');`);

    const out = await reinstate(['c0000000-0000-0000-0000-000000000001']);
    expect(out['c0000000-0000-0000-0000-000000000001']).toBe('reinstated');

    const c = await claim('c0000000-0000-0000-0000-000000000001');
    expect(c.status).toBe('claimed');
    expect(c.decline_reason).toBeNull();
    expect(c.booking_id).toBeTruthy();
    expect(c.booked_by_player_id).toBe(CAPTAIN);

    const b = await booking(KID, SLOT);
    expect(b.status).toBe('confirmed');
    expect(b.payment_status).toBe('paid');
    expect(b.paid_by_player_id).toBe(CAPTAIN);

    // The covered booking is recorded on the group's paid invoice.
    const inv = (await db.query<{ n: number }>(
      `SELECT array_length(booking_ids,1) AS n FROM public.invoices WHERE rebook_group_id='${GRP}'`)).rows[0];
    expect(Number(inv.n)).toBe(1);
  });

  it('capacity: a full slot returns seat_full and inserts nothing', async () => {
    await db.exec(`
      INSERT INTO public.invoices (rebook_group_id, player_id, status) VALUES ('${GRP}', '${CAPTAIN}', 'paid');
      INSERT INTO public.bookings (slot_id, player_id, status, payment_status) VALUES
        ('${SLOT}', '${CAPTAIN}', 'confirmed', 'paid'),
        ('${SLOT}', gen_random_uuid(), 'confirmed', 'paid'),
        ('${SLOT}', gen_random_uuid(), 'confirmed', 'paid'),
        ('${SLOT}', gen_random_uuid(), 'confirmed', 'paid');
      INSERT INTO public.slot_priority_claims (id, slot_id, player_id, rebook_group_id, status) VALUES
        ('c0000000-0000-0000-0000-000000000002', '${SLOT}', '${KID}', '${GRP}', 'declined');`);

    const out = await reinstate(['c0000000-0000-0000-0000-000000000002']);
    expect(out['c0000000-0000-0000-0000-000000000002']).toBe('seat_full');
    expect(await booking(KID, SLOT)).toBeUndefined();
    expect((await claim('c0000000-0000-0000-0000-000000000002')).status).toBe('declined');
  });

  it('NON-paid group (invoice only sent): re-seated UNPAID', async () => {
    await db.exec(`
      INSERT INTO public.invoices (rebook_group_id, player_id, status) VALUES ('${GRP}', '${CAPTAIN}', 'sent');
      INSERT INTO public.slot_priority_claims (id, slot_id, player_id, rebook_group_id, status) VALUES
        ('c0000000-0000-0000-0000-000000000003', '${SLOT}', '${KID}', '${GRP}', 'declined');`);

    const out = await reinstate(['c0000000-0000-0000-0000-000000000003']);
    expect(out['c0000000-0000-0000-0000-000000000003']).toBe('reinstated_unpaid');
    const b = await booking(KID, SLOT);
    expect(b.payment_status).toBe('pending');
    expect((await claim('c0000000-0000-0000-0000-000000000003')).status).toBe('claimed');
  });

  it('already has an active booking: links the claim, no second booking', async () => {
    await db.exec(`
      INSERT INTO public.invoices (rebook_group_id, player_id, status) VALUES ('${GRP}', '${CAPTAIN}', 'paid');
      INSERT INTO public.bookings (slot_id, player_id, status, payment_status) VALUES ('${SLOT}', '${KID}', 'confirmed', 'paid');
      INSERT INTO public.slot_priority_claims (id, slot_id, player_id, rebook_group_id, status) VALUES
        ('c0000000-0000-0000-0000-000000000004', '${SLOT}', '${KID}', '${GRP}', 'declined');`);

    const out = await reinstate(['c0000000-0000-0000-0000-000000000004']);
    expect(out['c0000000-0000-0000-0000-000000000004']).toBe('already_active');
    const n = (await db.query<{ n: number }>(
      `SELECT count(*) AS n FROM public.bookings WHERE player_id='${KID}' AND slot_id='${SLOT}' AND status<>'cancelled'`)).rows[0];
    expect(Number(n.n)).toBe(1);
    expect((await claim('c0000000-0000-0000-0000-000000000004')).status).toBe('claimed');
  });

  it('a non-declined claim is left untouched (not_declined)', async () => {
    await db.exec(`INSERT INTO public.slot_priority_claims (id, slot_id, player_id, status) VALUES
      ('c0000000-0000-0000-0000-000000000005', '${SLOT}', '${KID}', 'claimed');`);
    const out = await reinstate(['c0000000-0000-0000-0000-000000000005']);
    expect(out['c0000000-0000-0000-0000-000000000005']).toBe('not_declined');
  });

  it('IDOR: a claim on another academy\'s slot raises insufficient_privilege', async () => {
    await db.exec(`INSERT INTO public.slot_priority_claims (id, slot_id, player_id, status) VALUES
      ('c0000000-0000-0000-0000-000000000006', '${SLOT_FOREIGN}', '${KID}', 'declined');`);
    await expect(reinstate(['c0000000-0000-0000-0000-000000000006'])).rejects.toThrow(/not_authorized_for_academy/);
  });
});
