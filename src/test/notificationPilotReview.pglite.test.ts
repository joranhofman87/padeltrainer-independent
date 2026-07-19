// @vitest-environment node
// Notification Foundation v2 — PR 5 pilot (migration 20260913100000).
// Pins the first real notification wired onto the spine: an AFTER INSERT trigger on
// reviews enqueues review_received_trainer to the reviewed trainer — but ONLY for a
// review tied to a real booking of that player with that trainer (the reviews RLS only
// checks player_id and booking_id has no FK, so the trigger must authorize the link or
// it becomes an email-spam vector). Asserts the happy path, the security guard (forged
// trainer_id / random booking / non-confirmed status → no send), and insert-safety.
// Runs the REAL schema + resolver + pilot migrations.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;
const MIG = (n: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', n), 'utf8');

const U_T = 'e0000000-0000-0000-0000-0000000000a1'; // trainer WITH email
const P_T = 'd0000000-0000-0000-0000-0000000000a1';
const TP  = 'c0000000-0000-0000-0000-0000000000a1';
const U_T2 = 'e0000000-0000-0000-0000-0000000000a2'; // trainer WITHOUT email
const P_T2 = 'd0000000-0000-0000-0000-0000000000a2';
const TP2 = 'c0000000-0000-0000-0000-0000000000a2';
const PL  = 'b0000000-0000-0000-0000-0000000000b1'; // the reviewing player
const S1  = 'f0000000-0000-0000-0000-00000000001a'; // slot of TP
const S2  = 'f0000000-0000-0000-0000-00000000002a'; // slot of TP2
const B1  = 'a1000000-0000-0000-0000-0000000000b1'; // valid completed booking: PL with TP
const B2  = 'a1000000-0000-0000-0000-0000000000b2'; // another valid: PL with TP
const B3  = 'a1000000-0000-0000-0000-0000000000b3'; // valid: PL with TP2
const BP  = 'a1000000-0000-0000-0000-0000000000bf'; // PENDING booking: PL with TP

const insertReview = (over: Record<string, string> = {}) => {
  const cols: Record<string, string> = {
    booking_id: `'${B1}'`, player_id: `'${PL}'`, trainer_id: `'${TP}'`,
    rating: '5', comment: `'great session'`, is_anonymous: 'false', reviewer_name: `'Jamie'`,
    ...over,
  };
  return db.query<{ id: string }>(
    `INSERT INTO public.reviews (${Object.keys(cols).join(', ')}) VALUES (${Object.values(cols).join(', ')}) RETURNING id`);
};
const outboxCount = async () =>
  (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.notification_outbox`)).rows[0].n;
const reviewCount = async () =>
  (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.reviews`)).rows[0].n;

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
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, trainer_id uuid NOT NULL);
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY, slot_id uuid NOT NULL, player_id uuid NOT NULL,
      status text NOT NULL DEFAULT 'pending');
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
    INSERT INTO public.availability_slots (id, trainer_id) VALUES ('${S1}','${TP}'), ('${S2}','${TP2}');
    INSERT INTO public.bookings (id, slot_id, player_id, status) VALUES
      ('${B1}','${S1}','${PL}','completed'), ('${B2}','${S1}','${PL}','completed'),
      ('${B3}','${S2}','${PL}','completed'), ('${BP}','${S1}','${PL}','pending');
  `);
});

beforeEach(async () => {
  await db.exec(`TRUNCATE public.notification_outbox CASCADE; DELETE FROM public.reviews; DELETE FROM public.email_address_state;`);
});

describe('happy path — a legitimate review enqueues to the trainer', () => {
  it('creates the correct tenant_visible outbox row (delivered via the account-holder persons.email fallback)', async () => {
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
    expect(r.recipient_person_id).toBe(P_T);
    expect(r.tenant_trainer_id).toBe(TP);
    expect(r.visibility_scope).toBe('tenant_visible');
    expect(r.destination_normalized).toBe('trainer@example.com');
    expect(r.idempotency_key).toBe(`review_received_trainer:${reviewId}:${P_T}`);
    expect(r.public_summary).toMatchObject({ event_type: 'review_received_trainer', rating: 4 });
    expect(r.payload.subject).toContain('New Review Received');
    expect(r.payload.html).toContain('4-star review');
  });

  it('distinct booking → distinct review → distinct outbox row', async () => {
    await insertReview({ booking_id: `'${B1}'` });
    await insertReview({ booking_id: `'${B2}'` });
    expect(await outboxCount()).toBe(2);
  });
});

describe('SECURITY — the trigger authorizes the player↔trainer booking link', () => {
  it('owned player_id + FORGED trainer_id (real booking is with a different trainer) → review inserts but NO email', async () => {
    // booking B1 is PL-with-TP, but the review claims TP2 → no verifiable session → no enqueue
    const { rows } = await insertReview({ booking_id: `'${B1}'`, trainer_id: `'${TP2}'` });
    expect(rows).toHaveLength(1);            // the review row still inserts (pre-existing RLS)
    expect(await outboxCount()).toBe(0);     // but the platform sends nothing
  });

  it('RANDOM booking_id (no such booking) → review inserts but NO email', async () => {
    const { rows } = await insertReview({ booking_id: `'a1000000-0000-0000-0000-00000000dead'` });
    expect(rows).toHaveLength(1);
    expect(await outboxCount()).toBe(0);
  });

  it("booking that isn't completed/confirmed (pending) → NO email", async () => {
    await insertReview({ booking_id: `'${BP}'` });
    expect(await outboxCount()).toBe(0);
  });
});

describe('deliverability edge cases (verified booking, but no reachable email)', () => {
  it('a trainer with NO email — verified booking still does not block the insert, and no row is produced', async () => {
    const { rows } = await insertReview({ booking_id: `'${B3}'`, trainer_id: `'${TP2}'` });
    expect(rows).toHaveLength(1);
    expect(await outboxCount()).toBe(0);
    expect(await reviewCount()).toBe(1);
  });

  it('a suppressed trainer email → no deliverable row (not required_delivery)', async () => {
    await db.query(`INSERT INTO public.email_address_state (email, state) VALUES ('trainer@example.com','hard_bounced')`);
    await insertReview({ booking_id: `'${B1}'` });
    expect(await outboxCount()).toBe(0);
  });
});
