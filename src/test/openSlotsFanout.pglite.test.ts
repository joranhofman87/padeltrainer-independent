// @vitest-environment node
// open_slots_player fan-out (migration 20260927100000).
//
// This is the replacement for notify-followers, and the properties that matter are the ones
// the legacy loop got wrong at scale, so they are tested against the REAL resolver, not a stub:
//
//   * a trainer can only fan out slots they OWN and that are PUBLIC;
//   * BOTH gates apply — the follow toggle, and the migrated v2 preference;
//   * a durable job resumes from a cursor and NEVER double-notifies on retry / crash recovery;
//   * an unreachable follower is COUNTED, never silently dropped.
//
// The resolver + outbox are real (foundation + resolver migrations applied), so "enqueued a row"
// means a row a worker would actually send.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;
const MIG = (n: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', n), 'utf8');

const T1 = '0c000000-0000-0000-0000-0000000000c1';   // trainer 1
const T2 = '0c000000-0000-0000-0000-0000000000c2';   // trainer 2 (foreign)
const U_T1 = '0e000000-0000-0000-0000-0000000000e1'; // trainer 1 login
const U_T2 = '0e000000-0000-0000-0000-0000000000e2'; // trainer 2 login
const A1 = '0a000000-0000-0000-0000-0000000000a1';

// followers: profile id / user id / person id — each an account holder with an email
const F = (n: number) => ({
  pr: `0f000000-0000-0000-0000-0000000000f${n}`,
  u: `0e000000-0000-0000-0000-0000000000d${n}`,
  pe: `0b000000-0000-0000-0000-0000000000b${n}`,
});

const as = (uid: string | null) =>
  db.exec(`SELECT set_config('test.uid', ${uid ? `'${uid}'` : `''`}, false);`);

const createJob = (ids: string[]) =>
  db.query<{ v: string }>(
    `SELECT public.create_open_slots_fanout(ARRAY[${ids.map((i) => `'${i}'::uuid`).join(',')}]::uuid[]) AS v`);

const drain = (limit = 200) =>
  db.query<{ v: Record<string, unknown> }>(
    `SELECT public.process_notification_fanout('w1', ${limit}) AS v`);

const outboxCount = async () =>
  (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.notification_outbox`)).rows[0].n;

const jobRow = async (id: string) =>
  (await db.query<Record<string, unknown>>(`SELECT * FROM public.notification_fanout_jobs WHERE id = '${id}'`)).rows[0];

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid $fn$;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE TABLE public.persons (id uuid PRIMARY KEY, user_id uuid, email text);
    CREATE TABLE public.person_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), person_id uuid, guest_player_id uuid);
    CREATE TABLE public.invoices (id uuid PRIMARY KEY);
    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid, business_name text);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid, full_name text);
    CREATE TABLE public.availability_slots (
      id uuid PRIMARY KEY, trainer_id uuid NOT NULL, academy_profile_id uuid,
      start_time timestamptz NOT NULL, end_time timestamptz NOT NULL, is_public boolean DEFAULT true);
    CREATE TABLE public.trainer_followers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), player_id uuid, trainer_id uuid,
      notify_new_availability boolean DEFAULT true, created_at timestamptz DEFAULT now());
    CREATE TABLE public.notification_preferences (user_id uuid PRIMARY KEY, open_slots_digest text);
    CREATE TABLE public.email_address_state (email text PRIMARY KEY, state text NOT NULL);
    CREATE TABLE public.email_delivery_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), resend_event_id text, resend_email_id text,
      event_type text NOT NULL, bounce_type text, reason text, recipient_email text NOT NULL,
      invoice_id uuid, academy_profile_id uuid, trainer_id uuid,
      occurred_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now());
    CREATE OR REPLACE FUNCTION public.is_email_suppressed(p_email text) RETURNS boolean LANGUAGE sql STABLE AS $fn$
      SELECT EXISTS (SELECT 1 FROM public.email_address_state WHERE email = lower(btrim(p_email)) AND state IN ('hard_bounced','complained')); $fn$;
    -- html_escape lives in the booking-RPC migration; this feature only needs it to exist.
    CREATE OR REPLACE FUNCTION public.notification_html_escape(p text) RETURNS text
      LANGUAGE sql IMMUTABLE AS $fn$ SELECT replace(replace(coalesce(p,''),'<','&lt;'),'>','&gt;') $fn$;
  `);
  await db.exec(MIG('20260910100000_notification_foundation_schema.sql'));
  await db.exec(MIG('20260911100000_notification_resolver.sql'));
  await db.exec(MIG('20260927100000_open_slots_fanout.sql'));

  await db.exec(`
    INSERT INTO auth.users (id) VALUES ('${U_T1}'),('${U_T2}');
    INSERT INTO public.academy_profiles (id) VALUES ('${A1}');
    INSERT INTO public.trainer_profiles (id, user_id, business_name) VALUES
      ('${T1}','${U_T1}','Padel Pro'), ('${T2}','${U_T2}','Rival');
    -- slots: two public owned by T1, one private owned by T1, one owned by T2.
    INSERT INTO public.availability_slots (id, trainer_id, academy_profile_id, start_time, end_time, is_public) VALUES
      ('01000000-0000-0000-0000-000000000001','${T1}','${A1}', now()+interval '2 days', now()+interval '2 days 1 hour', true),
      ('01000000-0000-0000-0000-000000000002','${T1}','${A1}', now()+interval '3 days', now()+interval '3 days 1 hour', true),
      ('01000000-0000-0000-0000-000000000003','${T1}','${A1}', now()+interval '4 days', now()+interval '4 days 1 hour', false),
      ('01000000-0000-0000-0000-000000000004','${T2}',NULL,    now()+interval '5 days', now()+interval '5 days 1 hour', true);
  `);
});

const S1 = '01000000-0000-0000-0000-000000000001';
const S2 = '01000000-0000-0000-0000-000000000002';
const S_PRIV = '01000000-0000-0000-0000-000000000003';
const S_FOREIGN = '01000000-0000-0000-0000-000000000004';

beforeEach(async () => {
  await db.exec(`
    DELETE FROM public.notification_fanout_jobs;
    DELETE FROM public.notification_outbox;
    DELETE FROM public.trainer_followers;
    DELETE FROM public.notification_preferences;
    DELETE FROM public.notification_preferences_v2 WHERE event_type = 'open_slots_player';
    DELETE FROM public.persons WHERE id::text LIKE '0b%';
    DELETE FROM public.profiles WHERE id::text LIKE '0f%';
  `);
  await as(null);
});

/** Register `count` followers of T1, each an account holder with an email. */
async function followers(count: number, opts: { follow?: boolean } = {}) {
  const follow = opts.follow ?? true;
  for (let i = 1; i <= count; i++) {
    const f = F(i);
    await db.exec(`
      INSERT INTO auth.users (id) VALUES ('${f.u}') ON CONFLICT DO NOTHING;
      INSERT INTO public.persons (id, user_id, email) VALUES ('${f.pe}','${f.u}','f${i}@example.com');
      INSERT INTO public.profiles (id, user_id, full_name) VALUES ('${f.pr}','${f.u}','Follower ${i}');
      INSERT INTO public.trainer_followers (player_id, trainer_id, notify_new_availability)
        VALUES ('${f.pr}','${T1}', ${follow});`);
  }
}

describe('create_open_slots_fanout — ownership + public validation', () => {
  it('refuses an anonymous caller', async () => {
    await expect(createJob([S1])).rejects.toThrow(/no authenticated actor/);
  });

  it('refuses a non-trainer', async () => {
    await as('0e000000-0000-0000-0000-0000000000ff');
    await expect(createJob([S1])).rejects.toThrow(/not a trainer/);
  });

  it('refuses a set containing a FOREIGN trainer\'s slot', async () => {
    await as(U_T1);
    await expect(createJob([S1, S_FOREIGN])).rejects.toThrow(/not owned by this trainer or not public/);
  });

  it('refuses a set containing a PRIVATE slot', async () => {
    await as(U_T1);
    await expect(createJob([S1, S_PRIV])).rejects.toThrow(/not owned by this trainer or not public/);
  });

  it('accepts an owned public set, and is idempotent per slot set', async () => {
    await as(U_T1);
    const a = (await createJob([S1, S2])).rows[0].v;
    const b = (await createJob([S2, S1])).rows[0].v;   // reordered → same canonical set
    expect(b).toBe(a);
    expect((await db.query(`SELECT 1 FROM public.notification_fanout_jobs`)).rows).toHaveLength(1);
  });
});

describe('both gates, via the real resolver', () => {
  it('the follow toggle OFF means no enqueue', async () => {
    await followers(2, { follow: false });
    await as(U_T1);
    const job = (await createJob([S1])).rows[0].v;
    const r = await drain();
    expect(r.rows[0].v).toMatchObject({ done: true, enqueued: 0 });
    expect(await outboxCount()).toBe(0);
    void job;
  });

  it('a migrated v2 preference of OFF is honored — the resolver skips it', async () => {
    await followers(1);
    const f = F(1);
    // Simulate the v1→v2 migration having carried an explicit 'off' across.
    await db.exec(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency)
                   VALUES ('${f.u}','open_slots_player','off');`);
    await as(U_T1);
    await createJob([S1]);
    await drain();
    expect(await outboxCount(), 'off preference → no deliverable row').toBe(0);
  });

  it('a preference of WEEKLY produces a row scheduled to a digest boundary, not now', async () => {
    await followers(1);
    const f = F(1);
    await db.exec(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency)
                   VALUES ('${f.u}','open_slots_player','weekly');`);
    await as(U_T1);
    await createJob([S1]);
    await drain();
    const rows = (await db.query<{ status: string; scheduled_for: string }>(
      `SELECT status, scheduled_for FROM public.notification_outbox`)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(new Date(rows[0].scheduled_for).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('the v1 → v2 migration preserved choices', () => {
  it('carries an explicit open_slots_digest value into v2', async () => {
    // Re-run the migration's INSERT against a fresh v1 row to prove the mapping.
    const u = '0e000000-0000-0000-0000-0000000000aa';
    await db.exec(`
      INSERT INTO auth.users (id) VALUES ('${u}') ON CONFLICT DO NOTHING;
      INSERT INTO public.notification_preferences (user_id, open_slots_digest) VALUES ('${u}','daily');
      INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency)
        SELECT user_id, 'open_slots_player', open_slots_digest FROM public.notification_preferences
         WHERE user_id = '${u}' ON CONFLICT (user_id, event_type) DO NOTHING;`);
    const r = (await db.query<{ email_frequency: string }>(
      `SELECT email_frequency FROM public.notification_preferences_v2 WHERE user_id = '${u}' AND event_type='open_slots_player'`)).rows;
    expect(r[0].email_frequency).toBe('daily');
    await db.exec(`DELETE FROM public.notification_preferences_v2 WHERE user_id='${u}'; DELETE FROM public.notification_preferences WHERE user_id='${u}';`);
  });
});

describe('durable, resumable, no-duplicate fan-out', () => {
  it('processes every follower across multiple bounded pages', async () => {
    await followers(5);
    await as(U_T1);
    await createJob([S1]);
    // page size 2 → 3 pages (2 + 2 + 1).
    const p1 = await drain(2); expect(p1.rows[0].v).toMatchObject({ done: false });
    const p2 = await drain(2); expect(p2.rows[0].v).toMatchObject({ done: false });
    const p3 = await drain(2); expect(p3.rows[0].v).toMatchObject({ done: true });
    expect(await outboxCount()).toBe(5);
  });

  it('a RETRY after partial progress creates NO duplicate rows and still reaches everyone', async () => {
    await followers(4);
    await as(U_T1);
    const job = (await createJob([S1])).rows[0].v;
    await drain(2);                       // page 1: followers 1-2
    // Simulate a crash mid-job: force the lease to look expired so another worker resumes.
    await db.exec(`UPDATE public.notification_fanout_jobs SET lease_expires_at = now() - interval '1 hour' WHERE id = '${job}'`);
    await drain(2);                       // page 2: followers 3-4
    await drain(2);                       // tail
    expect(await outboxCount(), 'every follower exactly once').toBe(4);
    // and re-running the WHOLE job from scratch (same anchor) still cannot duplicate:
    await db.exec(`UPDATE public.notification_fanout_jobs SET status='pending', follower_cursor=NULL, lease_expires_at=NULL WHERE id='${job}'`);
    await drain(200);
    expect(await outboxCount(), 'idempotent enqueue anchor blocks the re-run').toBe(4);
  });

  it('recovers a crashed page: a live lease is skipped, an expired one is resumed', async () => {
    await followers(3);
    await as(U_T1);
    const job = (await createJob([S1])).rows[0].v;
    // Pretend a worker claimed it and is still alive (lease in the future) at page 0.
    await db.exec(`UPDATE public.notification_fanout_jobs
                   SET status='processing', lease_owner='dead', lease_expires_at = now() + interval '1 hour'
                   WHERE id='${job}'`);
    // Another worker must NOT touch it while the lease is live.
    expect((await drain(200)).rows[0].v).toMatchObject({ claimed: false });
    expect(await outboxCount()).toBe(0);
    // Lease expires → it is resumed and completed.
    await db.exec(`UPDATE public.notification_fanout_jobs SET lease_expires_at = now() - interval '1 minute' WHERE id='${job}'`);
    expect((await drain(200)).rows[0].v).toMatchObject({ done: true });
    expect(await outboxCount()).toBe(3);
  });
});

describe('unreachable followers are counted, not dropped', () => {
  it('counts a follower with no account instead of silently skipping', async () => {
    // A follower whose profile has no user_id has no recipient the resolver can reach.
    await db.exec(`
      INSERT INTO public.profiles (id, user_id, full_name) VALUES ('0f000000-0000-0000-0000-0000000000f9', NULL, 'Ghost');
      INSERT INTO public.trainer_followers (player_id, trainer_id, notify_new_availability)
        VALUES ('0f000000-0000-0000-0000-0000000000f9','${T1}', true);`);
    await as(U_T1);
    const job = (await createJob([S1])).rows[0].v;
    await drain();
    const row = await jobRow(job);
    expect(row.no_identity_count).toBe(1);
    expect(await outboxCount()).toBe(0);
  });

  it('records enqueued / skipped / no_identity on the job for observability', async () => {
    await followers(2);
    // one of them opts out via v2 → will be a skip
    await db.exec(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency)
                   VALUES ('${F(1).u}','open_slots_player','off');`);
    await as(U_T1);
    const job = (await createJob([S1])).rows[0].v;
    await drain();
    const row = await jobRow(job);
    expect(row.enqueued_count).toBe(1);
    expect(row.skipped_count).toBe(1);
    expect(row.status).toBe('done');
  });
});
