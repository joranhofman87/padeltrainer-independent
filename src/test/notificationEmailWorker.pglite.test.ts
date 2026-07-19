// @vitest-environment node
// Notification Foundation v2 — PR 4 email-worker data layer (migration 20260912100000).
// Pins the SECURITY DEFINER RPCs the worker relies on:
//   * claim_notification_outbox_batch — claims only DUE pending rows for the channel,
//     flips them to processing, bumps attempts; a second claim can't re-grab them.
//   * record_notification_send_result — sent (terminal) / failed-with-backoff /
//     failed-terminal / exhausted, plus the linked email_delivery_events row.
//   * claim_skipped_required_alerts — claims skipped REQUIRED rows once (ops_alerted_at),
//     never non-required or non-skipped rows, returning SAFE refs only.
//   * all three are service-role-only.
// Runs the REAL schema + worker migrations.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;
const P1 = 'd0000000-0000-0000-0000-000000000001';
const MIG = (name: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', name), 'utf8');

let seq = 0;
// insert one outbox row; returns its id. defaults = a due, pending email row for P1.
const insertOutbox = async (over: Record<string, string> = {}): Promise<string> => {
  seq += 1;
  const cols: Record<string, string> = {
    event_type: `'booking_confirmed_player'`,
    channel: `'email'`,
    recipient_person_id: `'${P1}'`,
    idempotency_key: `'k${seq}'`,
    status: `'pending'`,
    destination_normalized: `'p1@example.com'`,
    destination_redacted: `'p***@example.com'`,
    scheduled_for: `now()`,
    payload: `'{"subject":"Hi","html":"<p>Hi</p>"}'::jsonb`,
    ...over,
  };
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO public.notification_outbox (${Object.keys(cols).join(', ')}) VALUES (${Object.values(cols).join(', ')}) RETURNING id`);
  return rows[0].id;
};

const claim = (channel = 'email', limit = 20) =>
  db.query<{ outbox_id: string; attempts: number; payload: unknown; destination_normalized: string }>(
    `SELECT * FROM public.claim_notification_outbox_batch($1,'worker-test',$2)`, [channel, limit]);

const row = async (id: string) =>
  (await db.query<{ status: string; attempts: number; sent_at: string | null; failed_at: string | null; next_attempt_at: string | null; provider_message_id: string | null; last_error: string | null; ops_alerted_at: string | null }>(
    `SELECT status, attempts, sent_at, failed_at, next_attempt_at, provider_message_id, last_error, ops_alerted_at FROM public.notification_outbox WHERE id=$1`, [id])).rows[0];

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT NULL::uuid $fn$;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE TABLE public.persons (id uuid PRIMARY KEY);
    CREATE TABLE public.invoices (id uuid PRIMARY KEY);
    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY);
    -- full base shape (20260615110000) — the schema migration then ALTERs in channel/outbox_id/etc
    CREATE TABLE public.email_delivery_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      resend_event_id text, resend_email_id text,
      event_type text NOT NULL, bounce_type text, reason text,
      recipient_email text NOT NULL,
      invoice_id uuid, academy_profile_id uuid, trainer_id uuid,
      occurred_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now());
  `);
  await db.exec(MIG('20260910100000_notification_foundation_schema.sql'));
  await db.exec(MIG('20260912100000_notification_email_worker.sql'));
  await db.exec(`INSERT INTO public.persons (id) VALUES ('${P1}');`);
});

beforeEach(async () => {
  await db.exec(`TRUNCATE public.notification_outbox, public.email_delivery_events CASCADE;`);
});

describe('claim_notification_outbox_batch', () => {
  it('claims a due pending email row: returns it, marks it processing, bumps attempts, locks it', async () => {
    const id = await insertOutbox();
    const { rows } = await claim();
    expect(rows).toHaveLength(1);
    expect(rows[0].outbox_id).toBe(id);
    expect(rows[0].attempts).toBe(1);                       // claim == an attempt
    expect(rows[0].destination_normalized).toBe('p1@example.com');
    const r = await row(id);
    expect(r.status).toBe('processing');
    expect(r.attempts).toBe(1);
  });

  it('does NOT claim rows scheduled for the future', async () => {
    await insertOutbox({ scheduled_for: `now() + interval '1 hour'` });
    expect((await claim()).rows).toHaveLength(0);
  });

  it('does NOT claim rows whose next_attempt_at is still in the future', async () => {
    await insertOutbox({ next_attempt_at: `now() + interval '1 hour'` });
    expect((await claim()).rows).toHaveLength(0);
  });

  it('does NOT claim rows of a different channel', async () => {
    await insertOutbox({ channel: `'whatsapp'` });
    expect((await claim('email')).rows).toHaveLength(0);
  });

  it('does NOT claim already-sent or skipped rows', async () => {
    await insertOutbox({ status: `'sent'` });
    await insertOutbox({ status: `'skipped'` });
    expect((await claim()).rows).toHaveLength(0);
  });

  it('respects the limit and a second claim cannot re-grab the same rows (they are now processing)', async () => {
    await insertOutbox(); await insertOutbox(); await insertOutbox();
    const first = await claim('email', 2);
    expect(first.rows).toHaveLength(2);
    const second = await claim('email', 20);
    expect(second.rows).toHaveLength(1);                    // only the 3rd remains pending
    expect((await claim('email', 20)).rows).toHaveLength(0); // nothing left pending
  });
});

describe('record_notification_send_result', () => {
  // record only finalizes a row it still owns (status=processing + locked_by=worker).
  const record = (id: string, status: string, over: { worker?: string; msg?: string; err?: string; terminal?: boolean } = {}) =>
    db.query<{ record_notification_send_result: string }>(
      `SELECT public.record_notification_send_result(
         p_outbox_id => $1, p_worker => $2, p_status => $3,
         p_provider_message_id => $4, p_error => $5, p_terminal => $6
       ) AS record_notification_send_result`,
      [id, over.worker ?? 'worker-test', status, over.msg ?? null, over.err ?? null, over.terminal ?? false]);
  // a row already claimed by 'worker-test' (simulates post-claim state without going through claim)
  const insertOwned = (over: Record<string, string> = {}) =>
    insertOutbox({ status: `'processing'`, locked_by: `'worker-test'`, locked_at: `now()`, ...over });

  it('sent → status sent, timestamps + provider id set, and a linked sent delivery event', async () => {
    const id = await insertOutbox();
    await claim();
    const res = await record(id, 'sent', { msg: 'resend-123' });
    expect(res.rows[0].record_notification_send_result).toBe('sent');
    const r = await row(id);
    expect(r.status).toBe('sent');
    expect(r.sent_at).not.toBeNull();
    expect(r.provider_message_id).toBe('resend-123');
    const ev = await db.query<{ channel: string; event_type: string; outbox_id: string; destination_redacted: string; resend_email_id: string }>(
      `SELECT channel, event_type, outbox_id, destination_redacted, resend_email_id FROM public.email_delivery_events WHERE outbox_id=$1`, [id]);
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]).toMatchObject({ channel: 'email', event_type: 'sent', outbox_id: id, destination_redacted: 'p***@example.com', resend_email_id: 'resend-123' });
  });

  it('failed (non-terminal, attempts < max) → re-queued pending with a FUTURE next_attempt_at + send_failed event', async () => {
    const id = await insertOutbox();
    await claim(); // attempts → 1
    const res = await record(id, 'failed', { err: 'boom' });
    expect(res.rows[0].record_notification_send_result).toBe('pending');
    const r = await row(id);
    expect(r.status).toBe('pending');
    expect(r.last_error).toBe('boom');
    const future = await db.query<{ f: boolean }>(`SELECT next_attempt_at > now() AS f FROM public.notification_outbox WHERE id=$1`, [id]);
    expect(future.rows[0].f).toBe(true);
    const ev = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.email_delivery_events WHERE outbox_id=$1 AND event_type='send_failed'`, [id]);
    expect(ev.rows[0].n).toBe(1);
  });

  it('failed with p_terminal=true → immediately failed (no retry) even on the first attempt', async () => {
    const id = await insertOutbox();
    await claim();
    const res = await record(id, 'failed', { err: 'email_suppressed', terminal: true });
    expect(res.rows[0].record_notification_send_result).toBe('failed');
    const r = await row(id);
    expect(r.status).toBe('failed');
    expect(r.failed_at).not.toBeNull();
  });

  it('failed at max_attempts → terminal by exhaustion', async () => {
    const id = await insertOwned({ attempts: '5', max_attempts: '5' }); // owned + already at the cap
    const res = await record(id, 'failed', { err: 'boom' });
    expect(res.rows[0].record_notification_send_result).toBe('failed');
    expect((await row(id)).status).toBe('failed');
  });

  it('backoff grows with the attempt count', async () => {
    const early = await insertOwned({ attempts: '1' });
    const late = await insertOwned({ attempts: '4' });
    await record(early, 'failed', { err: 'x' });
    await record(late, 'failed', { err: 'x' });
    const cmp = await db.query<{ later: boolean }>(
      `SELECT (SELECT next_attempt_at FROM public.notification_outbox WHERE id=$2)
            > (SELECT next_attempt_at FROM public.notification_outbox WHERE id=$1) AS later`, [early, late]);
    expect(cmp.rows[0].later).toBe(true);
  });

  it('OWNERSHIP: a worker that does not hold the lock cannot overwrite the outcome (returns stale)', async () => {
    const id = await insertOutbox();
    await claim(); // locked_by → 'worker-test'
    const res = await record(id, 'sent', { worker: 'a-different-run', msg: 'x' });
    expect(res.rows[0].record_notification_send_result).toBe('stale');
    const r = await row(id);
    expect(r.status).toBe('processing');   // untouched
    expect(r.sent_at).toBeNull();
  });
});

describe('stale-processing recovery', () => {
  const stale = (over: Record<string, string> = {}) =>
    insertOutbox({ status: `'processing'`, locked_by: `'dead-worker'`, locked_at: `now() - interval '30 minutes'`, attempts: '1', ...over });

  it('reclaims a stale-processing row orphaned by a crashed worker (new lock, attempts bumped)', async () => {
    const id = await stale();
    const { rows } = await claim();
    expect(rows).toHaveLength(1);
    expect(rows[0].outbox_id).toBe(id);
    const r = await row(id);
    expect(r.status).toBe('processing');
    expect(r.attempts).toBe(2);            // reclaim counts as another attempt
  });

  it('does NOT reclaim a FRESH processing row (recently locked, not yet stale)', async () => {
    await insertOutbox({ status: `'processing'`, locked_by: `'live-worker'`, locked_at: `now()`, attempts: '1' });
    expect((await claim()).rows).toHaveLength(0);
  });

  it('REAPS a stale-processing row already at max_attempts → failed, not reclaimed forever', async () => {
    const id = await stale({ attempts: '5', max_attempts: '5' });
    const { rows } = await claim();
    expect(rows).toHaveLength(0);          // reaped, not returned
    const r = await row(id);
    expect(r.status).toBe('failed');
    expect(r.last_error).toBe('stuck_in_processing');
  });
});

describe('claim_skipped_required_alerts + mark_skipped_alerts_sent (reliable at-least-once)', () => {
  const lease = (over: { retry?: number; max?: number } = {}) =>
    db.query<{ outbox_id: string; event_type: string; skip_reason: string }>(
      `SELECT * FROM public.claim_skipped_required_alerts(20, $1, $2)`, [over.retry ?? 5, over.max ?? 5]);
  const markSent = (ids: string[]) =>
    db.query(`SELECT public.mark_skipped_alerts_sent(ARRAY[${ids.map((i) => `'${i}'`).join(',')}]::uuid[])`);
  const rewindAttempt = (id: string) =>
    db.query(`UPDATE public.notification_outbox SET ops_alert_last_attempt_at = now() - interval '10 minutes' WHERE id=$1`, [id]);

  it('LEASES a skipped REQUIRED row (returns it, bumps attempts) WITHOUT yet marking it alerted', async () => {
    const id = await insertOutbox({ event_type: `'password_reset'`, status: `'skipped'`, skip_reason: `'email_suppressed'` });
    const first = await lease();
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]).toMatchObject({ outbox_id: id, event_type: 'password_reset', skip_reason: 'email_suppressed' });
    expect((await row(id)).ops_alerted_at).toBeNull();   // leased, not yet alerted (Slack unconfirmed)
  });

  it('does not re-lease within the retry window, DOES after it elapses, and stops once marked sent', async () => {
    const id = await insertOutbox({ event_type: `'password_reset'`, status: `'skipped'`, skip_reason: `'x'` });
    await lease();                                         // attempt 1
    expect((await lease()).rows).toHaveLength(0);          // within the retry window → not re-leased
    await rewindAttempt(id);
    expect((await lease()).rows).toHaveLength(1);          // window elapsed → re-leased (at-least-once)
    await markSent([id]);                                  // Slack confirmed → mark alerted
    expect((await row(id)).ops_alerted_at).not.toBeNull();
    await rewindAttempt(id);
    expect((await lease()).rows).toHaveLength(0);          // never leased again once alerted
  });

  it('stops leasing after the max-attempts give-up cap', async () => {
    await insertOutbox({ event_type: `'password_reset'`, status: `'skipped'`, skip_reason: `'x'`, ops_alert_attempts: '5' });
    expect((await lease({ max: 5 })).rows).toHaveLength(0);
  });

  it('does NOT lease skipped rows for NON-required events', async () => {
    await insertOutbox({ event_type: `'booking_cancelled_player'`, status: `'skipped'`, skip_reason: `'preference_off'` });
    expect((await lease()).rows).toHaveLength(0);
  });

  it('does NOT lease non-skipped rows', async () => {
    await insertOutbox({ event_type: `'password_reset'`, status: `'sent'` });
    expect((await lease()).rows).toHaveLength(0);
  });
});

describe('lockdown — worker RPCs are service-role-only', () => {
  it('anon and authenticated CANNOT execute the three worker RPCs; service_role can', async () => {
    const priv = async (role: string) => (await db.query<{ ok: boolean }>(
      `SELECT bool_and(has_function_privilege($1, p.oid, 'EXECUTE')) AS ok
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname IN
         ('claim_notification_outbox_batch','record_notification_send_result','claim_skipped_required_alerts','mark_skipped_alerts_sent')`, [role])).rows[0].ok;
    expect(await priv('anon')).toBe(false);
    expect(await priv('authenticated')).toBe(false);
    expect(await priv('service_role')).toBe(true);
  });
});
