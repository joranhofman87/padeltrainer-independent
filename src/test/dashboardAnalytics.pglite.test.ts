// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Dashboard analytics RPCs are money data, so this runs the REAL migration (20260719100000)
// against Postgres (PGlite) and proves the monthly series + KPIs: revenue from paid bookings by
// paid_at (with slot-price fallback), expenses by expense_date, profit = in-out, new players
// (registered vs guest) first-seen per month, this-month/last-month KPI pairs, and — critically —
// tenant scoping (a non-manager / another tenant gets NULL).
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const ACAD_A = 'c0000000-0000-0000-0000-0000000000a0';
const ACAD_B = 'c0000000-0000-0000-0000-0000000000b0';
const MGR_A = 'e0000000-0000-0000-0000-0000000000a0';
const MGR_B = 'e0000000-0000-0000-0000-0000000000b0';
const T_A = 'fa000000-0000-0000-0000-0000000000a0';
const TUSER_A = 'd0000000-0000-0000-0000-0000000000a0';
const NOUSER = 'd0000000-0000-0000-0000-00000000ffff';
const SLOT_A = '50000000-0000-0000-0000-0000000000a0';

async function asUser<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET test.uid = '${uid}';`);
  try { return await fn(); } finally { await db.exec(`SET test.uid = '';`); }
}
const academyAnalytics = async (acad: string, months = 12) =>
  (await db.query<{ r: unknown }>(`SELECT public.get_academy_dashboard_analytics($1::uuid, $2) AS r`, [acad, months])).rows[0].r as
    | { monthly: Array<Record<string, number>>; kpis: Record<string, number> } | null;
const trainerAnalytics = async (months = 12) =>
  (await db.query<{ r: unknown }>(`SELECT public.get_trainer_dashboard_analytics($1) AS r`, [months])).rows[0].r as
    | { monthly: Array<Record<string, number>>; kpis: Record<string, number> } | null;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid $fn$;

    CREATE TABLE public.academy_managers (user_id uuid, academy_profile_id uuid);
    CREATE OR REPLACE FUNCTION public.is_academy_manager(_user_id uuid, _academy_profile_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
      SELECT EXISTS (SELECT 1 FROM public.academy_managers WHERE user_id = _user_id AND academy_profile_id = _academy_profile_id) $fn$;

    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, academy_profile_id uuid, trainer_id uuid, price_per_session numeric);
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid, guest_player_id uuid,
      payment_status text, paid_at timestamptz, payment_amount numeric, status text, created_at timestamptz DEFAULT now());
    CREATE TABLE public.expenses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), academy_profile_id uuid, trainer_id uuid, expense_date date, amount numeric);
    CREATE TABLE public.invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), academy_profile_id uuid, trainer_id uuid, status text);
    CREATE TABLE public.academy_player_locations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), academy_profile_id uuid, profile_id uuid, guest_player_id uuid, created_at timestamptz DEFAULT now());
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), trainer_id uuid, created_at timestamptz DEFAULT now());

    INSERT INTO public.academy_managers VALUES ('${MGR_A}','${ACAD_A}'), ('${MGR_B}','${ACAD_B}');
    INSERT INTO public.trainer_profiles VALUES ('${T_A}','${TUSER_A}');
    INSERT INTO public.availability_slots VALUES ('${SLOT_A}','${ACAD_A}','${T_A}', 20);

    -- Revenue: this-month 30 (explicit) + 20 (NULL amount -> slot price 20) = 50; last-month 40. One unpaid (excluded).
    INSERT INTO public.bookings (slot_id, player_id, payment_status, paid_at, payment_amount, status, created_at) VALUES
      ('${SLOT_A}', 'aa000000-0000-0000-0000-000000000001', 'paid', now(), 30, 'confirmed', now()),
      ('${SLOT_A}', 'aa000000-0000-0000-0000-000000000002', 'paid', now(), NULL, 'confirmed', now()),
      ('${SLOT_A}', 'aa000000-0000-0000-0000-000000000003', 'paid', date_trunc('month', now()) - interval '5 days', 40, 'confirmed', date_trunc('month', now()) - interval '5 days'),
      ('${SLOT_A}', 'aa000000-0000-0000-0000-000000000004', 'pending', NULL, 99, 'pending', now());

    -- Academy expenses: this-month 15, last-month 10.  Trainer expenses: this-month 8.
    INSERT INTO public.expenses (academy_profile_id, expense_date, amount) VALUES
      ('${ACAD_A}', current_date, 15), ('${ACAD_A}', (date_trunc('month', now()) - interval '5 days')::date, 10);
    INSERT INTO public.expenses (trainer_id, expense_date, amount) VALUES ('${T_A}', current_date, 8);

    -- Academy players (academy_player_locations): this-month registered P1 + guest G1; last-month registered P2.
    INSERT INTO public.academy_player_locations (academy_profile_id, profile_id, guest_player_id, created_at) VALUES
      ('${ACAD_A}', 'bb000000-0000-0000-0000-000000000001', NULL, now()),
      ('${ACAD_A}', NULL, 'cc000000-0000-0000-0000-000000000001', now()),
      ('${ACAD_A}', 'bb000000-0000-0000-0000-000000000002', NULL, date_trunc('month', now()) - interval '5 days');

    -- Trainer guest owned this month.
    INSERT INTO public.guest_players (trainer_id, created_at) VALUES ('${T_A}', now());

    -- Invoices: ACAD_A has 1 sent (outstanding), 1 paid, 1 draft (not counted). Trainer 1 sent.
    INSERT INTO public.invoices (academy_profile_id, status) VALUES ('${ACAD_A}','sent'), ('${ACAD_A}','paid'), ('${ACAD_A}','draft');
    INSERT INTO public.invoices (trainer_id, status) VALUES ('${T_A}','sent');
  `);
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260719100000_dashboard_analytics.sql'), 'utf8'));
});

describe('get_academy_dashboard_analytics', () => {
  it('returns a zero-filled monthly series + KPIs for the managed academy', async () => {
    const r = await asUser(MGR_A, () => academyAnalytics(ACAD_A, 12));
    expect(r).not.toBeNull();
    expect(r!.monthly).toHaveLength(12);
    // newest month = this month
    const cur = r!.monthly[r!.monthly.length - 1];
    expect(Number(cur.revenue)).toBe(50);
    expect(Number(cur.expenses)).toBe(15);
    expect(Number(cur.profit)).toBe(35);
    expect(Number(cur.new_registered)).toBe(1);
    expect(Number(cur.new_guest)).toBe(1);
    const k = r!.kpis;
    expect(Number(k.revenue_this_month)).toBe(50);
    expect(Number(k.revenue_last_month)).toBe(40);
    expect(Number(k.expenses_this_month)).toBe(15);
    expect(Number(k.new_players_this_month)).toBe(2);
    expect(Number(k.new_players_last_month)).toBe(1);
    expect(Number(k.outstanding_invoices)).toBe(1);
  });

  it('honours the _months argument (zero-fill)', async () => {
    const r = await asUser(MGR_A, () => academyAnalytics(ACAD_A, 3));
    expect(r!.monthly).toHaveLength(3);
  });

  it('returns NULL for an academy the caller does not manage (tenant scope)', async () => {
    const r = await asUser(MGR_B, () => academyAnalytics(ACAD_A, 12)); // MGR_B manages ACAD_B
    expect(r).toBeNull();
  });
});

describe('get_trainer_dashboard_analytics', () => {
  it('returns the caller-scoped trainer series + KPIs', async () => {
    const r = await asUser(TUSER_A, () => trainerAnalytics(12));
    expect(r).not.toBeNull();
    expect(r!.monthly).toHaveLength(12);
    const cur = r!.monthly[r!.monthly.length - 1];
    expect(Number(cur.revenue)).toBe(50);   // same slot's paid bookings
    expect(Number(cur.expenses)).toBe(8);
    expect(Number(cur.profit)).toBe(42);
    // this-month new players: 3 registered (first non-cancelled bookings on the trainer's slot,
    // incl. the still-pending one) + 1 guest; the last-month booking counts in the prior month.
    expect(Number(cur.new_registered)).toBe(3);
    expect(Number(cur.new_guest)).toBe(1);
    const k = r!.kpis;
    expect(Number(k.revenue_this_month)).toBe(50);
    expect(Number(k.revenue_last_month)).toBe(40);
    expect(Number(k.new_players_this_month)).toBe(4);
    expect(Number(k.new_players_last_month)).toBe(1);
    expect(Number(k.outstanding_invoices)).toBe(1);
  });

  it('returns NULL when the caller has no trainer profile', async () => {
    const r = await asUser(NOUSER, () => trainerAnalytics(12));
    expect(r).toBeNull();
  });
});
