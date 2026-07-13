// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Dashboard revenue = MONEY ACTUALLY COLLECTED (migration 20260818100000). The old sum valued
// every paid seat at the full court list-price whenever payment_amount was 0/NULL — so a
// captain-paid group of 4 (covered seats, payment_amount NULL) reported ~4× the court price.
// The new sum = every PAID invoice's total (backbone) + paid non-invoiced non-covered bookings,
// each euro counted ONCE, no list-price fallback. Runs the REAL migration against Postgres.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const ACAD = '50000000-0000-0000-0000-0000000000a0';
const MGR_UID = '50000000-0000-0000-0000-0000000000e0';
const SLOT = '70000000-0000-0000-0000-000000000001';
const CAPTAIN = '90000000-0000-0000-0000-000000000001';

const revenueThisMonth = async (): Promise<number> => {
  const { rows } = await db.query<{ v: string }>(
    `SELECT (public.get_academy_dashboard_analytics($1::uuid, 12) -> 'kpis' ->> 'revenue_this_month') AS v`, [ACAD]);
  return Number(rows[0].v);
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT '${MGR_UID}'::uuid $fn$;
    CREATE OR REPLACE FUNCTION public.is_academy_manager(_uid uuid, _acad uuid) RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT true $fn$;

    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, academy_profile_id uuid, trainer_id uuid, price_per_session numeric);
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid, guest_player_id uuid,
      status text, payment_status text, paid_at timestamptz, payment_amount numeric,
      paid_externally boolean, paid_by_player_id uuid, paid_by_guest_player_id uuid, created_at timestamptz DEFAULT now());
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), academy_profile_id uuid, trainer_id uuid, cycle_id uuid,
      rebook_group_id uuid, status text, total numeric, paid_at timestamptz, booking_ids uuid[]);
    CREATE TABLE public.expenses (academy_profile_id uuid, trainer_id uuid, amount numeric, expense_date date);
    CREATE TABLE public.academy_player_locations (academy_profile_id uuid, profile_id uuid, guest_player_id uuid, created_at timestamptz DEFAULT now());
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY, trainer_id uuid, created_at timestamptz);

    INSERT INTO public.availability_slots (id, academy_profile_id, price_per_session) VALUES ('${SLOT}', '${ACAD}', 25);
  `);
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260818100000_dashboard_revenue_money_collected.sql'), 'utf8'));
});

describe('get_academy_dashboard_analytics — revenue = money actually collected', () => {
  it('a captain-paid group of 4 counts the court price ONCE, not 4× the slot price', async () => {
    // 4 covered bookings (payment_amount NULL, paid_by captain) on a €25 slot + ONE paid group
    // invoice at the €80 court price, booking_ids = all 4. Old code → 4 × 25 = €100. New → €80.
    await db.exec(`
      INSERT INTO public.bookings (id, slot_id, player_id, status, payment_status, paid_at, payment_amount, paid_by_player_id) VALUES
        ('b0000000-0000-0000-0000-000000000001', '${SLOT}', '${CAPTAIN}', 'confirmed', 'paid', now(), NULL, NULL),
        ('b0000000-0000-0000-0000-000000000002', '${SLOT}', gen_random_uuid(), 'confirmed', 'paid', now(), NULL, '${CAPTAIN}'),
        ('b0000000-0000-0000-0000-000000000003', '${SLOT}', gen_random_uuid(), 'confirmed', 'paid', now(), NULL, '${CAPTAIN}'),
        ('b0000000-0000-0000-0000-000000000004', '${SLOT}', gen_random_uuid(), 'confirmed', 'paid', now(), NULL, '${CAPTAIN}');
      INSERT INTO public.invoices (academy_profile_id, rebook_group_id, status, total, paid_at, booking_ids) VALUES
        ('${ACAD}', gen_random_uuid(), 'paid', 80,  now(),
         ARRAY['b0000000-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000002','b0000000-0000-0000-0000-000000000003','b0000000-0000-0000-0000-000000000004']::uuid[]);`);
    expect(await revenueThisMonth()).toBe(80);
  });

  it('adds registration/event invoice income (booking-less) once', async () => {
    await db.exec(`INSERT INTO public.invoices (academy_profile_id, cycle_id, status, total, paid_at, booking_ids)
      VALUES ('${ACAD}', gen_random_uuid(), 'paid', 50, now(), '{}');`);
    expect(await revenueThisMonth()).toBe(80 + 50);
  });

  it('adds a paid booking with NO invoice at its real amount (Mollie or cash), never the slot price', async () => {
    // A 1:1 paid via Mollie (amount 30) + a cash booking marked paid (amount 20) — both counted.
    await db.exec(`INSERT INTO public.bookings (id, slot_id, player_id, status, payment_status, paid_at, payment_amount, paid_externally) VALUES
      ('b0000000-0000-0000-0000-000000000010', '${SLOT}', gen_random_uuid(), 'confirmed', 'paid', now(), 30, false),
      ('b0000000-0000-0000-0000-000000000011', '${SLOT}', gen_random_uuid(), 'confirmed', 'paid', now(), 20, true);`);
    expect(await revenueThisMonth()).toBe(80 + 50 + 30 + 20);
  });

  it('does NOT double-count a paid booking that is on a paid per-session invoice', async () => {
    await db.exec(`
      INSERT INTO public.bookings (id, slot_id, player_id, status, payment_status, paid_at, payment_amount) VALUES
        ('b0000000-0000-0000-0000-000000000020', '${SLOT}', gen_random_uuid(), 'confirmed', 'paid', now(), 40);
      INSERT INTO public.invoices (academy_profile_id, status, total, paid_at, booking_ids) VALUES
        ('${ACAD}', 'paid', 40, now(), ARRAY['b0000000-0000-0000-0000-000000000020']::uuid[]);`);
    expect(await revenueThisMonth()).toBe(80 + 50 + 30 + 20 + 40); // +40 once, not +80
  });

  it('ignores unpaid/pending bookings and unpaid invoices', async () => {
    await db.exec(`
      INSERT INTO public.bookings (slot_id, player_id, status, payment_status, paid_at, payment_amount) VALUES
        ('${SLOT}', gen_random_uuid(), 'confirmed', 'pending', NULL, 99);
      INSERT INTO public.invoices (academy_profile_id, cycle_id, status, total, paid_at, booking_ids) VALUES
        ('${ACAD}', gen_random_uuid(), 'sent', 999, NULL, '{}');`);
    expect(await revenueThisMonth()).toBe(80 + 50 + 30 + 20 + 40); // unchanged
  });
});
