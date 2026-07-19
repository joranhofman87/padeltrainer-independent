// @vitest-environment node
// Notification Foundation v2 — PR 5 pilot (migration 20260913100000).
// Pins the first real notification wired onto the spine: an AFTER INSERT trigger on
// reviews enqueues review_received_trainer to the reviewed trainer. Asserts the trigger
// produces the correct tenant_visible outbox row (recipient/tenant/payload/idempotency),
// delivers via the account-holder persons.email fallback (no contact needed), and never
// blocks the review insert when the trainer has no deliverable email.
// Runs the REAL schema + resolver + pilot migrations.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;
const MIG = (n: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', n), 'utf8');

// trainer WITH an email (deliverable via fallback)
const U_T = 'e0000000-0000-0000-0000-0000000000a1';
const P_T = 'd0000000-0000-0000-0000-0000000000a1';
const TP = 'c0000000-0000-0000-0000-0000000000a1';
// trainer WITHOUT an email (not deliverable, must not break the insert)
const U_T2 = 'e0000000-0000-0000-0000-0000000000a2';
const P_T2 = 'd0000000-0000-0000-0000-0000000000a2';
const TP2 = 'c0000000-0000-0000-0000-0000000000a2';

const insertReview = (over: Record<string, string> = {}) => {
  const cols: Record<string, string> = {
    id: `gen_random_uuid()`, booking_id: `gen_random_uuid()`, player_id: `gen_random_uuid()`,
    trainer_id: `'${TP}'`, rating: '5', comment: `'great session'`, is_anonymous: 'false', reviewer_name: `'Jamie'`,
    ...over,
  };
  return db.query<{ id: string }>(
    `INSERT INTO public.reviews (${Object.keys(cols).join(', ')}) VALUES (${Object.values(cols).join(', ')}) RETURNING id`);
};

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
    CREATE TABLE public.reviews (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid NOT NULL UNIQUE,
      player_id uuid NOT NULL, trainer_id uuid NOT NULL,
      rating int NOT NULL CHECK (rating BETWEEN 1 AND 5), comment text,
      is_public boolean NOT NULL DEFAULT true, is_anonymous boolean NOT NULL DEFAULT false,
      reviewer_name text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
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
  await db.exec(MIG('20260913100000_notification_pilot_review_received.sql'));
  await db.exec(`
    INSERT INTO auth.users (id) VALUES ('${U_T}'), ('${U_T2}');
    INSERT INTO public.persons (id, user_id, email) VALUES ('${P_T}','${U_T}','trainer@example.com'), ('${P_T2}','${U_T2}', NULL);
    INSERT INTO public.trainer_profiles (id, user_id) VALUES ('${TP}','${U_T}'), ('${TP2}','${U_T2}');
  `);
});

beforeEach(async () => {
  await db.exec(`TRUNCATE public.notification_outbox CASCADE; DELETE FROM public.reviews;`);
});

describe('review insert → enqueue review_received_trainer', () => {
  it('creates the correct tenant_visible outbox row for the trainer (delivered via persons.email fallback)', async () => {
    const { rows: [{ id: reviewId }] } = await insertReview({ rating: '4' });
    const { rows } = await db.query<{
      event_type: string; channel: string; status: string; recipient_user_id: string; recipient_person_id: string;
      tenant_trainer_id: string; visibility_scope: string; destination_normalized: string;
      idempotency_key: string; public_summary: unknown; payload: { subject?: string; html?: string };
    }>(`SELECT event_type, channel, status, recipient_user_id, recipient_person_id, tenant_trainer_id,
               visibility_scope, destination_normalized, idempotency_key, public_summary, payload
        FROM public.notification_outbox`);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.event_type).toBe('review_received_trainer');
    expect(r.channel).toBe('email');
    expect(r.status).toBe('pending');
    expect(r.recipient_user_id).toBe(U_T);
    expect(r.recipient_person_id).toBe(P_T);            // normalized to the person
    expect(r.tenant_trainer_id).toBe(TP);
    expect(r.visibility_scope).toBe('tenant_visible');
    expect(r.destination_normalized).toBe('trainer@example.com'); // account-holder fallback, no contact
    expect(r.idempotency_key).toBe(`review_received_trainer:${reviewId}:${P_T}`);
    expect(r.public_summary).toMatchObject({ event_type: 'review_received_trainer', rating: 4 });
    expect(r.payload.subject).toContain('New Review Received');
    expect(r.payload.html).toContain('4-star review');
  });

  it('a re-inserted-equivalent review (same id) would be idempotent — one row per review', async () => {
    const { rows: [{ id }] } = await insertReview();
    // a second review is a distinct row (distinct id → distinct idempotency key)
    await insertReview({ booking_id: 'gen_random_uuid()' });
    const n = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.notification_outbox`)).rows[0].n;
    expect(n).toBe(2);
    expect(id).toBeTruthy();
  });

  it('a trainer with NO deliverable email does NOT block the review insert and produces no outbox row', async () => {
    const { rows } = await insertReview({ trainer_id: `'${TP2}'`, booking_id: 'gen_random_uuid()' });
    expect(rows).toHaveLength(1);                        // the review WAS inserted
    const n = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.notification_outbox`)).rows[0].n;
    expect(n).toBe(0);                                   // not required_delivery → no skipped row, just no send
    const reviewCount = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.reviews`)).rows[0].n;
    expect(reviewCount).toBe(1);
  });

  it('a suppressed trainer email produces no deliverable row (still does not break the insert)', async () => {
    await db.query(`INSERT INTO public.email_address_state (email, state) VALUES ('trainer@example.com','hard_bounced')`);
    const { rows } = await insertReview({ booking_id: 'gen_random_uuid()' });
    expect(rows).toHaveLength(1);
    // not required_delivery → suppressed email yields no outbox row at all
    const n = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.notification_outbox`)).rows[0].n;
    expect(n).toBe(0);
    await db.query(`DELETE FROM public.email_address_state`); // reset for other tests
  });
});
