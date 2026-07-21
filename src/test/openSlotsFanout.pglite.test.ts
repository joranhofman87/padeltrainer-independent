// @vitest-environment node
// open_slots_player fan-out (migration 20260927100000).
//
// The replacement for notify-followers, tested against the REAL resolver. The properties that
// matter are the ones the legacy loop — and the first version of this migration — got wrong:
//
//   * a trainer can only fan out slots they OWN, that are PUBLIC, and in ONE academy scope;
//   * BOTH gates apply — the follow toggle AND the migrated v2 preference;
//   * the DIGEST is real: daily/weekly followers route to the notification_queue aggregator
//     (send-digest-emails → one email with a count), NOT one outbox row per event;
//   * a durable job resumes from a cursor, NEVER double-notifies on retry, and a POISON job
//     dead-letters instead of starving every later job;
//   * producer creation is atomically idempotent per slot set (even after completion);
//   * an unreachable follower is COUNTED, never silently dropped.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;
const MIG = (n: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', n), 'utf8');

const T1 = '0c000000-0000-0000-0000-0000000000c1';
const T2 = '0c000000-0000-0000-0000-0000000000c2';
const U_T1 = '0e000000-0000-0000-0000-0000000000e1';
const U_T2 = '0e000000-0000-0000-0000-0000000000e2';
const A1 = '0a000000-0000-0000-0000-0000000000a1';
const A2 = '0a000000-0000-0000-0000-0000000000a2';

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
const queueCount = async () =>
  (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.notification_queue`)).rows[0].n;
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
    -- the EXISTING v1 digest aggregator that send-digest-emails reads (kept, per Codex).
    CREATE TABLE public.notification_queue (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, notification_type text,
      payload jsonb, scheduled_for text, created_at timestamptz DEFAULT now(), processed_at timestamptz);
    CREATE TABLE public.email_address_state (email text PRIMARY KEY, state text NOT NULL);
    CREATE TABLE public.email_delivery_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), resend_event_id text, resend_email_id text,
      event_type text NOT NULL, bounce_type text, reason text, recipient_email text NOT NULL,
      invoice_id uuid, academy_profile_id uuid, trainer_id uuid,
      occurred_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now());
    CREATE OR REPLACE FUNCTION public.is_email_suppressed(p_email text) RETURNS boolean LANGUAGE sql STABLE AS $fn$
      SELECT EXISTS (SELECT 1 FROM public.email_address_state WHERE email = lower(btrim(p_email)) AND state IN ('hard_bounced','complained')); $fn$;
    CREATE OR REPLACE FUNCTION public.notification_html_escape(p text) RETURNS text
      LANGUAGE sql IMMUTABLE AS $fn$
        SELECT replace(replace(replace(replace(replace(coalesce(p,''),'&','&amp;'),'<','&lt;'),'>','&gt;'),'"','&quot;'),'''','&#39;') $fn$;
  `);
  await db.exec(MIG('20260910100000_notification_foundation_schema.sql'));
  await db.exec(MIG('20260911100000_notification_resolver.sql'));
  await db.exec(MIG('20260927100000_open_slots_fanout.sql'));

  await db.exec(`
    INSERT INTO auth.users (id) VALUES ('${U_T1}'),('${U_T2}');
    INSERT INTO public.academy_profiles (id) VALUES ('${A1}'),('${A2}');
    INSERT INTO public.trainer_profiles (id, user_id, business_name) VALUES
      ('${T1}','${U_T1}','Padel Pro'), ('${T2}','${U_T2}','Rival');
    -- T1 public slots: two in A1, one in A2 (mixed-scope), one private in A1. Plus T2's.
    INSERT INTO public.availability_slots (id, trainer_id, academy_profile_id, start_time, end_time, is_public) VALUES
      ('01000000-0000-0000-0000-000000000001','${T1}','${A1}', now()+interval '2 days', now()+interval '2 days 1 hour', true),
      ('01000000-0000-0000-0000-000000000002','${T1}','${A1}', now()+interval '3 days', now()+interval '3 days 1 hour', true),
      ('01000000-0000-0000-0000-000000000003','${T1}','${A1}', now()+interval '4 days', now()+interval '4 days 1 hour', false),
      ('01000000-0000-0000-0000-000000000005','${T1}','${A2}', now()+interval '6 days', now()+interval '6 days 1 hour', true),
      ('01000000-0000-0000-0000-000000000004','${T2}',NULL,    now()+interval '5 days', now()+interval '5 days 1 hour', true);
  `);
});

const S1 = '01000000-0000-0000-0000-000000000001';
const S2 = '01000000-0000-0000-0000-000000000002';
const S_PRIV = '01000000-0000-0000-0000-000000000003';
const S_OTHER_ACADEMY = '01000000-0000-0000-0000-000000000005';
const S_FOREIGN = '01000000-0000-0000-0000-000000000004';

beforeEach(async () => {
  await db.exec(`
    DELETE FROM public.notification_fanout_jobs;
    DELETE FROM public.notification_outbox;
    DELETE FROM public.notification_queue;
    DELETE FROM public.trainer_followers;
    DELETE FROM public.notification_preferences;
    DELETE FROM public.notification_preferences_v2 WHERE event_type = 'open_slots_player';
    DELETE FROM public.persons WHERE id::text LIKE '0b%';
    DELETE FROM public.profiles WHERE id::text LIKE '0f%';
  `);
  await as(null);
});

/** Register `count` followers of T1, each an account holder, with an explicit frequency. */
async function followers(count: number, opts: { follow?: boolean; freq?: 'off' | 'daily' | 'weekly' | 'instant' } = {}) {
  const follow = opts.follow ?? true;
  for (let i = 1; i <= count; i++) {
    const f = F(i);
    await db.exec(`
      INSERT INTO auth.users (id) VALUES ('${f.u}') ON CONFLICT DO NOTHING;
      INSERT INTO public.persons (id, user_id, email) VALUES ('${f.pe}','${f.u}','f${i}@example.com');
      INSERT INTO public.profiles (id, user_id, full_name) VALUES ('${f.pr}','${f.u}','Follower ${i}');
      INSERT INTO public.trainer_followers (player_id, trainer_id, notify_new_availability)
        VALUES ('${f.pr}','${T1}', ${follow});
      ${opts.freq ? `INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency)
        VALUES ('${f.u}','open_slots_player','${opts.freq}');` : ''}`);
  }
}

describe('create_open_slots_fanout — ownership, public, single-scope validation', () => {
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

  it('refuses a set spanning MULTIPLE academy scopes', async () => {
    // S1 in A1, S_OTHER_ACADEMY in A2 — both owned + public, but no single coherent scope.
    await as(U_T1);
    await expect(createJob([S1, S_OTHER_ACADEMY])).rejects.toThrow(/multiple academy scopes/);
  });

  it('accepts an owned, public, single-scope set', async () => {
    await as(U_T1);
    const id = (await createJob([S1, S2])).rows[0].v;
    expect(id).toBeTruthy();
  });
});

describe('producer idempotency is atomic and survives completion', () => {
  it('returns the SAME job for the same canonical set, regardless of order', async () => {
    await as(U_T1);
    const a = (await createJob([S1, S2])).rows[0].v;
    const b = (await createJob([S2, S1, S1])).rows[0].v;
    expect(b).toBe(a);
    expect((await db.query(`SELECT 1 FROM public.notification_fanout_jobs`)).rows).toHaveLength(1);
  });

  it('returns the SAME job even after it has completed (no second O(followers) scan)', async () => {
    await followers(1, { freq: 'instant' });
    await as(U_T1);
    const a = (await createJob([S1])).rows[0].v;
    await drain();
    expect((await jobRow(a)).status).toBe('done');
    const b = (await createJob([S1])).rows[0].v;
    expect(b).toBe(a);
    expect((await db.query(`SELECT 1 FROM public.notification_fanout_jobs`)).rows).toHaveLength(1);
  });

  it('a UNIQUE index makes concurrent creation converge to one row', async () => {
    await as(U_T1);
    await Promise.all([createJob([S1]), createJob([S1]), createJob([S1])]);
    expect((await db.query(`SELECT 1 FROM public.notification_fanout_jobs`)).rows).toHaveLength(1);
  });
});

describe('both gates + digest routing, via the real resolver', () => {
  it('the follow toggle OFF means neither an outbox nor a queue row', async () => {
    await followers(2, { follow: false, freq: 'instant' });
    await as(U_T1);
    await createJob([S1]);
    await drain();
    expect(await outboxCount()).toBe(0);
    expect(await queueCount()).toBe(0);
  });

  it('a migrated v2 preference of OFF is honored — no row of either kind', async () => {
    await followers(1, { freq: 'off' });
    await as(U_T1);
    await createJob([S1]);
    await drain();
    expect(await outboxCount()).toBe(0);
    expect(await queueCount()).toBe(0);
  });

  it('an INSTANT follower gets an OUTBOX row, not a queue row', async () => {
    await followers(1, { freq: 'instant' });
    await as(U_T1);
    const job = (await createJob([S1])).rows[0].v;
    await drain();
    expect(await outboxCount()).toBe(1);
    expect(await queueCount()).toBe(0);
    expect((await jobRow(job)).enqueued_count).toBe(1);
  });

  it('a WEEKLY follower is DIGESTED via notification_queue, not sent as its own outbox row', async () => {
    await followers(1, { freq: 'weekly' });
    await as(U_T1);
    const job = (await createJob([S1])).rows[0].v;
    await drain();
    expect(await outboxCount(), 'weekly must NOT produce an immediate outbox row').toBe(0);
    const q = (await db.query<{ notification_type: string; scheduled_for: string }>(
      `SELECT notification_type, scheduled_for FROM public.notification_queue`)).rows;
    expect(q).toHaveLength(1);
    expect(q[0].notification_type).toBe('open_slots_digest');   // what send-digest-emails groups on
    expect(q[0].scheduled_for).toBe('weekly');
    expect((await jobRow(job)).digested_count).toBe(1);
  });

  it('an unset follower defaults to WEEKLY (the legacy default), so is digested', async () => {
    await followers(1);
    await as(U_T1);
    await createJob([S1]);
    await drain();
    expect(await queueCount()).toBe(1);
    expect(await outboxCount()).toBe(0);
  });
});

describe('multiple availability batches become ONE digest, not several emails', () => {
  it('two fan-out jobs queue two aggregatable rows for the same weekly follower', async () => {
    // send-digest-emails groups notification_queue by (user, type) and emits ONE email with a
    // count — two rows here is "1 digest saying 2 slots", the legacy semantic. The OLD behaviour
    // (weekly on the outbox) would have been two separate emails at the boundary.
    await followers(1, { freq: 'weekly' });
    await as(U_T1);
    await createJob([S1]); await drain();
    await createJob([S2]); await drain();
    const q = (await db.query<{ user_id: string; notification_type: string }>(
      `SELECT user_id, notification_type FROM public.notification_queue`)).rows;
    expect(q).toHaveLength(2);
    expect(new Set(q.map((r) => r.user_id)).size, 'same recipient → one digest group').toBe(1);
    expect(q.every((r) => r.notification_type === 'open_slots_digest')).toBe(true);
    expect(await outboxCount()).toBe(0);
  });
});

describe('the v1 → v2 migration preserved choices', () => {
  it('carries an explicit open_slots_digest value into v2', async () => {
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
  it('processes every INSTANT follower across multiple bounded pages', async () => {
    await followers(5, { freq: 'instant' });
    await as(U_T1);
    await createJob([S1]);
    expect((await drain(2)).rows[0].v).toMatchObject({ done: false });
    expect((await drain(2)).rows[0].v).toMatchObject({ done: false });
    expect((await drain(2)).rows[0].v).toMatchObject({ done: true });
    expect(await outboxCount()).toBe(5);
  });

  it('a re-run from the start creates NO duplicate outbox rows (idempotent anchor)', async () => {
    await followers(4, { freq: 'instant' });
    await as(U_T1);
    const job = (await createJob([S1])).rows[0].v;
    await drain(200);
    expect(await outboxCount()).toBe(4);
    await db.exec(`UPDATE public.notification_fanout_jobs SET status='pending', follower_cursor=NULL, next_attempt_at=NULL WHERE id='${job}'`);
    await drain(200);
    expect(await outboxCount(), 'idempotent enqueue anchor blocks the re-run').toBe(4);
  });

  it('a WEEKLY re-run creates NO duplicate queue rows (anchor dedupe)', async () => {
    await followers(2, { freq: 'weekly' });
    await as(U_T1);
    const job = (await createJob([S1])).rows[0].v;
    await drain(200);
    expect(await queueCount()).toBe(2);
    await db.exec(`UPDATE public.notification_fanout_jobs SET status='pending', follower_cursor=NULL, next_attempt_at=NULL WHERE id='${job}'`);
    await drain(200);
    expect(await queueCount(), 'anchor dedupe blocks the re-queue').toBe(2);
  });
});

describe('a poison job dead-letters instead of starving the queue', () => {
  it('records failure metadata (rolled-back page) and lets a later healthy job proceed', async () => {
    // Deterministic poison: a job whose event_key does not exist in the catalog, so the page's
    // enqueue_notification raises (FK/lookup). It is OLDER than the healthy job, so it is
    // claimed first; its page rolls back and only the failure metadata commits.
    await as(U_T2);
    const poison = (await db.query<{ v: string }>(
      `SELECT public.create_open_slots_fanout(ARRAY['${S_FOREIGN}']::uuid[]) AS v`)).rows[0].v;
    await db.exec(`
      INSERT INTO auth.users (id) VALUES ('0e000000-0000-0000-0000-0000000000c9');
      INSERT INTO public.persons (id, user_id, email) VALUES ('0b000000-0000-0000-0000-0000000000c9','0e000000-0000-0000-0000-0000000000c9','p@x.com');
      INSERT INTO public.profiles (id, user_id) VALUES ('0f000000-0000-0000-0000-00000000000a','0e000000-0000-0000-0000-0000000000c9');
      INSERT INTO public.trainer_followers (player_id, trainer_id, notify_new_availability) VALUES ('0f000000-0000-0000-0000-00000000000a','${T2}', true);
      INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency) VALUES ('0e000000-0000-0000-0000-0000000000c9','open_slots_player','instant');
      UPDATE public.notification_fanout_jobs SET event_key='does_not_exist' WHERE id='${poison}'`);

    await as(U_T1);
    await followers(1, { freq: 'instant' });
    const healthy = (await createJob([S1])).rows[0].v;

    const p = await drain(200);   // claims the older poison job; its page throws
    expect(p.rows[0].v).toMatchObject({ failed: true });
    const pj = await jobRow(poison);
    expect(pj.attempts).toBe(1);
    expect(pj.last_error).toBeTruthy();
    expect(new Date(pj.next_attempt_at as string).getTime()).toBeGreaterThan(Date.now());
    expect(pj.status).toBe('pending');   // backed off, not yet dead

    const h = await drain(200);   // poison is backed off → the healthy job is reached
    expect(h.rows[0].v).toMatchObject({ claimed: true, done: true });
    expect((await jobRow(healthy)).status).toBe('done');
    expect(await outboxCount()).toBe(1);
  });

  it('dead-letters after MAX_ATTEMPTS so the cron stops retrying it', async () => {
    await as(U_T2);
    const poison = (await db.query<{ v: string }>(
      `SELECT public.create_open_slots_fanout(ARRAY['${S_FOREIGN}']::uuid[]) AS v`)).rows[0].v;
    await db.exec(`
      INSERT INTO auth.users (id) VALUES ('0e000000-0000-0000-0000-0000000000ca');
      INSERT INTO public.persons (id, user_id) VALUES ('0b000000-0000-0000-0000-0000000000ca','0e000000-0000-0000-0000-0000000000ca');
      INSERT INTO public.profiles (id, user_id) VALUES ('0f000000-0000-0000-0000-00000000000b','0e000000-0000-0000-0000-0000000000ca');
      INSERT INTO public.trainer_followers (player_id, trainer_id) VALUES ('0f000000-0000-0000-0000-00000000000b','${T2}');
      INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency) VALUES ('0e000000-0000-0000-0000-0000000000ca','open_slots_player','instant');
      UPDATE public.notification_fanout_jobs SET event_key='does_not_exist' WHERE id='${poison}'`);
    for (let i = 0; i < 5; i++) {
      await db.exec(`UPDATE public.notification_fanout_jobs SET next_attempt_at = now() - interval '1 minute' WHERE id='${poison}'`);
      await drain(200);
    }
    expect((await jobRow(poison)).status).toBe('failed');
  });
});

describe('unreachable followers are counted, not dropped', () => {
  it('counts a follower with no account instead of silently skipping', async () => {
    await db.exec(`
      INSERT INTO public.profiles (id, user_id, full_name) VALUES ('0f000000-0000-0000-0000-0000000000f9', NULL, 'Ghost');
      INSERT INTO public.trainer_followers (player_id, trainer_id, notify_new_availability)
        VALUES ('0f000000-0000-0000-0000-0000000000f9','${T1}', true);`);
    await as(U_T1);
    const job = (await createJob([S1])).rows[0].v;
    await drain();
    expect((await jobRow(job)).no_identity_count).toBe(1);
    expect(await outboxCount()).toBe(0);
  });
});

describe('the email subject is a sanitized plain header, not HTML', () => {
  it('does not HTML-escape the subject, and strips CR/LF', async () => {
    // A trainer name with & and control chars: the SUBJECT keeps the & literal (plain header)
    // and drops the CR/LF (header-injection defence). The BODY still escapes.
    await db.exec(`UPDATE public.trainer_profiles SET business_name = E'A & B\\r\\nBcc: evil' WHERE id='${T1}'`);
    await followers(1, { freq: 'instant' });
    await as(U_T1);
    await createJob([S1]);
    await drain();
    const subject = (await db.query<{ s: string }>(
      `SELECT payload->>'subject' AS s FROM public.notification_outbox LIMIT 1`)).rows[0].s;
    expect(subject).toContain('A & B');
    expect(subject).not.toContain('&amp;');
    expect(subject).not.toMatch(/[\r\n]/);
    await db.exec(`UPDATE public.trainer_profiles SET business_name = 'Padel Pro' WHERE id='${T1}'`);
  });
});
