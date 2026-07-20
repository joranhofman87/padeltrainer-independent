// @vitest-environment node
// Notification Foundation v2 — PR 6b: the paid-booking STAFF fan-out → outbox
// (booking_confirmed_staff + migration 20260916100000 which flips it to required-delivery).
// Pins the RESOLVER layer the edge fan-out (sendStaffBookingNotifications) drives:
//   * a staff recipient (account holder) is delivered via the persons.email ACCOUNT fallback,
//   * the row is TENANT-scoped — a manager's to their ACADEMY, a trainer's to their TRAINER —
//     and tenant_visible, so PR-7 timelines show it only inside that scope (never cross-tenant),
//   * booking_confirmed_staff is REQUIRED-delivery → a staff account with NO email yields a
//     VISIBLE skipped/no_email_contact row (not a silent drop),
//   * per-recipient idempotency: the SAME payment re-enqueued for a person is a no-op, and two
//     distinct staff persons get two distinct rows (fan-out).
// Runs the REAL schema + resolver + PR-6b migrations.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;
const MIG = (n: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', n), 'utf8');

const A1 = '0a000000-0000-0000-0000-0000000000a1'; // academy 1
const A2 = '0a000000-0000-0000-0000-0000000000a2'; // academy 2
const T1 = '0c000000-0000-0000-0000-0000000000c1'; // trainer 1 (in academy 1)
const U_M = '0e000000-0000-0000-0000-0000000000e1'; // academy manager login
const P_M = '0d000000-0000-0000-0000-0000000000d1'; // manager person (has email)
const U_T = '0e000000-0000-0000-0000-0000000000e2'; // trainer login
const P_T = '0d000000-0000-0000-0000-0000000000d2'; // trainer person (has email)
const U_N = '0e000000-0000-0000-0000-0000000000e3'; // staff login with NO email
const P_N = '0d000000-0000-0000-0000-0000000000d3'; // that person (no email)

type OutRow = {
  outbox_id: string; channel: string; status: string; skip_reason: string | null;
  recipient_user_id: string | null; recipient_person_id: string | null;
  tenant_academy_profile_id: string | null; tenant_trainer_id: string | null; visibility_scope: string;
  destination_normalized: string | null; public_summary: { sessions?: number } | null;
};

// enqueue INSERTs-then-RETURNS; re-reading the outbox in the same statement hits the pre-insert
// snapshot, so take the resolver's own returned cols, then fetch the omitted tenant_* separately.
async function enqueueStaff(opts: { user: string; academy: string | null; trainer: string | null; payment: string; sessions?: number }): Promise<{ rows: OutRow[] }> {
  const e = await db.query<{
    outbox_id: string; channel: string; status: string; skip_reason: string | null;
    visibility_scope: string; destination_normalized: string | null; recipient_person_id: string | null;
  }>(`
    SELECT outbox_id, channel, status, skip_reason, visibility_scope, destination_normalized, recipient_person_id
    FROM public.enqueue_notification(
      'booking_confirmed_staff', NULL, '${opts.user}'::uuid, NULL,
      ${opts.academy ? `'${opts.academy}'::uuid` : 'NULL'},
      ${opts.trainer ? `'${opts.trainer}'::uuid` : 'NULL'},
      NULL, NULL, NULL, '${opts.payment}', NULL,
      '{"subject":"New booking","html":"<p>ok</p>"}'::jsonb,
      '{"event_type":"booking_confirmed_staff","sessions":${opts.sessions ?? 1}}'::jsonb)`);
  if (e.rows.length === 0) return { rows: [] };
  const merged: OutRow[] = [];
  for (const r of e.rows) {
    const o = (await db.query<{ recipient_user_id: string | null; tenant_academy_profile_id: string | null; tenant_trainer_id: string | null; public_summary: { sessions?: number } | null }>(
      `SELECT recipient_user_id, tenant_academy_profile_id, tenant_trainer_id, public_summary FROM public.notification_outbox WHERE id = '${r.outbox_id}'`)).rows[0];
    merged.push({ ...r, ...o });
  }
  return { rows: merged };
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT NULL::uuid $fn$;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE TABLE public.persons (id uuid PRIMARY KEY, user_id uuid, email text);
    CREATE TABLE public.person_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), person_id uuid, guest_player_id uuid);
    CREATE TABLE public.invoices (id uuid PRIMARY KEY);
    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.email_address_state (email text PRIMARY KEY, state text NOT NULL);
    CREATE OR REPLACE FUNCTION public.is_email_suppressed(p_email text) RETURNS boolean LANGUAGE sql STABLE AS $fn$
      SELECT EXISTS (SELECT 1 FROM public.email_address_state WHERE email = lower(btrim(p_email)) AND state IN ('hard_bounced','complained')); $fn$;
    CREATE TABLE public.email_delivery_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), resend_event_id text, resend_email_id text,
      event_type text NOT NULL, bounce_type text, reason text, recipient_email text NOT NULL,
      invoice_id uuid, academy_profile_id uuid, trainer_id uuid,
      occurred_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now());
  `);
  await db.exec(MIG('20260910100000_notification_foundation_schema.sql'));
  await db.exec(MIG('20260911100000_notification_resolver.sql'));
  await db.exec(MIG('20260916100000_notification_staff_required_delivery.sql'));
  await db.exec(`
    INSERT INTO auth.users (id) VALUES ('${U_M}'), ('${U_T}'), ('${U_N}');
    INSERT INTO public.persons (id, user_id, email) VALUES
      ('${P_M}','${U_M}','manager@academy.nl'),
      ('${P_T}','${U_T}','trainer@example.com'),
      ('${P_N}','${U_N}', NULL);
    INSERT INTO public.academy_profiles (id) VALUES ('${A1}'), ('${A2}');
    INSERT INTO public.trainer_profiles (id, user_id) VALUES ('${T1}','${U_T}');
  `);
});

beforeEach(async () => {
  await db.exec(`DELETE FROM public.notification_outbox; DELETE FROM public.email_address_state;`);
});

describe('booking_confirmed_staff — the paid-booking staff fan-out', () => {
  it('is required-delivery after the PR-6b migration', async () => {
    const r = (await db.query<{ required_delivery: boolean; visibility_scope: string }>(
      `SELECT required_delivery, visibility_scope FROM public.notification_event_types WHERE key='booking_confirmed_staff'`)).rows[0];
    expect(r.required_delivery).toBe(true);
    expect(r.visibility_scope).toBe('tenant_visible');
  });

  it('academy MANAGER → a pending, tenant_visible row scoped to the ACADEMY, delivered via account fallback', async () => {
    const r = (await enqueueStaff({ user: U_M, academy: A1, trainer: null, payment: 'pay_m' })).rows[0];
    expect(r.status).toBe('pending');
    expect(r.recipient_user_id).toBe(U_M);
    expect(r.recipient_person_id).toBe(P_M);
    expect(r.tenant_academy_profile_id).toBe(A1);
    expect(r.tenant_trainer_id).toBeNull();
    expect(r.visibility_scope).toBe('tenant_visible');
    expect(r.destination_normalized).toBe('manager@academy.nl'); // persons.email account fallback
    expect(r.public_summary?.sessions).toBe(1);
  });

  it('TRAINER → a pending row scoped to the TRAINER (not the academy)', async () => {
    const r = (await enqueueStaff({ user: U_T, academy: null, trainer: T1, payment: 'pay_t', sessions: 3 })).rows[0];
    expect(r.status).toBe('pending');
    expect(r.tenant_trainer_id).toBe(T1);
    expect(r.tenant_academy_profile_id).toBeNull();
    expect(r.destination_normalized).toBe('trainer@example.com');
    expect(r.public_summary?.sessions).toBe(3);
  });

  it('REQUIRED-delivery: a staff account with NO email → a VISIBLE skipped/no_email_contact row', async () => {
    const r = (await enqueueStaff({ user: U_N, academy: A1, trainer: null, payment: 'pay_n' })).rows[0];
    expect(r.status).toBe('skipped');
    expect(r.skip_reason).toBe('no_email_contact');
    expect(r.recipient_user_id).toBe(U_N);
  });

  it('cross-tenant: the same manager in academy A vs academy B produces DISTINCT rows, each scoped to its own academy', async () => {
    const a = (await enqueueStaff({ user: U_M, academy: A1, trainer: null, payment: 'pay_a' })).rows[0];
    const b = (await enqueueStaff({ user: U_M, academy: A2, trainer: null, payment: 'pay_b' })).rows[0];
    expect(a.tenant_academy_profile_id).toBe(A1);
    expect(b.tenant_academy_profile_id).toBe(A2);
    expect(a.outbox_id).not.toBe(b.outbox_id);
  });

  it('per-recipient fan-out: two distinct staff persons for the same payment → two distinct rows', async () => {
    const mgr = (await enqueueStaff({ user: U_M, academy: A1, trainer: null, payment: 'pay_x' })).rows;
    const trn = (await enqueueStaff({ user: U_T, academy: null, trainer: T1, payment: 'pay_x' })).rows;
    expect(mgr).toHaveLength(1);
    expect(trn).toHaveLength(1);
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.notification_outbox`)).rows[0].n).toBe(2);
  });

  it('idempotency: the SAME payment + SAME staff person re-enqueued is a no-op', async () => {
    const first = (await enqueueStaff({ user: U_M, academy: A1, trainer: null, payment: 'pay_dupe' })).rows;
    expect(first).toHaveLength(1);
    const second = (await enqueueStaff({ user: U_M, academy: A1, trainer: null, payment: 'pay_dupe' })).rows;
    expect(second).toHaveLength(0);
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.notification_outbox WHERE recipient_user_id='${U_M}'`)).rows[0].n).toBe(1);
  });
});
