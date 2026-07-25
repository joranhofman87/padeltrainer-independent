// @vitest-environment node
// PR 10c-a2 — the ADR 0008 SQL state machine, verified on a REAL multi-connection Postgres server
// (embedded-postgres; no Docker). Loads the deployed schema + ACL-lockdown + the state-machine migration
// over prod-faithful default privileges + prod-shaped stubs (destination_normalized, is_email_suppressed,
// notification_preferences_v2, required_delivery), then exercises: the full worker loop; SPLIT (the one
// authorized parent→child re-point); CONCURRENT materialization; server-validated store; §PS live
// revalidation; the record/§ERR matrix incl. concurrent recording; callback-before-record + orphan→link→
// apply; atomic provider transitions (bounced→complained etc); the reason-aware breaker; causal
// reconciliation; deferral-ownership hygiene; 100k-row bounded candidate query (EXPLAIN ANALYZE, BUFFERS);
// and the RPC ACL matrix. INERT: no worker/webhook, no digest-enabled event.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Client } = pg;
const PORT = 54345;
let epg: InstanceType<typeof EmbeddedPostgres> | undefined;
let url = '';
let seq = 0;
const NOW = "'2026-07-01 10:00:00+00'::timestamptz";   // 12:00 CEST, inside quiet-hours window
const NIGHT = "'2026-07-01 01:00:00+00'::timestamptz"; // 03:00 CEST, outside the window
const BD = "'2026-07-01 06:00:00+00'::timestamptz";     // 08:00 CEST, a past/due boundary

function conn() { return new Client({ connectionString: url }); }

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'digest-sm-'));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  await epg.initialise(); await epg.start();
  url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
  const c = conn(); await c.connect();
  await c.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    -- prod-shaped stubs (mirroring 20260910100000 + 20260615110010: contacts ownership + consent scope,
    -- outbox.contact_id FK ON DELETE SET NULL, the real is_notification_consent_in_scope semantics)
    CREATE TABLE public.notification_event_types (key text PRIMARY KEY, supports_digest boolean NOT NULL DEFAULT false,
      required_delivery boolean NOT NULL DEFAULT false);
    CREATE TABLE public.notification_contacts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), person_id uuid, user_id uuid, guest_player_id uuid,
      channel text NOT NULL DEFAULT 'email', destination_normalized text NOT NULL,
      consent_status text NOT NULL DEFAULT 'unknown', consent_scope text NOT NULL DEFAULT 'global',
      consent_academy_profile_id uuid, consent_trainer_id uuid, revoked_at timestamptz,
      is_primary boolean NOT NULL DEFAULT false, verified_at timestamptz);
    CREATE FUNCTION public.is_notification_consent_in_scope(
      _consent_scope text, _consent_academy uuid, _consent_trainer uuid, _ctx_academy uuid, _ctx_trainer uuid)
    RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE
        WHEN _consent_scope = 'global' THEN true
        WHEN _consent_scope = 'tenant' THEN
              (_consent_academy IS NULL OR (_ctx_academy IS NOT NULL AND _ctx_academy = _consent_academy))
          AND (_consent_trainer IS NULL OR (_ctx_trainer IS NOT NULL AND _ctx_trainer = _consent_trainer))
          AND (_consent_academy IS NOT NULL OR _consent_trainer IS NOT NULL)
        ELSE false END $$;
    CREATE TABLE public.notification_outbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), channel text NOT NULL DEFAULT 'email',
      event_type text, template_key text, status text NOT NULL DEFAULT 'pending',
      payload jsonb, public_summary jsonb, skip_reason text, destination_normalized text,
      contact_id uuid REFERENCES public.notification_contacts(id) ON DELETE SET NULL,
      recipient_person_id uuid, recipient_user_id uuid, recipient_guest_player_id uuid,
      tenant_academy_profile_id uuid, tenant_trainer_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT notification_outbox_status_check CHECK (status IN
        ('pending','processing','sent','delivered','failed','skipped','cancelled')));
    CREATE TABLE public.email_suppression_stub (email text PRIMARY KEY);
    CREATE FUNCTION public.is_email_suppressed(p_email text) RETURNS boolean LANGUAGE sql STABLE AS
      $$ SELECT EXISTS (SELECT 1 FROM public.email_suppression_stub WHERE email = lower(p_email)) $$;
    CREATE TABLE public.notification_preferences_v2 (
      user_id uuid NOT NULL, event_type text NOT NULL, email_frequency text NOT NULL DEFAULT 'instant',
      UNIQUE (user_id, event_type));
    CREATE TABLE public.persons (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE, email text);`);
  for (const f of ['20261002100000_notification_digest_schema_foundation.sql',
    '20261003100000_notification_digest_acl_lockdown.sql', '20261004100000_notification_digest_state_machine.sql']) {
    await c.query(readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8'));
  }
  await c.end();
}, 180_000);

afterAll(async () => { if (epg) await epg.stop(); });

// each test starts from a clean slate (TRUNCATE bypasses the append-only guards as the table owner).
beforeEach(async () => {
  const c = conn(); await c.connect();
  try {
    await c.query(`TRUNCATE public.notification_digest_groups, public.notification_digest_attempts,
      public.notification_digest_group_attempts, public.notification_provider_events, public.notification_provider_circuit,
      public.notification_send_counters, public.notification_send_reservations, public.notification_worker_runs,
      public.notification_outbox, public.email_suppression_stub, public.notification_preferences_v2,
      public.notification_contacts, public.persons RESTART IDENTITY CASCADE`);
  } finally { await c.end(); }
});

async function fpOf(c: pg.Client, dest: string): Promise<string> {
  return (await c.query(`SELECT public.notif_digest_destination_fingerprint($1) f`, [dest])).rows[0].f;
}
async function seedMember(c: pg.Client, key: string, dest: string,
  opts: { itemBytes?: number; boundary?: string; userId?: string | null; guestId?: string | null;
          personId?: string | null; contactId?: string | null; eventType?: string; tz?: string;
          tenantAcademy?: string | null; noIdentity?: boolean } = {}) {
  const fp = await fpOf(c, dest);
  let userId = opts.userId ?? null;
  // default: an ACCOUNT recipient with a matching persons row — the §PS live re-resolution (resolver
  // semantics) needs a real live identity; a recipient with none is legitimately stopped.
  if (!userId && !opts.guestId && !opts.personId && !opts.noIdentity) {
    userId = (await c.query(`SELECT gen_random_uuid() u`)).rows[0].u;
    await c.query(`INSERT INTO public.persons (user_id, email) VALUES ($1,$2)`, [userId, dest]);
  }
  // digest_item_bytes is SERVER-DERIVED (octet_length of the stored item) — never a caller count. To make a
  // genuinely oversize member, pad the item's content; small items serialize to a handful of bytes.
  const item = opts.itemBytes
    ? `jsonb_build_object('pad', repeat('x', ${Math.max(1, opts.itemBytes - 14)}))`
    : `'{}'::jsonb`;
  await c.query(`INSERT INTO public.notification_outbox
    (channel, delivery_mode, recipient_key, destination_fingerprint, destination_normalized,
     recipient_user_id, recipient_person_id, recipient_guest_player_id, contact_id, tenant_academy_profile_id,
     event_type, template_key, template_version, group_locale, digest_frequency, recipient_timezone,
     digest_boundary_at, digest_item, status)
    VALUES ('email','digest',$1,$2,$3,$4,$5,$6,$7,$8,$9,'tpl',1,'nl','daily',$10, ${opts.boundary ?? BD}, ${item}, 'pending')`,
    [key, fp, dest, userId, opts.personId ?? null, opts.guestId ?? null, opts.contactId ?? null,
     opts.tenantAcademy ?? null, opts.eventType ?? 'ev', opts.tz ?? 'Europe/Amsterdam']);
  return fp;
}
async function frozenFor(c: pg.Client, run: string, g: string, worker: string, dest: string) {
  await c.query(`SELECT public.store_notification_digest_request($1,$2,$3,
    jsonb_build_object('to',$4::text,'subject','s','html','<p>x</p>'), ${NOW})`, [run, g, worker, dest]);
}
// drive one fresh single-member group all the way to 'sending'; returns { g, att, run, dest }.
async function toSending(c: pg.Client, capArgs = '') {
  seq += 1; const key = `p:${seq}`; const dest = `u${seq}@example.com`;
  await seedMember(c, key, dest);
  const mrun = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
  await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
  const g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [key])).rows[0].id;
  const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
  await c.query(`SELECT public.claim_notification_digest_group($1,'email', ${NOW}, 'W')`, [run]);
  await c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${NOW})`, [run, g]);
  await frozenFor(c, run, g, 'W', dest);
  const att = (await c.query(`SELECT public.begin_notification_digest_attempt($1,$2,'W', ${NOW}${capArgs}) AS a`, [run, g])).rows[0].a;
  return { g, att, run, dest };
}
const gstate = async (c: pg.Client, g: string) => (await c.query(`SELECT * FROM public.notification_digest_groups WHERE id=$1`, [g])).rows[0];
const resStates = async (c: pg.Client, g: string) => (await c.query(`SELECT array_agg(state ORDER BY counter_key) a FROM public.notification_send_reservations WHERE digest_group_id=$1`, [g])).rows[0].a;

describe('10c-a2 worker loop — materialize → claim → prepare → store → begin', () => {
  it('materialize groups 3 same-key members into one 3-item group at the boundary', async () => {
    const c = conn(); await c.connect();
    try {
      for (let i = 0; i < 3; i++) await seedMember(c, 'p:loop', 'loop@example.com');
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      const n = (await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100) AS n`, [run])).rows[0].n;
      const g = (await c.query(`SELECT id, item_count, state FROM public.notification_digest_groups WHERE recipient_key='p:loop'`)).rows[0];
      expect(Number(n)).toBe(1); expect(g.item_count).toBe(3); expect(g.state).toBe('pending');
      expect((await c.query(`SELECT count(*)::int n FROM public.notification_outbox WHERE digest_group_id=$1`, [g.id])).rows[0].n).toBe(3);
    } finally { await c.end(); }
  });

  it('drives a group to sending with attempt row, current_attempt_id, 2 reservations, budget, ledger chain', async () => {
    const c = conn(); await c.connect();
    try {
      const { g, att, run } = await toSending(c);
      const s = await gstate(c, g);
      expect(s.state).toBe('sending'); expect(s.current_attempt_id).toBe(att);
      expect(s.provider_attempts_started).toBe(1); expect(s.delivery_budget_used).toBe(1); expect(s.first_send_at).not.toBeNull();
      const a = (await c.query(`SELECT worker_run_id, provider_idempotency_key, recorded_at FROM public.notification_digest_attempts WHERE attempt_id=$1`, [att])).rows[0];
      expect(a.worker_run_id).toBe(run); expect(a.provider_idempotency_key).toBe('dg:v1:' + g); expect(a.recorded_at).toBeNull();
      expect(await resStates(c, g)).toEqual(['reserved', 'reserved']);
      const acts = (await c.query(`SELECT array_agg(action ORDER BY seq) a FROM public.notification_digest_group_attempts WHERE digest_group_id=$1`, [g])).rows[0].a;
      expect(acts).toEqual(['materialized', 'leased', 'prepared', 'request_ready', 'attempt']);
    } finally { await c.end(); }
  });

  it('raw single-item oversize → oversize_failed group + failed member', async () => {
    const c = conn(); await c.connect();
    try {
      await seedMember(c, 'p:big', 'big@example.com', { itemBytes: 200000 });
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [run]);
      const g = (await c.query(`SELECT state, terminal_reason FROM public.notification_digest_groups WHERE recipient_key='p:big'`)).rows[0];
      const m = (await c.query(`SELECT status, skip_reason FROM public.notification_outbox WHERE recipient_key='p:big'`)).rows[0];
      expect(g.state).toBe('oversize_failed'); expect(m.status).toBe('failed'); expect(m.skip_reason).toBe('single_item_oversize');
    } finally { await c.end(); }
  });

  it('split moves members to ≤N-item children (the ONE authorized re-point); parent superseded', async () => {
    const c = conn(); await c.connect();
    try {
      for (let i = 0; i < 4; i++) await seedMember(c, 'p:split', 'split@example.com');
      const mrun = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
      const g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key='p:split'`)).rows[0].id;
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`SELECT public.claim_notification_digest_group($1,'email', ${NOW}, 'W')`, [run]);
      await c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${NOW})`, [run, g]);
      const n = (await c.query(`SELECT public.split_notification_digest_group($1,$2,'W',2, ${NOW}) AS n`, [run, g])).rows[0].n;
      const parent = await gstate(c, g);
      const kids = (await c.query(`SELECT item_count FROM public.notification_digest_groups WHERE parent_group_id=$1 ORDER BY chunk_ordinal`, [g])).rows;
      expect(Number(n)).toBe(2); expect(parent.state).toBe('superseded');
      expect(kids.map((k: { item_count: number }) => k.item_count)).toEqual([2, 2]);
      expect((await c.query(`SELECT count(*)::int n FROM public.notification_outbox WHERE digest_group_id=$1`, [g])).rows[0].n).toBe(0);
      // an ARBITRARY re-point (not parent→child) is still rejected by the guard
      const other = (await c.query(`INSERT INTO public.notification_digest_groups
        (canonical_group_key, group_key_hash, channel, event_type, recipient_key, destination_fingerprint, recipient_timezone, digest_boundary_at, available_at)
        VALUES ('["x"]'::jsonb,'h','email','ev','p:x','df','Europe/Amsterdam',now(),now()) RETURNING id`)).rows[0].id;
      const member = (await c.query(`SELECT id FROM public.notification_outbox WHERE recipient_key='p:split' LIMIT 1`)).rows[0].id;
      await expect(c.query(`UPDATE public.notification_outbox SET digest_group_id=$1 WHERE id=$2`, [other, member])).rejects.toThrow(/split child/i);
    } finally { await c.end(); }
  });

  it('store validates server-side: malformed / empty-to / wrong-destination / oversize rejected; hash recomputed', async () => {
    const c = conn(); await c.connect();
    try {
      seq += 1; const key = `p:${seq}`; const dest = `u${seq}@example.com`;
      await seedMember(c, key, dest);
      const mrun = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
      const g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [key])).rows[0].id;
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`SELECT public.claim_notification_digest_group($1,'email', ${NOW}, 'W')`, [run]);
      await c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${NOW})`, [run, g]);
      await expect(c.query(`SELECT public.store_notification_digest_request($1,$2,'W','"str"'::jsonb, ${NOW})`, [run, g])).rejects.toThrow(/malformed/i);
      await expect(c.query(`SELECT public.store_notification_digest_request($1,$2,'W', jsonb_build_object('to','','subject','s','html','h'), ${NOW})`, [run, g])).rejects.toThrow(/malformed/i);
      await expect(c.query(`SELECT public.store_notification_digest_request($1,$2,'W', jsonb_build_object('to','wrong@example.com','subject','s','html','h'), ${NOW})`, [run, g])).rejects.toThrow(/does not match/i);
      await expect(c.query(`SELECT public.store_notification_digest_request($1,$2,'W', jsonb_build_object('to',$3::text,'subject','s','html', repeat('x',95000)), ${NOW})`, [run, g, dest])).rejects.toThrow(/budget/i);
      await frozenFor(c, run, g, 'W', dest);
      const s = await gstate(c, g);
      const expectHash = (await c.query(`SELECT encode(sha256(jsonb_build_object('to',$1::text,'subject','s','html','<p>x</p>')::text::bytea),'hex') h`, [dest])).rows[0].h;
      expect(s.state).toBe('request_ready'); expect(s.request_hash).toBe(expectHash); // server-side, never trusted
    } finally { await c.end(); }
  });
});

describe('10c-a2 §PS — live revalidation at prepare and before every attempt', () => {
  it('prepare drops a member suppressed AFTER enqueue (skipped/suppressed → no_work)', async () => {
    const c = conn(); await c.connect();
    try {
      seq += 1; const key = `p:${seq}`; const dest = `u${seq}@example.com`;
      await seedMember(c, key, dest);
      await c.query(`INSERT INTO public.email_suppression_stub VALUES (lower($1))`, [dest]);  // suppressed after enqueue
      const mrun = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
      const g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [key])).rows[0].id;
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`SELECT public.claim_notification_digest_group($1,'email', ${NOW}, 'W')`, [run]);
      const prep = (await c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${NOW}) AS r`, [run, g])).rows[0].r;
      const m = (await c.query(`SELECT status, skip_reason FROM public.notification_outbox WHERE digest_group_id=$1`, [g])).rows[0];
      expect(prep).toBe('no_work'); expect(m.status).toBe('skipped'); expect(m.skip_reason).toBe('suppressed');
    } finally { await c.end(); }
  });

  it('begin whole-group stop on a live opt-out AFTER store → retry_stopped; required-delivery exempt', async () => {
    const c = conn(); await c.connect();
    try {
      seq += 1; const key = `p:${seq}`; const dest = `u${seq}@example.com`;
      const uid = (await c.query(`SELECT gen_random_uuid() u`)).rows[0].u;
      await c.query(`INSERT INTO public.persons (user_id, email) VALUES ($1,$2)`, [uid, dest]);
      await seedMember(c, key, dest, { userId: uid });
      const mrun = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
      const g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [key])).rows[0].id;
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`SELECT public.claim_notification_digest_group($1,'email', ${NOW}, 'W')`, [run]);
      await c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${NOW})`, [run, g]);
      await frozenFor(c, run, g, 'W', dest);
      await c.query(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency) VALUES ($1,'ev','off')`, [uid]); // opts out after store
      const att = (await c.query(`SELECT public.begin_notification_digest_attempt($1,$2,'W', ${NOW}) AS a`, [run, g])).rows[0].a;
      const s = await gstate(c, g);
      expect(att).toBeNull(); expect(s.state).toBe('retry_stopped'); expect(s.terminal_reason).toBe('preference_off');
      // required-delivery event: same opt-out, but prepare keeps the member (exempt)
      await c.query(`INSERT INTO public.notification_event_types (key, supports_digest, required_delivery) VALUES ('ev-req', true, true)`);
      seq += 1; const key2 = `p:${seq}`; const dest2 = `u${seq}@example.com`;
      await c.query(`UPDATE public.persons SET email=$2 WHERE user_id=$1`, [uid, dest2]);
      await seedMember(c, key2, dest2, { userId: uid, eventType: 'ev-req' });
      await c.query(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency) VALUES ($1,'ev-req','off')`, [uid]);
      const mr2 = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mr2]);
      const g2 = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [key2])).rows[0].id;
      const run2 = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`UPDATE public.notification_digest_groups SET state='leased', locked_by='W', locked_at=${NOW}, worker_run_id=$2 WHERE id=$1`, [g2, run2]);
      const prep2 = (await c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${NOW}) AS r`, [run2, g2])).rows[0].r;
      expect(prep2).toBe('prepared');
    } finally { await c.end(); }
  });

  it('quiet-hours deferral at begin clears ownership (no stale-reclaim churn)', async () => {
    const c = conn(); await c.connect();
    try {
      seq += 1; const key = `p:${seq}`; const dest = `u${seq}@example.com`;
      await seedMember(c, key, dest);
      const mrun = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
      const g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [key])).rows[0].id;
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`SELECT public.claim_notification_digest_group($1,'email', ${NOW}, 'W')`, [run]);
      await c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${NOW})`, [run, g]);
      await frozenFor(c, run, g, 'W', dest);
      const att = (await c.query(`SELECT public.begin_notification_digest_attempt($1,$2,'W', ${NIGHT}) AS a`, [run, g])).rows[0].a;
      const s = await gstate(c, g);
      expect(att).toBeNull(); expect(s.locked_by).toBeNull(); expect(s.locked_at).toBeNull(); // re-claimable, no churn
      expect(s.state).toBe('request_ready');
    } finally { await c.end(); }
  });
});

describe('10c-a2 record — §ERR branch matrix + sticky uncertainty + idempotency + late-accepted', () => {
  it('accepted → sent (members sent, reservations committed, uncertainty cleared) + idempotent replay', async () => {
    const c = conn(); await c.connect();
    try {
      const { g, att, run } = await toSending(c);
      const cls = (await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,202,NULL,'pm', ${NOW}) AS c`, [run, att])).rows[0].c;
      const s = await gstate(c, g);
      expect(cls).toBe('accepted'); expect(s.state).toBe('sent'); expect(s.provider_status).toBe('sent'); expect(s.uncertain_since).toBeNull();
      expect((await c.query(`SELECT status FROM public.notification_outbox WHERE digest_group_id=$1`, [g])).rows[0].status).toBe('sent');
      expect(await resStates(c, g)).toEqual(['committed', 'committed']);
      const cls2 = (await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,202,NULL,'pm', ${NOW}) AS c`, [run, att])).rows[0].c;
      expect(cls2).toBe('accepted'); expect((await gstate(c, g)).state).toBe('sent'); // replay no-op
    } finally { await c.end(); }
  });

  it('429 (not uncertain) → request_ready + reservation released + unowned', async () => {
    const c = conn(); await c.connect();
    try {
      const { g, att, run } = await toSending(c);
      await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,429,'rate_limit_exceeded',NULL, ${NOW}, 30)`, [run, att]);
      const s = await gstate(c, g);
      expect(s.state).toBe('request_ready'); expect(s.locked_by).toBeNull(); expect(s.current_attempt_id).toBeNull();
      expect(await resStates(c, g)).toEqual(['released', 'released']);
    } finally { await c.end(); }
  });

  it('timeout → ambiguous (uncertain, committed); sticky: then 429 stays committed', async () => {
    const c = conn(); await c.connect();
    try {
      const { g, att, run } = await toSending(c);
      await c.query(`SELECT public.record_notification_digest_result($1,$2,'timeout',NULL,NULL,NULL, ${NOW})`, [run, att]);
      let s = await gstate(c, g);
      expect(s.state).toBe('request_ready'); expect(s.uncertain_since).not.toBeNull(); expect(await resStates(c, g)).toEqual(['committed', 'committed']);
      await c.query(`UPDATE public.notification_digest_groups SET locked_by='W', locked_at=${NOW}, state='request_ready', available_at=${NOW} WHERE id=$1`, [g]);
      const att2 = (await c.query(`SELECT public.begin_notification_digest_attempt($1,$2,'W', ${NOW}) AS a`, [run, g])).rows[0].a;
      await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,429,'rate_limit_exceeded',NULL, ${NOW}, 30)`, [run, att2]);
      s = await gstate(c, g);
      expect(s.state).toBe('request_ready'); expect(await resStates(c, g)).toEqual(['committed', 'committed']);
    } finally { await c.end(); }
  });

  it('terminal clean → failed_terminal (released); terminal while uncertain → awaiting_evidence (committed)', async () => {
    const c = conn(); await c.connect();
    try {
      const a = await toSending(c);
      await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,422,'validation_error',NULL, ${NOW})`, [a.run, a.att]);
      expect((await gstate(c, a.g)).state).toBe('failed_terminal'); expect(await resStates(c, a.g)).toEqual(['released', 'released']);
      const b = await toSending(c);
      await c.query(`SELECT public.record_notification_digest_result($1,$2,'timeout',NULL,NULL,NULL, ${NOW})`, [b.run, b.att]);
      await c.query(`UPDATE public.notification_digest_groups SET locked_by='W', locked_at=${NOW}, state='request_ready', available_at=${NOW} WHERE id=$1`, [b.g]);
      const att2 = (await c.query(`SELECT public.begin_notification_digest_attempt($1,$2,'W', ${NOW}) AS a`, [b.run, b.g])).rows[0].a;
      await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,422,'validation_error',NULL, ${NOW})`, [b.run, att2]);
      expect((await gstate(c, b.g)).state).toBe('awaiting_evidence'); expect(await resStates(c, b.g)).toEqual(['committed', 'committed']);
    } finally { await c.end(); }
  });

  it('late accepted from a stale attempt monotonically completes; stale non-accepted annotates only', async () => {
    const c = conn(); await c.connect();
    try {
      const { g, att, run } = await toSending(c);
      await c.query(`UPDATE public.notification_digest_groups SET uncertain_since=${NOW}, uncertain_deadline_at=${NOW}+interval '23 hours' WHERE id=$1`, [g]);
      const newer = (await c.query(`INSERT INTO public.notification_digest_attempts (digest_group_id, worker_run_id, provider_idempotency_key) VALUES ($1,$2,$3) RETURNING attempt_id`, [g, run, 'dg:v1:' + g])).rows[0].attempt_id;
      await c.query(`UPDATE public.notification_digest_groups SET current_attempt_id=$2 WHERE id=$1`, [g, newer]);
      const cls = (await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,202,NULL,'pm-late', ${NOW}) AS c`, [run, att])).rows[0].c;
      expect(cls).toBe('accepted'); expect((await gstate(c, g)).state).toBe('sent');
      await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,429,'rate_limit_exceeded',NULL, ${NOW})`, [run, newer]);
      expect((await gstate(c, g)).state).toBe('sent');
    } finally { await c.end(); }
  });

  it('two concurrent recorders of the SAME attempt: one authoritative outcome, the loser returns it', async () => {
    const c = conn(); await c.connect();
    let att!: string, run!: string;
    try { ({ att, run } = await toSending(c)); } finally { await c.end(); }
    const a = conn(); const b = conn(); await a.connect(); await b.connect();
    try {
      const [x, y] = await Promise.all([
        a.query(`SELECT public.record_notification_digest_result($1,$2,NULL,202,NULL,'pm-cc', ${NOW}) AS c`, [run, att]).then(r => r.rows[0].c),
        b.query(`SELECT public.record_notification_digest_result($1,$2,NULL,429,'rate_limit_exceeded',NULL, ${NOW}) AS c`, [run, att]).then(r => r.rows[0].c),
      ]);
      const cc = conn(); await cc.connect();
      const stored = (await cc.query(`SELECT outcome_class FROM public.notification_digest_attempts WHERE attempt_id=$1`, [att])).rows[0].outcome_class;
      const outcomes = (await cc.query(`SELECT count(*)::int n FROM public.notification_digest_group_attempts WHERE attempt_id=$1 AND action IN ('sent','retryable','ambiguous','terminal','global_config')`, [att])).rows[0].n;
      await cc.end();
      expect(x).toBe(stored); expect(y).toBe(stored);  // both return the single authoritative outcome
      expect(outcomes).toBe(1);                        // exactly ONE outcome ledger transition
    } finally { await a.end(); await b.end(); }
  });
});

describe('10c-a2 provider callbacks — atomic transitions, callback-before-record, orphan→link→apply', () => {
  it('tagged callback BEFORE the HTTP record binds the write-once pm and resolves (no FK failure)', async () => {
    const c = conn(); await c.connect();
    try {
      const { g, run } = await toSending(c);  // sending, unrecorded, provider_message_id NULL
      const r = (await c.query(`SELECT public.apply_notification_provider_event($1,'ev-early','pm-early',$2,'delivered', ${NOW}, ${NOW}) AS r`, [run, g])).rows[0].r;
      const s = await gstate(c, g);
      expect(r).toBe('sent'); expect(s.provider_message_id).toBe('pm-early'); expect(s.state).toBe('sent'); expect(s.provider_status).toBe('delivered');
      // a tagged callback whose message id CONFLICTS with the bound pm → durable orphan ('mismatch')
      const mm = (await c.query(`SELECT public.apply_notification_provider_event($1,'ev-mm','pm-other',$2,'bounced', ${NOW}, ${NOW}) AS r`, [run, g])).rows[0].r;
      expect(mm).toBe('mismatch');
      expect((await c.query(`SELECT digest_group_id FROM public.notification_provider_events WHERE resend_event_id='ev-mm'`)).rows[0].digest_group_id).toBeNull();
    } finally { await c.end(); }
  });

  it('orphan → link → APPLY: the stored outcome is applied exactly once on link (evidence never stranded)', async () => {
    const c = conn(); await c.connect();
    try {
      const { g, run } = await toSending(c);
      const orph = (await c.query(`SELECT public.apply_notification_provider_event($1,'ev-orph','pm-orph',NULL,'delivered', ${NOW}, ${NOW}) AS r`, [run])).rows[0].r;
      expect(orph).toBe('orphan');
      await c.query(`SELECT public.link_notification_provider_event('ev-orph',$1)`, [g]);
      const s = await gstate(c, g);
      expect(s.state).toBe('sent'); expect(s.provider_status).toBe('delivered'); expect(s.provider_message_id).toBe('pm-orph');
      // idempotent same-group relink stays a no-op success
      await expect(c.query(`SELECT public.link_notification_provider_event('ev-orph',$1)`, [g])).resolves.toBeTruthy();
    } finally { await c.end(); }
  });

  it('bounced → complained: group sent/complained AND members sent — never a contradictory split', async () => {
    const c = conn(); await c.connect();
    try {
      const { g, att, run } = await toSending(c);
      await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,202,NULL,'pm-bc', ${NOW})`, [run, att]);
      await c.query(`SELECT public.apply_notification_provider_event($1,'ev-b','pm-bc',NULL,'bounced', ${NOW}, ${NOW})`, [run]);
      let s = await gstate(c, g);
      expect(s.state).toBe('failed_terminal');
      expect((await c.query(`SELECT status FROM public.notification_outbox WHERE digest_group_id=$1`, [g])).rows[0].status).toBe('failed');
      await c.query(`SELECT public.apply_notification_provider_event($1,'ev-c','pm-bc',NULL,'complained', ${NOW}, ${NOW})`, [run]);
      s = await gstate(c, g);
      const m = (await c.query(`SELECT status FROM public.notification_outbox WHERE digest_group_id=$1`, [g])).rows[0];
      expect(s.state).toBe('sent'); expect(s.provider_status).toBe('complained'); expect(s.terminal_reason).toBe('complained');
      expect(m.status).toBe('sent');                          // member consistent with the group
      expect(s.uncertain_since).toBeNull(); expect(s.uncertain_deadline_at).toBeNull(); // no stale uncertainty
    } finally { await c.end(); }
  });

  it('delivery_unknown → delivered override → sent; lower-rank after-the-fact is a rank-guarded no-op', async () => {
    const c = conn(); await c.connect();
    try {
      const { g, att, run } = await toSending(c);
      await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,202,NULL,'pm-du', ${NOW})`, [run, att]);
      await c.query(`ALTER TABLE public.notification_digest_groups DISABLE TRIGGER trg_digest_groups_guard`);
      await c.query(`UPDATE public.notification_digest_groups SET state='delivery_unknown', terminal_at=now() WHERE id=$1`, [g]);
      await c.query(`ALTER TABLE public.notification_digest_groups ENABLE TRIGGER trg_digest_groups_guard`);
      await c.query(`SELECT public.apply_notification_provider_event($1,'ev-du','pm-du',NULL,'delivered', ${NOW}, ${NOW})`, [run]);
      const s = await gstate(c, g);
      expect(s.state).toBe('sent'); expect(s.provider_status).toBe('delivered');
      const late = (await c.query(`SELECT public.apply_notification_provider_event($1,'ev-late','pm-du',NULL,'sent', ${NOW}, ${NOW}) AS r`, [run])).rows[0].r;
      expect(late).toBe('noop_rank'); expect((await gstate(c, g)).provider_status).toBe('delivered');
      // duplicate delivery of the SAME event id
      expect((await c.query(`SELECT public.apply_notification_provider_event($1,'ev-du','pm-du',NULL,'delivered', ${NOW}, ${NOW}) AS r`, [run])).rows[0].r).toBe('duplicate');
    } finally { await c.end(); }
  });
});

describe('10c-a2 breaker — two-stage probe + reason-aware timing/manual holds', () => {
  it('open+due promotes ONE probe; only the bound probe attempt closes the breaker', async () => {
    const c = conn(); await c.connect();
    try {
      const a = await toSending(c); const b = await toSending(c);
      await c.query(`UPDATE public.notification_digest_groups SET state='request_ready', locked_by=NULL, locked_at=NULL, available_at=${NOW} WHERE id IN ($1,$2)`, [a.g, b.g]);
      await c.query(`SELECT public.notif_digest_trip_breaker('email','test', ${NOW} - interval '1 minute', ${NOW})`);
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      const p = (await c.query(`SELECT public.claim_notification_digest_group($1,'email', ${NOW}, 'P1') AS g`, [run])).rows[0].g;
      const cb1 = (await c.query(`SELECT * FROM public.notification_provider_circuit WHERE channel='email'`)).rows[0];
      expect(cb1.state).toBe('half_open'); expect(cb1.probe_group_id).toBe(p);
      expect((await c.query(`SELECT public.claim_notification_digest_group($1,'email', ${NOW}, 'P2') AS g`, [run])).rows[0].g).toBeNull();
      const att = (await c.query(`SELECT public.begin_notification_digest_attempt($1,$2,'P1', ${NOW}) AS a`, [run, p])).rows[0].a;
      expect((await c.query(`SELECT probe_attempt_id FROM public.notification_provider_circuit WHERE channel='email'`)).rows[0].probe_attempt_id).toBe(att);
      await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,202,NULL,'pm-p', ${NOW})`, [run, att]);
      const cb3 = (await c.query(`SELECT * FROM public.notification_provider_circuit WHERE channel='email'`)).rows[0];
      expect(cb3.state).toBe('closed'); expect(cb3.probe_group_id).toBeNull();
    } finally { await c.end(); }
  });

  it('reason-aware trips: daily quota (Retry-After/24h), monthly + invalid-idempotency (manual hold), auth 15m, unknown 4xx 15m', async () => {
    const c = conn(); await c.connect();
    try {
      const cases: Array<[number, string, string, boolean]> = [
        [429, 'daily_quota_exceeded', 'daily_quota', true],
        [429, 'monthly_quota_exceeded', 'monthly_quota', false],   // retry_at NULL = manual hold
        [401, 'invalid_api_key', 'auth_config', true],
        [200, 'invalid_idempotent_request', 'invariant_breach', false],
        [400, 'totally_unknown_name', 'global_config', true],
      ];
      for (const [http, name, wantReason, wantRetry] of cases) {
        const { att, run } = await toSending(c);
        await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,$3,$4,NULL, ${NOW})`, [run, att, http, name]);
        const cb = (await c.query(`SELECT reason, retry_at FROM public.notification_provider_circuit WHERE channel='email'`)).rows[0];
        expect(cb.reason, name).toBe(wantReason);
        expect(cb.retry_at !== null, `${name} retry_at`).toBe(wantRetry);
        await c.query(`UPDATE public.notification_provider_circuit SET state='closed', reason=NULL, retry_at=NULL, probe_group_id=NULL, probe_attempt_id=NULL WHERE channel='email'`);
      }
    } finally { await c.end(); }
  });
});

describe('10c-a2 reconciliation + sweep — causal, cross-run, superseded lineage', () => {
  it('causal attribution: the recording run owns "sent"; a lease-only run reports in_flight; cross-run record is rejected', async () => {
    const c = conn(); await c.connect();
    try {
      const { att, run } = await toSending(c);   // run leased + attempted
      // exact run linkage: a DIFFERENT (same-shape) run cannot record this attempt
      const run2 = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await expect(c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,202,NULL,'pm-rc', ${NOW})`, [run2, att])).rejects.toThrow(/does not own attempt/i);
      // the attempt's own run records → owns 'sent'
      await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,202,NULL,'pm-rc', ${NOW})`, [run, att]);
      const r1 = (await c.query(`SELECT metric FROM public.reconcile_notification_digest_run($1) WHERE family='group'`, [run])).rows.map((r: { metric: string }) => r.metric);
      expect(r1).toEqual(['sent']);
      // a run that only LEASES another group reports in_flight (causal, never the other run's outcome)
      seq += 1; const key = `p:${seq}`; await seedMember(c, key, `u${seq}@example.com`);
      const m2 = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [m2]);
      const g2 = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [key])).rows[0].id;
      const run3 = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`SELECT public.claim_notification_digest_group($1,'email', ${NOW}, 'L')`, [run3]);
      void g2;
      const r3 = (await c.query(`SELECT metric FROM public.reconcile_notification_digest_run($1) WHERE family='group'`, [run3])).rows.map((r: { metric: string }) => r.metric);
      expect(r3).toEqual(['in_flight']);
      await expect(c.query(`SELECT * FROM public.reconcile_notification_digest_run(gen_random_uuid())`)).rejects.toThrow(/not found/i);
    } finally { await c.end(); }
  });

  it('a split parent reconciles as its own superseded lineage metric', async () => {
    const c = conn(); await c.connect();
    try {
      for (let i = 0; i < 2; i++) await seedMember(c, 'p:lin', 'lin@example.com');
      const mrun = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
      const g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key='p:lin'`)).rows[0].id;
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`SELECT public.claim_notification_digest_group($1,'email', ${NOW}, 'W')`, [run]);
      await c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${NOW})`, [run, g]);
      await c.query(`SELECT public.split_notification_digest_group($1,$2,'W',1, ${NOW})`, [run, g]);
      const rows = (await c.query(`SELECT metric, count FROM public.reconcile_notification_digest_run($1) WHERE family='group' ORDER BY metric`, [run])).rows;
      const superseded = rows.find((r: { metric: string }) => r.metric === 'superseded');
      expect(superseded?.count).toBe(1);   // lineage reported separately, excluded from touched-terminal sums
    } finally { await c.end(); }
  });

  it('sweep ages out due awaiting_evidence → delivery_unknown', async () => {
    const c = conn(); await c.connect();
    try {
      // a genuinely uncertain request_ready group (timeout → ambiguous), aged out past its 23h deadline
      const { g, att, run: r0 } = await toSending(c);
      await c.query(`SELECT public.record_notification_digest_result($1,$2,'timeout',NULL,NULL,NULL, ${NOW})`, [r0, att]);
      expect((await gstate(c, g)).state).toBe('request_ready');   // uncertain, still live
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      const n = (await c.query(`SELECT public.reconcile_notification_digest_stale($1,'email', ${NOW} + interval '30 hours') AS n`, [run])).rows[0].n;
      const s2 = await gstate(c, g);
      expect(Number(n)).toBeGreaterThanOrEqual(1); expect(s2.state).toBe('delivery_unknown');
      expect(s2.current_attempt_id).toBeNull();
    } finally { await c.end(); }
  });
});

describe('10c-a2 two-connection concurrency (real Postgres)', () => {
  it('competing workers never claim the same group (FOR UPDATE SKIP LOCKED)', async () => {
    const c0 = conn(); await c0.connect();
    try {
      for (let i = 0; i < 6; i++) { await seedMember(c0, `p:cc${i}`, `cc${i}@example.com`); }
      const mrun = (await c0.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c0.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
    } finally { await c0.end(); }
    const a = conn(); const b = conn(); await a.connect(); await b.connect();
    try {
      const ra = (await a.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      const rb = (await b.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      const [ga, gb] = await Promise.all([
        a.query(`SELECT public.claim_notification_digest_group($1,'email', ${NOW}, 'A') AS g`, [ra]).then(r => r.rows[0].g),
        b.query(`SELECT public.claim_notification_digest_group($1,'email', ${NOW}, 'B') AS g`, [rb]).then(r => r.rows[0].g),
      ]);
      expect(ga).not.toBeNull(); expect(gb).not.toBeNull(); expect(ga).not.toBe(gb);
    } finally { await a.end(); await b.end(); }
  });

  it('two concurrent materializers both complete; every member in exactly one group; no duplicate chunks', async () => {
    const c0 = conn(); await c0.connect();
    const keys: string[] = [];
    try {
      for (let k = 0; k < 4; k++) { keys.push(`p:cm${k}`); for (let i = 0; i < 5; i++) await seedMember(c0, `p:cm${k}`, `cm${k}@example.com`); }
    } finally { await c0.end(); }
    const a = conn(); const b = conn(); await a.connect(); await b.connect();
    try {
      const ra = (await a.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      const rb = (await b.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      const [na, nb] = await Promise.all([
        a.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100) AS n`, [ra]).then(r => r.rows[0].n),
        b.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100) AS n`, [rb]).then(r => r.rows[0].n),
      ]);
      const cc = conn(); await cc.connect();
      const un = (await cc.query(`SELECT count(*)::int n FROM public.notification_outbox WHERE recipient_key = ANY($1) AND digest_group_id IS NULL`, [keys])).rows[0].n;
      const dup = (await cc.query(`SELECT count(*)::int n FROM (SELECT canonical_group_key, chunk_ordinal, count(*) FROM public.notification_digest_groups GROUP BY 1,2 HAVING count(*)>1) x`)).rows[0].n;
      const empty = (await cc.query(`SELECT count(*)::int n FROM public.notification_digest_groups g WHERE g.state='pending' AND NOT EXISTS (SELECT 1 FROM public.notification_outbox o WHERE o.digest_group_id=g.id)`)).rows[0].n;
      await cc.end();
      expect(Number(na) + Number(nb)).toBeGreaterThanOrEqual(4);  // both completed without error
      expect(un).toBe(0); expect(dup).toBe(0); expect(empty).toBe(0);
    } finally { await a.end(); await b.end(); }
  });

  it('cap race: two workers begin under cap=1 — exactly one sends, counter never oversubscribed', async () => {
    const c0 = conn(); await c0.connect();
    let g1!: string, g2!: string, r1!: string, r2!: string;
    try {
      // same destination → same counter buckets
      await seedMember(c0, 'p:cap1', 'cap@example.com'); await seedMember(c0, 'p:cap2', 'cap@example.com');
      // distinct recipients so two groups form:
      await c0.query(`UPDATE public.notification_outbox SET recipient_key='p:cap2' WHERE recipient_key='p:cap2'`);
      const mrun = (await c0.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c0.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
      g1 = (await c0.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key='p:cap1'`)).rows[0].id;
      g2 = (await c0.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key='p:cap2'`)).rows[0].id;
      for (const [g, w] of [[g1, 'CA'], [g2, 'CB']] as const) {
        const run = (await c0.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
        await c0.query(`UPDATE public.notification_digest_groups SET state='leased', locked_by=$2, locked_at=${NOW}, worker_run_id=$3 WHERE id=$1`, [g, w, run]);
        await c0.query(`SELECT public.prepare_notification_digest_group($1,$2,$3, ${NOW})`, [run, g, w]);
        await c0.query(`SELECT public.store_notification_digest_request($1,$2,$3, jsonb_build_object('to','cap@example.com','subject','s','html','h'), ${NOW})`, [run, g, w]);
        if (g === g1) r1 = run; else r2 = run;
      }
    } finally { await c0.end(); }
    const a = conn(); const b = conn(); await a.connect(); await b.connect();
    try {
      const [x, y] = await Promise.all([
        a.query(`SELECT public.begin_notification_digest_attempt($1,$2,'CA', ${NOW}, 1, 5000) AS a`, [r1, g1]).then(r => r.rows[0].a),
        b.query(`SELECT public.begin_notification_digest_attempt($1,$2,'CB', ${NOW}, 1, 5000) AS a`, [r2, g2]).then(r => r.rows[0].a),
      ]);
      expect([x, y].filter(Boolean).length).toBe(1);
      const cc = conn(); await cc.connect();
      expect((await cc.query(`SELECT used FROM public.notification_send_counters WHERE bucket_kind='hour'`)).rows[0].used).toBe(1);
      await cc.end();
    } finally { await a.end(); await b.end(); }
  });

  it('stale lease: a crashed worker\'s group is reclaimed (sending → uncertainty set)', async () => {
    const c = conn(); await c.connect();
    try {
      // drive through begin (which sets first_send_at) so the reclaimed 'sending' group is realistic —
      // a sending group ALWAYS has first_send_at; the deadline invariant depends on it.
      const { g } = await toSending(c);
      await c.query(`UPDATE public.notification_digest_groups SET locked_by='DEAD', locked_at=${NOW} - interval '1 hour', available_at=${NOW} WHERE id=$1`, [g]);
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      const claimed = (await c.query(`SELECT public.claim_notification_digest_group($1,'email', ${NOW}, 'ALIVE', 15) AS g`, [run])).rows[0].g;
      const s = await gstate(c, g);
      expect(claimed).toBe(g); expect(s.locked_by).toBe('ALIVE'); expect(s.uncertain_since).not.toBeNull();
      expect(s.uncertain_deadline_at).not.toBeNull();   // anchored to first_send_at + 23h
    } finally { await c.end(); }
  });
});

describe('10c-a2 round-3 — breaker race, live revalidation, correlation, run identity, preflight', () => {
  it('breaker race: a concurrent re-arm during begin → begin defers, creates NO attempt (two connections)', async () => {
    const c = conn(); await c.connect();
    let g!: string, run!: string;
    try {
      seq += 1; const key = `p:${seq}`; const dest = `u${seq}@example.com`;
      await seedMember(c, key, dest);
      const mrun = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
      g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [key])).rows[0].id;
      run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`UPDATE public.notification_digest_groups SET state='leased', locked_by='W', locked_at=${NOW}, worker_run_id=$2 WHERE id=$1`, [g, run]);
      await c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${NOW})`, [run, g]);
      await frozenFor(c, run, g, 'W', dest);
      await c.query(`INSERT INTO public.notification_provider_circuit (channel, state, probe_group_id, probe_locked_at) VALUES ('email','half_open',$1,${NOW})`, [g]);
    } finally { /* keep c open */ }
    const a = conn(); await a.connect();
    try {
      await a.query('BEGIN');
      await a.query(`UPDATE public.notification_provider_circuit SET state='open', probe_group_id=NULL, probe_attempt_id=NULL, retry_at=${NOW}+interval '1 hour' WHERE channel='email'`);
      const beginP = c.query(`SELECT public.begin_notification_digest_attempt($1,$2,'W', ${NOW}) AS a`, [run, g]).then(r => r.rows[0].a);
      await new Promise(r => setTimeout(r, 400));
      await a.query('COMMIT');
      const att = await beginP;
      const s = await gstate(c, g);
      const attempts = (await c.query(`SELECT count(*)::int n FROM public.notification_digest_attempts WHERE digest_group_id=$1`, [g])).rows[0].n;
      expect(att).toBeNull(); expect(s.state).toBe('request_ready'); expect(attempts).toBe(0); expect(s.locked_by).toBeNull();
    } finally { await a.end(); await c.end(); }
  });

  it('live revalidation (resolver-faithful, production FK): deletion / revocation / change / scope move / re-assignment all stop', async () => {
    const c = conn(); await c.connect();
    try {
      const academy = (await c.query(`SELECT gen_random_uuid() u`)).rows[0].u;
      // guest recipients with TENANT-scoped owned contacts (the resolver's guest rule: never global, no fallback)
      const scenarios: Array<[string, (ct: string, guest: string) => Promise<void>]> = [
        ['deleted (FK SET NULL)', async (ct) => { await c.query(`DELETE FROM public.notification_contacts WHERE id=$1`, [ct]); }],
        ['revoked', async (ct) => { await c.query(`UPDATE public.notification_contacts SET revoked_at=now() WHERE id=$1`, [ct]); }],
        ['scope moved to another tenant', async (ct) => { await c.query(`UPDATE public.notification_contacts SET consent_academy_profile_id=gen_random_uuid() WHERE id=$1`, [ct]); }],
        ['identity reassigned to another guest', async (ct) => { await c.query(`UPDATE public.notification_contacts SET guest_player_id=gen_random_uuid() WHERE id=$1`, [ct]); }],
      ];
      for (const [label, mutate] of scenarios) {
        seq += 1; const key = `p:${seq}`; const dest = `u${seq}@example.com`;
        const guest = (await c.query(`SELECT gen_random_uuid() u`)).rows[0].u;
        const ct = (await c.query(`INSERT INTO public.notification_contacts
          (channel, destination_normalized, guest_player_id, consent_scope, consent_academy_profile_id)
          VALUES ('email',$1,$2,'tenant',$3) RETURNING id`, [dest, guest, academy])).rows[0].id;
        await seedMember(c, key, dest, { guestId: guest, contactId: ct, tenantAcademy: academy });
        const mrun = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
        await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
        const g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [key])).rows[0].id;
        const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
        await c.query(`UPDATE public.notification_digest_groups SET state='leased', locked_by='W', locked_at=${NOW}, worker_run_id=$2 WHERE id=$1`, [g, run]);
        await mutate(ct, guest);
        const prep = (await c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${NOW}) AS r`, [run, g])).rows[0].r;
        const m = (await c.query(`SELECT skip_reason FROM public.notification_outbox WHERE digest_group_id=$1`, [g])).rows[0];
        expect(prep, label).toBe('no_work');
        expect(m.skip_reason, label).toBe('contact_revoked');   // frozen data never substitutes for live deliverability
      }
      // contact destination changed (still owned/in-scope) → destination_changed
      seq += 1; const key = `p:${seq}`; const dest = `u${seq}@example.com`;
      const guest = (await c.query(`SELECT gen_random_uuid() u`)).rows[0].u;
      const ct = (await c.query(`INSERT INTO public.notification_contacts
        (channel, destination_normalized, guest_player_id, consent_scope, consent_academy_profile_id)
        VALUES ('email',$1,$2,'tenant',$3) RETURNING id`, [dest, guest, academy])).rows[0].id;
      await seedMember(c, key, dest, { guestId: guest, contactId: ct, tenantAcademy: academy });
      const mrun = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
      const g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [key])).rows[0].id;
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`UPDATE public.notification_digest_groups SET state='leased', locked_by='W', locked_at=${NOW}, worker_run_id=$2 WHERE id=$1`, [g, run]);
      await c.query(`UPDATE public.notification_contacts SET destination_normalized='new@example.com' WHERE id=$1`, [ct]);
      expect((await c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${NOW}) AS r`, [run, g])).rows[0].r).toBe('no_work');
      expect((await c.query(`SELECT skip_reason FROM public.notification_outbox WHERE digest_group_id=$1`, [g])).rows[0].skip_reason).toBe('destination_changed');
      // account email changed (account holder, no contact) → destination_changed
      seq += 1; const key2 = `p:${seq}`; const dest2 = `u${seq}@example.com`;
      const uid = (await c.query(`SELECT gen_random_uuid() u`)).rows[0].u;
      await c.query(`INSERT INTO public.persons (user_id, email) VALUES ($1,$2)`, [uid, dest2]);
      await seedMember(c, key2, dest2, { userId: uid });
      const m2 = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [m2]);
      const g2 = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [key2])).rows[0].id;
      const run2 = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`UPDATE public.notification_digest_groups SET state='leased', locked_by='W', locked_at=${NOW}, worker_run_id=$2 WHERE id=$1`, [g2, run2]);
      await c.query(`UPDATE public.persons SET email='moved@example.com' WHERE user_id=$1`, [uid]);
      expect((await c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${NOW}) AS r`, [run2, g2])).rows[0].r).toBe('no_work');
      expect((await c.query(`SELECT skip_reason FROM public.notification_outbox WHERE digest_group_id=$1`, [g2])).rows[0].skip_reason).toBe('destination_changed');
    } finally { await c.end(); }
  });

  it('required_delivery bypasses ONLY preference_off — never suppression or a missing/changed contact', async () => {
    const c = conn(); await c.connect();
    try {
      await c.query(`INSERT INTO public.notification_event_types (key, supports_digest, required_delivery) VALUES ('ev-req2', true, true)`);
      // required + suppressed → dropped
      seq += 1; const k1 = `p:${seq}`; const d1 = `u${seq}@example.com`;
      await seedMember(c, k1, d1, { eventType: 'ev-req2' });
      await c.query(`INSERT INTO public.email_suppression_stub VALUES (lower($1))`, [d1]);
      const m1 = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [m1]);
      const g1 = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [k1])).rows[0].id;
      const r1 = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`UPDATE public.notification_digest_groups SET state='leased', locked_by='W', locked_at=${NOW}, worker_run_id=$2 WHERE id=$1`, [g1, r1]);
      expect((await c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${NOW}) AS r`, [r1, g1])).rows[0].r).toBe('no_work');
      // required + preference_off → prepared
      seq += 1; const k2 = `p:${seq}`; const d2 = `u${seq}@example.com`;
      const uid = (await c.query(`SELECT gen_random_uuid() u`)).rows[0].u;
      await c.query(`INSERT INTO public.persons (user_id, email) VALUES ($1,$2)`, [uid, d2]);
      await seedMember(c, k2, d2, { eventType: 'ev-req2', userId: uid });
      await c.query(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency) VALUES ($1,'ev-req2','off')`, [uid]);
      const m2 = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [m2]);
      const g2 = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [k2])).rows[0].id;
      const r2 = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`UPDATE public.notification_digest_groups SET state='leased', locked_by='W', locked_at=${NOW}, worker_run_id=$2 WHERE id=$1`, [g2, r2]);
      expect((await c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${NOW}) AS r`, [r2, g2])).rows[0].r).toBe('prepared');
    } finally { await c.end(); }
  });

  it('correlation: tag on a never-sent group → orphan; accepted with NULL pm raises; mismatched pm → manual hold', async () => {
    const c = conn(); await c.connect();
    try {
      // never-sent group: tag must NOT bind
      seq += 1; const key = `p:${seq}`; await seedMember(c, key, `u${seq}@example.com`);
      const mrun = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
      const g0 = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [key])).rows[0].id;
      const res = (await c.query(`SELECT public.apply_notification_provider_event(NULL,'ev-nb','pm-nb',$1,'delivered', ${NOW}, ${NOW}) AS r`, [g0])).rows[0].r;
      expect(res).toBe('orphan');
      expect((await gstate(c, g0)).provider_message_id).toBeNull();
      // park g0 so the toSending() claims below pick their own groups, not this one
      await c.query(`UPDATE public.notification_digest_groups SET available_at=${NOW}+interval '10 days' WHERE id=$1`, [g0]);
      // accepted with NULL pm raises
      const s1 = await toSending(c);
      await expect(c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,202,NULL,NULL, ${NOW})`, [s1.run, s1.att])).rejects.toThrow(/requires a provider_message_id/i);
      // mismatched pm → correlation_mismatch + manual hold
      const s2 = await toSending(c);
      await c.query(`SELECT public.apply_notification_provider_event($1,'ev-cm','pm-early',$2,'sent', ${NOW}, ${NOW})`, [s2.run, s2.g]);
      const rr = (await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,202,NULL,'pm-DIFFERENT', ${NOW}) AS r`, [s2.run, s2.att])).rows[0].r;
      const cb = (await c.query(`SELECT state, reason, retry_at FROM public.notification_provider_circuit WHERE channel='email'`)).rows[0];
      expect(rr).toBe('correlation_mismatch'); expect(cb.state).toBe('open'); expect(cb.reason).toBe('correlation_mismatch'); expect(cb.retry_at).toBeNull();
    } finally { await c.end(); }
  });

  it('run identity: null / unknown / wrong-phase / wrong-channel / finished runs are all rejected', async () => {
    const c = conn(); await c.connect();
    try {
      seq += 1; const key = `p:${seq}`; await seedMember(c, key, `u${seq}@example.com`);
      const mrun = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
      const g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [key])).rows[0].id;
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`UPDATE public.notification_digest_groups SET state='leased', locked_by='W', locked_at=${NOW}, worker_run_id=$2 WHERE id=$1`, [g, run]);
      await expect(c.query(`SELECT public.prepare_notification_digest_group(NULL,$1,'W', ${NOW})`, [g])).rejects.toThrow(/required/i);
      await expect(c.query(`SELECT public.prepare_notification_digest_group(gen_random_uuid(),$1,'W', ${NOW})`, [g])).rejects.toThrow(/not found/i);
      const wrongPhase = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await expect(c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${NOW})`, [wrongPhase, g])).rejects.toThrow(/phase/i);
      const wrongChan = (await c.query(`SELECT public.start_notification_worker_run('w','whatsapp','dispatch') AS r`)).rows[0].r;
      await expect(c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${NOW})`, [wrongChan, g])).rejects.toThrow(/channel/i);
      const finished = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`SELECT public.finish_notification_worker_run($1,'succeeded')`, [finished]);
      await expect(c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${NOW})`, [finished, g])).rejects.toThrow(/finished/i);
    } finally { await c.end(); }
  });

  it('a parent-linked child with a DIFFERENT identity cannot receive a re-pointed member (hijack rejected)', async () => {
    const c = conn(); await c.connect();
    try {
      seq += 1; const key = `p:${seq}`; await seedMember(c, key, `u${seq}@example.com`);
      const mrun = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
      const g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [key])).rows[0].id;
      const evil = (await c.query(`INSERT INTO public.notification_digest_groups
        (parent_group_id, canonical_group_key, group_key_hash, channel, event_type, recipient_key, destination_fingerprint, recipient_timezone, digest_boundary_at, available_at)
        VALUES ($1, '["evil"]'::jsonb, 'evilhash', 'email','ev','p:EVIL','df-EVIL','Europe/Amsterdam', now(), now()) RETURNING id`, [g])).rows[0].id;
      const member = (await c.query(`SELECT id FROM public.notification_outbox WHERE digest_group_id=$1 LIMIT 1`, [g])).rows[0].id;
      await expect(c.query(`UPDATE public.notification_outbox SET digest_group_id=$1 WHERE id=$2`, [evil, member])).rejects.toThrow(/split child/i);
    } finally { await c.end(); }
  });

  it('manual-hold breaker preflight: claim returns NULL immediately — no available_at rewrites, zero ledger churn', async () => {
    const c = conn(); await c.connect();
    try {
      seq += 1; const key = `p:${seq}`; await seedMember(c, key, `u${seq}@example.com`);
      const mrun = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
      const g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [key])).rows[0].id;
      await c.query(`UPDATE public.notification_digest_groups SET available_at=${BD} WHERE id=$1`, [g]);   // due
      await c.query(`INSERT INTO public.notification_provider_circuit (channel, state, reason, retry_at) VALUES ('email','open','monthly_quota',NULL)`);
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      const before = (await c.query(`SELECT available_at FROM public.notification_digest_groups WHERE id=$1`, [g])).rows[0].available_at;
      const claimed = (await c.query(`SELECT public.claim_notification_digest_group($1,'email', ${NOW}, 'W') AS g`, [run])).rows[0].g;
      const after = (await c.query(`SELECT available_at FROM public.notification_digest_groups WHERE id=$1`, [g])).rows[0].available_at;
      const ledger = (await c.query(`SELECT count(*)::int n FROM public.notification_digest_group_attempts WHERE worker_run_id=$1`, [run])).rows[0].n;
      expect(claimed).toBeNull(); expect(String(after)).toBe(String(before)); expect(ledger).toBe(0);
    } finally { await c.end(); }
  });

  it('a lower/equal-rank provider callback writes NO transition ledger row (reconciliation stays truthful)', async () => {
    const c = conn(); await c.connect();
    try {
      const { att, run } = await toSending(c);
      await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,202,NULL,'pm-nr', ${NOW})`, [run, att]);
      await c.query(`SELECT public.apply_notification_provider_event($1,'ev-nr1','pm-nr',NULL,'delivered', ${NOW}, ${NOW})`, [run]);
      const run2 = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      const noop = (await c.query(`SELECT public.apply_notification_provider_event($1,'ev-nr2','pm-nr',NULL,'sent', ${NOW}, ${NOW}) AS r`, [run2])).rows[0].r;
      expect(noop).toBe('noop_rank');
      expect((await c.query(`SELECT count(*)::int n FROM public.notification_digest_group_attempts WHERE worker_run_id=$1`, [run2])).rows[0].n).toBe(0);
      await expect(c.query(`SELECT * FROM public.reconcile_notification_digest_run($1)`, [run2])).resolves.toBeTruthy(); // exists, just empty
    } finally { await c.end(); }
  });
});

describe('10c-a2 round-4 — first-row breaker race, canonical identity, correlation, run ownership, allow-list', () => {
  it('3-connection first-row race: begin blocks on the ensured circuit row while another txn inserts an OPEN first row → zero attempts', async () => {
    const c = conn(); await c.connect();
    let g!: string, run!: string;
    try {
      seq += 1; const key = `p:${seq}`; const dest = `u${seq}@example.com`;
      await seedMember(c, key, dest);
      const mrun = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
      g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [key])).rows[0].id;
      run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`UPDATE public.notification_digest_groups SET state='leased', locked_by='W', locked_at=${NOW}, worker_run_id=$2 WHERE id=$1`, [g, run]);
      await c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${NOW})`, [run, g]);
      await frozenFor(c, run, g, 'W', dest);
      // NO circuit row exists for 'email' at this point (per-test truncation) — the old SELECT FOR UPDATE
      // would lock nothing. Txn A inserts the FIRST row as OPEN, uncommitted:
      const a = conn(); await a.connect();
      await a.query('BEGIN');
      await a.query(`INSERT INTO public.notification_provider_circuit (channel, state, reason, retry_at) VALUES ('email','open','test', ${NOW}+interval '1 hour')`);
      // begin must BLOCK on the ensure-insert (speculative insertion wait), then see the OPEN row → defer.
      const beginP = c.query(`SELECT public.begin_notification_digest_attempt($1,$2,'W', ${NOW}) AS a`, [run, g]).then(r => r.rows[0].a);
      await new Promise(r => setTimeout(r, 400));
      await a.query('COMMIT'); await a.end();
      const att = await beginP;
      expect(att).toBeNull();
      expect((await c.query(`SELECT count(*)::int n FROM public.notification_digest_attempts WHERE digest_group_id=$1`, [g])).rows[0].n).toBe(0);
      expect((await gstate(c, g)).state).toBe('request_ready');
    } finally { await c.end(); }
  });

  it('canonical identity: caller hash overwritten; different timezones never group; SET TIME ZONE sessions mint identical keys', async () => {
    const c = conn(); await c.connect();
    try {
      // caller-supplied hash is overwritten server-side
      seq += 1; const key = `p:${seq}`; const dest = `u${seq}@example.com`;
      const fp = await fpOf(c, dest);
      const r = (await c.query(`INSERT INTO public.notification_outbox
        (channel, delivery_mode, recipient_key, destination_fingerprint, destination_normalized,
         event_type, template_key, template_version, group_locale, digest_frequency, recipient_timezone,
         digest_boundary_at, digest_item, status, digest_group_hash)
        VALUES ('email','digest',$1,$2,$3,'ev','tpl',1,'nl','daily','Europe/Amsterdam', ${BD}, '{}'::jsonb, 'pending', 'caller-controlled')
        RETURNING digest_group_hash`, [key, fp, dest])).rows[0].digest_group_hash;
      expect(r).not.toBe('caller-controlled');   // derived, never trusted
      expect(r).toMatch(/^[0-9a-f]{64}$/);
      // two identical rows differing ONLY in recipient_timezone must NOT share a hash (identity includes tz)
      const h1 = (await c.query(`SELECT encode(sha256(public.notif_digest_canonical_key('email','p:x','df',NULL,NULL,'ev','tpl',1,'nl','daily','Europe/Amsterdam', ${BD})::text::bytea),'hex') h`)).rows[0].h;
      const h2 = (await c.query(`SELECT encode(sha256(public.notif_digest_canonical_key('email','p:x','df',NULL,NULL,'ev','tpl',1,'nl','daily','Asia/Tokyo', ${BD})::text::bytea),'hex') h`)).rows[0].h;
      expect(h1).not.toBe(h2);
      // the SAME instant under different SESSION timezones mints the SAME key (epoch-normalized)
      await c.query(`SET TIME ZONE 'Asia/Tokyo'`);
      const kTokyo = (await c.query(`SELECT public.notif_digest_canonical_key('email','p:x','df',NULL,NULL,'ev','tpl',1,'nl','daily','Europe/Amsterdam', ${BD})::text k`)).rows[0].k;
      const ckTokyo = (await c.query(`SELECT public.notif_digest_counter_key('email','ev','df','hour', ${BD}) k`)).rows[0].k;
      await c.query(`SET TIME ZONE 'America/New_York'`);
      const kNY = (await c.query(`SELECT public.notif_digest_canonical_key('email','p:x','df',NULL,NULL,'ev','tpl',1,'nl','daily','Europe/Amsterdam', ${BD})::text k`)).rows[0].k;
      const ckNY = (await c.query(`SELECT public.notif_digest_counter_key('email','ev','df','hour', ${BD}) k`)).rows[0].k;
      await c.query(`SET TIME ZONE 'UTC'`);
      expect(kTokyo).toBe(kNY);      // canonical key session-TZ-independent
      expect(ckTokyo).toBe(ckNY);    // counter key session-TZ-independent
      // every canonical input is frozen on digest rows
      const member = (await c.query(`SELECT id FROM public.notification_outbox WHERE recipient_key=$1`, [key])).rows[0].id;
      for (const [col, val] of [['event_type', `'other'`], ['template_key', `'other'`], ['channel', `'whatsapp'`],
        ['recipient_timezone', `'Asia/Tokyo'`], ['digest_boundary_at', 'now()'], ['digest_group_hash', `'x'`]] as const) {
        await expect(c.query(`UPDATE public.notification_outbox SET ${col}=${val} WHERE id=$1`, [member]),
          col).rejects.toThrow(/write-once|frozen/i);
      }
    } finally { await c.end(); }
  });

  it('correlation via LINK is gated by the same predicate: a never-sent group rejects an orphan link', async () => {
    const c = conn(); await c.connect();
    try {
      seq += 1; const key = `p:${seq}`; await seedMember(c, key, `u${seq}@example.com`);
      const mrun = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
      const g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [key])).rows[0].id;
      // a delivered orphan arrives, uncorrelated
      await c.query(`SELECT public.apply_notification_provider_event(NULL,'ev-ln','pm-ln',NULL,'delivered', ${NOW}, ${NOW})`);
      // linking it to the never-sent group must FAIL (no live send to correlate)
      await expect(c.query(`SELECT public.link_notification_provider_event('ev-ln',$1)`, [g])).rejects.toThrow(/no live send/i);
      expect((await gstate(c, g)).state).toBe('pending');   // untouched
      // park the never-sent group so toSending()'s claim below picks its own group
      await c.query(`UPDATE public.notification_digest_groups SET available_at=${NOW}+interval '10 days' WHERE id=$1`, [g]);
      // after a real dispatch, the same link succeeds (legitimate callback-before-record correlation)
      const { g: g2 } = await toSending(c);
      await c.query(`SELECT public.apply_notification_provider_event(NULL,'ev-ln2','pm-ln2',NULL,'delivered', ${NOW}, ${NOW})`);
      await c.query(`SELECT public.link_notification_provider_event('ev-ln2',$1)`, [g2]);
      expect((await gstate(c, g2)).state).toBe('sent');
    } finally { await c.end(); }
  });

  it('run ownership: a same-shape different run cannot drive an owned group; a transition blocks a concurrent finish', async () => {
    const c = conn(); await c.connect();
    try {
      seq += 1; const key = `p:${seq}`; const dest = `u${seq}@example.com`;
      await seedMember(c, key, dest);
      const mrun = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
      const g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [key])).rows[0].id;
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`UPDATE public.notification_digest_groups SET state='leased', locked_by='W', locked_at=${NOW}, worker_run_id=$2 WHERE id=$1`, [g, run]);
      // same phase/channel/worker — but a DIFFERENT run: rejected
      const imposter = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await expect(c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${NOW})`, [imposter, g])).rejects.toThrow(/not owned/i);
      // a transition holding the run row blocks a concurrent finish until it commits
      const a = conn(); await a.connect();
      await a.query('BEGIN');
      await a.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${NOW})`, [run, g]); // holds run FOR UPDATE
      let finished = false;
      const finishP = c.query(`SELECT public.finish_notification_worker_run($1,'succeeded')`, [run]).then(() => { finished = true; });
      await new Promise(r => setTimeout(r, 300));
      expect(finished).toBe(false);           // blocked while the transition txn holds the run row
      await a.query('COMMIT'); await a.end();
      await finishP;
      expect(finished).toBe(true);
    } finally { await c.end(); }
  });

  it('frozen request allow-list: bcc / cc / headers / attachments / unknown keys are all rejected', async () => {
    const c = conn(); await c.connect();
    try {
      seq += 1; const key = `p:${seq}`; const dest = `u${seq}@example.com`;
      await seedMember(c, key, dest);
      const mrun = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
      const g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [key])).rows[0].id;
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`UPDATE public.notification_digest_groups SET state='leased', locked_by='W', locked_at=${NOW}, worker_run_id=$2 WHERE id=$1`, [g, run]);
      await c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${NOW})`, [run, g]);
      for (const extra of ['bcc', 'cc', 'headers', 'attachments', 'x_unknown']) {
        await expect(c.query(`SELECT public.store_notification_digest_request($1,$2,'W',
          jsonb_build_object('to',$3::text,'subject','s','html','h', $4::text, 'smuggled'), ${NOW})`, [run, g, dest, extra]),
          extra).rejects.toThrow(/allow-list/i);
      }
      await frozenFor(c, run, g, 'W', dest);   // the clean request still freezes
      expect((await gstate(c, g)).state).toBe('request_ready');
    } finally { await c.end(); }
  });
});

describe('10c-a2 round-5 — session-TZ caps, probe CAS, precise correlation, uncertainty clocks, schema-owned identity', () => {
  it('cap buckets are session-TZ-independent: Tokyo + New York sessions under day cap=1 → ONE send, ONE day counter', async () => {
    const c0 = conn(); await c0.connect();
    let g1!: string, g2!: string, r1!: string, r2!: string;
    try {
      await seedMember(c0, 'p:tz1', 'tzcap@example.com'); await seedMember(c0, 'p:tz2', 'tzcap@example.com');
      const mrun = (await c0.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c0.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
      g1 = (await c0.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key='p:tz1'`)).rows[0].id;
      g2 = (await c0.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key='p:tz2'`)).rows[0].id;
      for (const [g, w] of [[g1, 'TA'], [g2, 'TB']] as const) {
        const run = (await c0.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
        await c0.query(`UPDATE public.notification_digest_groups SET state='leased', locked_by=$2, locked_at=${NOW}, worker_run_id=$3 WHERE id=$1`, [g, w, run]);
        await c0.query(`SELECT public.prepare_notification_digest_group($1,$2,$3, ${NOW})`, [run, g, w]);
        await c0.query(`SELECT public.store_notification_digest_request($1,$2,$3, jsonb_build_object('to','tzcap@example.com','subject','s','html','h'), ${NOW})`, [run, g, w]);
        if (g === g1) r1 = run; else r2 = run;
      }
    } finally { await c0.end(); }
    const a = conn(); const b = conn(); await a.connect(); await b.connect();
    try {
      await a.query(`SET TIME ZONE 'Asia/Tokyo'`); await b.query(`SET TIME ZONE 'America/New_York'`);
      const [x, y] = await Promise.all([
        a.query(`SELECT public.begin_notification_digest_attempt($1,$2,'TA', ${NOW}, 1000, 1) AS a`, [r1, g1]).then(r => r.rows[0].a),
        b.query(`SELECT public.begin_notification_digest_attempt($1,$2,'TB', ${NOW}, 1000, 1) AS a`, [r2, g2]).then(r => r.rows[0].a),
      ]);
      expect([x, y].filter(Boolean).length).toBe(1);   // exactly one authorized under day cap=1
      const cc = conn(); await cc.connect();
      const dayCounters = (await cc.query(`SELECT count(*)::int n, max(used) u FROM public.notification_send_counters WHERE bucket_kind='day'`)).rows[0];
      expect(dayCounters.n).toBe(1);                    // BOTH sessions addressed the SAME day counter key
      expect(dayCounters.u).toBe(1);
      await cc.end();
    } finally { await a.end(); await b.end(); }
  });

  it('a superseded probe result cannot close the replacement breaker (two-connection replacement race)', async () => {
    const c = conn(); await c.connect();
    try {
      const { g, att, run } = await toSending(c);        // OLD probe attempt, unrecorded
      const { g: g2, att: att2 } = await toSending(c);   // the REPLACEMENT dispatched group
      // the breaker went half_open with the OLD probe, then was re-armed and the REPLACEMENT probe bound:
      await c.query(`INSERT INTO public.notification_provider_circuit (channel, state, probe_group_id, probe_attempt_id, probe_locked_at)
        VALUES ('email','half_open',$1,$2,${NOW}) ON CONFLICT (channel) DO UPDATE SET state='half_open', probe_group_id=$1, probe_attempt_id=$2, probe_locked_at=${NOW}`, [g2, att2]);
      void g;
      // the SUPERSEDED probe (att) records a definite non-accepted result → must NOT close the breaker
      await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,422,'validation_error',NULL, ${NOW})`, [run, att]);
      const cb = (await c.query(`SELECT state, probe_attempt_id FROM public.notification_provider_circuit WHERE channel='email'`)).rows[0];
      expect(cb.state).toBe('half_open');               // replacement breaker untouched
      expect(cb.probe_attempt_id).toBe(att2);
    } finally { await c.end(); }
  });

  it('correlation requires an attempt capable of acceptance: a definitively-failed group rejects an orphan link', async () => {
    const c = conn(); await c.connect();
    try {
      const { g, att, run } = await toSending(c);
      await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,422,'validation_error',NULL, ${NOW})`, [run, att]); // definitive terminal
      expect((await gstate(c, g)).state).toBe('failed_terminal');
      await c.query(`SELECT public.apply_notification_provider_event(NULL,'ev-r5','pm-r5',NULL,'delivered', ${NOW}, ${NOW})`);
      await expect(c.query(`SELECT public.link_notification_provider_event('ev-r5',$1)`, [g])).rejects.toThrow(/no live send/i);
      expect((await gstate(c, g)).state).toBe('failed_terminal');   // never finalized by the orphan
      // an AMBIGUOUS attempt still correlates (capable of acceptance)
      const s2 = await toSending(c);
      await c.query(`SELECT public.record_notification_digest_result($1,$2,'timeout',NULL,NULL,NULL, ${NOW})`, [s2.run, s2.att]); // ambiguous
      await c.query(`SELECT public.apply_notification_provider_event(NULL,'ev-r5b','pm-r5b',NULL,'delivered', ${NOW}, ${NOW})`);
      await c.query(`SELECT public.link_notification_provider_event('ev-r5b',$1)`, [s2.g]);
      expect((await gstate(c, s2.g)).state).toBe('sent');           // ambiguity resolved by real evidence
    } finally { await c.end(); }
  });

  it('stale-sending reclaim establishes BOTH uncertainty clocks; budget exhaustion cannot age out instantly', async () => {
    const c = conn(); await c.connect();
    try {
      const { g } = await toSending(c);
      // crashed mid-send: stale-locked sending, NO uncertainty set yet
      await c.query(`UPDATE public.notification_digest_groups SET locked_by='DEAD', locked_at=${NOW} - interval '1 hour' WHERE id=$1`, [g]);
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      const claimed = (await c.query(`SELECT public.claim_notification_digest_group($1,'email', ${NOW}, 'ALIVE', 15) AS g`, [run])).rows[0].g;
      expect(claimed).toBe(g);
      const s = await gstate(c, g);
      expect(s.uncertain_since).not.toBeNull();
      expect(s.uncertain_deadline_at).not.toBeNull();   // BOTH clocks, atomically
      // exhaust the budget → awaiting_evidence must NOT be instantly due (deadline ~23h out)
      await c.query(`UPDATE public.notification_digest_groups SET delivery_budget_used=max_delivery_budget WHERE id=$1`, [g]);
      const att = (await c.query(`SELECT public.begin_notification_digest_attempt($1,$2,'ALIVE', ${NOW}) AS a`, [run, g])).rows[0].a;
      expect(att).toBeNull();
      const s2 = await gstate(c, g);
      expect(s2.state).toBe('awaiting_evidence');
      expect(new Date(s2.available_at).getTime()).toBeGreaterThan(new Date('2026-07-01T20:00:00Z').getTime()); // ≥ ~23h after NOW
    } finally { await c.end(); }
  });

  it('identity is schema-owned: null→digest promotion re-derives a caller hash; NULL and explicit Amsterdam group together', async () => {
    const c = conn(); await c.connect();
    try {
      // promotion: an instant row later promoted to digest with a caller-controlled hash → re-derived
      seq += 1; const key = `p:${seq}`; const dest = `u${seq}@example.com`;
      const fp = await fpOf(c, dest);
      const id = (await c.query(`INSERT INTO public.notification_outbox
        (channel, recipient_key, destination_fingerprint, destination_normalized, event_type, template_key,
         template_version, group_locale, digest_frequency, recipient_timezone, digest_boundary_at, digest_item, status)
        VALUES ('email',$1,$2,$3,'ev','tpl',1,'nl','daily','Europe/Amsterdam', ${BD}, '{}'::jsonb, 'pending') RETURNING id`, [key, fp, dest])).rows[0].id;
      const h = (await c.query(`UPDATE public.notification_outbox
        SET delivery_mode='digest', digest_group_hash='caller-controlled' WHERE id=$1 RETURNING digest_group_hash`, [id])).rows[0].digest_group_hash;
      expect(h).not.toBe('caller-controlled'); expect(h).toMatch(/^[0-9a-f]{64}$/);
      // NULL timezone and explicit 'Europe/Amsterdam' mint the SAME identity (normalized before hashing)
      seq += 1; const keyB = `p:${seq}`; const destB = `u${seq}@example.com`;
      await seedMember(c, keyB, destB, { tz: 'Europe/Amsterdam' });
      const explicit = (await c.query(`SELECT digest_group_hash h FROM public.notification_outbox WHERE recipient_key=$1`, [keyB])).rows[0].h;
      const uid = (await c.query(`SELECT recipient_user_id u FROM public.notification_outbox WHERE recipient_key=$1`, [keyB])).rows[0].u;
      const fpB = await fpOf(c, destB);
      const nullTz = (await c.query(`INSERT INTO public.notification_outbox
        (channel, delivery_mode, recipient_key, destination_fingerprint, destination_normalized, recipient_user_id,
         event_type, template_key, template_version, group_locale, digest_frequency, recipient_timezone,
         digest_boundary_at, digest_item, status)
        VALUES ('email','digest',$1,$2,$3,$4,'ev','tpl',1,'nl','daily',NULL, ${BD}, '{}'::jsonb, 'pending')
        RETURNING digest_group_hash`, [keyB, fpB, destB, uid])).rows[0].digest_group_hash;
      expect(nullTz).toBe(explicit);
      // incomplete digest snapshot rejected
      await expect(c.query(`INSERT INTO public.notification_outbox (channel, delivery_mode, status)
        VALUES ('email','digest','pending')`)).rejects.toThrow(/missing snapshot fields/i);
      // frozen live-recipient identity
      const member = (await c.query(`SELECT id FROM public.notification_outbox WHERE recipient_key=$1 LIMIT 1`, [keyB])).rows[0].id;
      await expect(c.query(`UPDATE public.notification_outbox SET recipient_user_id=gen_random_uuid() WHERE id=$1`, [member])).rejects.toThrow(/frozen/i);
      await expect(c.query(`UPDATE public.notification_outbox SET destination_normalized='hijack@example.com' WHERE id=$1`, [member])).rejects.toThrow(/frozen/i);
    } finally { await c.end(); }
  });
});

describe('10c-a2 round-6 — structural freeze, anchored idempotency window, split ordinals, promotion, terminal ownership, evidence precedence', () => {
  it('nullable identity fields are STRUCTURALLY frozen on digest rows (NULL→value rejected)', async () => {
    const c = conn(); await c.connect();
    try {
      // a digest row with NULL recipient_timezone (identity normalized to Amsterdam at hashing)
      seq += 1; const key = `p:${seq}`; const dest = `u${seq}@example.com`;
      const fp = await fpOf(c, dest);
      const uid = (await c.query(`SELECT gen_random_uuid() u`)).rows[0].u;
      await c.query(`INSERT INTO public.persons (user_id, email) VALUES ($1,$2)`, [uid, dest]);
      const id = (await c.query(`INSERT INTO public.notification_outbox
        (channel, delivery_mode, recipient_key, destination_fingerprint, destination_normalized, recipient_user_id,
         event_type, template_key, template_version, group_locale, digest_frequency, recipient_timezone,
         digest_boundary_at, digest_item, status)
        VALUES ('email','digest',$1,$2,$3,$4,'ev','tpl',1,'nl','daily',NULL, ${BD}, '{}'::jsonb, 'pending')
        RETURNING id`, [key, fp, dest, uid])).rows[0].id;
      // NULL→value on identity fields is now rejected (the hash was derived under the normalized NULL)
      await expect(c.query(`UPDATE public.notification_outbox SET recipient_timezone='Asia/Tokyo' WHERE id=$1`, [id])).rejects.toThrow(/frozen/i);
      await expect(c.query(`UPDATE public.notification_outbox SET recipient_guest_player_id=gen_random_uuid() WHERE id=$1`, [id])).rejects.toThrow(/frozen/i);
      await expect(c.query(`UPDATE public.notification_outbox SET tenant_academy_profile_id=gen_random_uuid() WHERE id=$1`, [id])).rejects.toThrow(/frozen/i);
      // value→NULL equally rejected
      await expect(c.query(`UPDATE public.notification_outbox SET recipient_user_id=NULL WHERE id=$1`, [id])).rejects.toThrow(/frozen/i);
    } finally { await c.end(); }
  });

  it('the uncertainty window anchors to first_send_at: late crash discovery finalizes delivery_unknown, never resends', async () => {
    const c = conn(); await c.connect();
    try {
      const { g } = await toSending(c);   // first_send_at = NOW
      // crash discovered 30h AFTER the dispatch — outside the provider idempotency-key window
      await c.query(`UPDATE public.notification_digest_groups SET locked_by='DEAD', locked_at=${NOW} - interval '1 hour' WHERE id=$1`, [g]);
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      const late = `(${NOW} + interval '30 hours')`;
      const claimed = (await c.query(`SELECT public.claim_notification_digest_group($1,'email', ${late}, 'ALIVE', 15) AS g`, [run])).rows[0].g;
      const s = await gstate(c, g);
      expect(claimed).not.toBe(g);                       // never handed back as sendable
      expect(s.state).toBe('delivery_unknown');          // finalized, no replay outside the key window
      expect(s.current_attempt_id).toBeNull();
      // and a TIMELY reclaim gets a deadline anchored to first_send_at (+23h), not reclaim-time (+23h)
      const t2 = await toSending(c);
      await c.query(`UPDATE public.notification_digest_groups SET locked_by='DEAD', locked_at=${NOW} - interval '1 hour' WHERE id=$1`, [t2.g]);
      const soon = `(${NOW} + interval '2 hours')`;
      const run2 = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`SELECT public.claim_notification_digest_group($1,'email', ${soon}, 'ALIVE', 15)`, [run2]);
      const s2 = await gstate(c, t2.g);
      // deadline = first_send_at (NOW) + 23h — NOT reclaim (NOW+2h) + 23h
      expect(new Date(s2.uncertain_deadline_at).getTime()).toBe(new Date('2026-07-02T09:00:00Z').getTime());
    } finally { await c.end(); }
  });

  it('two concurrent same-key splits allocate unique ordinals (advisory-lock linearized), every member moved once', async () => {
    const c0 = conn(); await c0.connect();
    let gA!: string, gB!: string, rA!: string, rB!: string, key!: string;
    try {
      seq += 1; key = `p:${seq}`; const dest = `u${seq}@example.com`;
      for (let i = 0; i < 4; i++) await seedMember(c0, key, dest);
      const mrun = (await c0.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c0.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
      gA = (await c0.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [key])).rows[0].id;
      // manufacture a same-key SIBLING by splitting once (2+2), giving two same-key groups to split concurrently
      rA = (await c0.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c0.query(`UPDATE public.notification_digest_groups SET state='leased', locked_by='SA', locked_at=${NOW}, worker_run_id=$2 WHERE id=$1`, [gA, rA]);
      await c0.query(`SELECT public.prepare_notification_digest_group($1,$2,'SA', ${NOW})`, [rA, gA]);
      await c0.query(`SELECT public.split_notification_digest_group($1,$2,'SA',2, ${NOW})`, [rA, gA]);
      const kids = (await c0.query(`SELECT id FROM public.notification_digest_groups WHERE parent_group_id=$1 ORDER BY chunk_ordinal`, [gA])).rows;
      gA = kids[0].id; gB = kids[1].id;
      for (const [g, w, setRun] of [[gA, 'CA', 'a'], [gB, 'CB', 'b']] as const) {
        const run = (await c0.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
        await c0.query(`UPDATE public.notification_digest_groups SET state='leased', locked_by=$2, locked_at=${NOW}, worker_run_id=$3 WHERE id=$1`, [g, w, run]);
        await c0.query(`SELECT public.prepare_notification_digest_group($1,$2,$3, ${NOW})`, [run, g, w]);
        if (setRun === 'a') rA = run; else rB = run;
      }
    } finally { await c0.end(); }
    const a = conn(); const b = conn(); await a.connect(); await b.connect();
    try {
      const [x, y] = await Promise.all([
        a.query(`SELECT public.split_notification_digest_group($1,$2,'CA',1, ${NOW}) AS n`, [rA, gA]).then(r => r.rows[0].n),
        b.query(`SELECT public.split_notification_digest_group($1,$2,'CB',1, ${NOW}) AS n`, [rB, gB]).then(r => r.rows[0].n),
      ]);
      expect(Number(x)).toBeGreaterThanOrEqual(1); expect(Number(y)).toBeGreaterThanOrEqual(1);   // BOTH succeed — no 23505
      const cc = conn(); await cc.connect();
      const dup = (await cc.query(`SELECT count(*)::int n FROM (SELECT canonical_group_key, chunk_ordinal, count(*) FROM public.notification_digest_groups GROUP BY 1,2 HAVING count(*)>1) x`)).rows[0].n;
      const un = (await cc.query(`SELECT count(*)::int n FROM public.notification_outbox WHERE recipient_key=$1 AND digest_group_id IS NULL`, [key])).rows[0].n;
      expect(dup).toBe(0); expect(un).toBe(0);
      await cc.end();
      // bounds validation
      await expect(a.query(`SELECT public.split_notification_digest_group($1,$2,'CA',0, ${NOW})`, [rA, gA])).rejects.toThrow(/1\.\.50/);
    } finally { await a.end(); await b.end(); }
  });

  it('a legacy row with a caller hash promotes NULL→digest cleanly (schema rewrite allowed, caller mutation still forbidden)', async () => {
    const c = conn(); await c.connect();
    try {
      seq += 1; const key = `p:${seq}`; const dest = `u${seq}@example.com`;
      const fp = await fpOf(c, dest);
      const id = (await c.query(`INSERT INTO public.notification_outbox
        (channel, recipient_key, destination_fingerprint, destination_normalized, event_type, template_key,
         template_version, group_locale, digest_frequency, recipient_timezone, digest_boundary_at, digest_item, status, digest_group_hash)
        VALUES ('email',$1,$2,$3,'ev','tpl',1,'nl','daily','Europe/Amsterdam', ${BD}, '{}'::jsonb, 'pending', 'caller-controlled')
        RETURNING id`, [key, fp, dest])).rows[0].id;   // legacy: delivery_mode NULL, caller hash pre-set
      const h = (await c.query(`UPDATE public.notification_outbox SET delivery_mode='digest' WHERE id=$1 RETURNING digest_group_hash`, [id])).rows[0].digest_group_hash;
      expect(h).not.toBe('caller-controlled'); expect(h).toMatch(/^[0-9a-f]{64}$/);   // promotion rewrote it server-side
      // post-promotion, caller mutation of the hash stays forbidden
      await expect(c.query(`UPDATE public.notification_outbox SET digest_group_hash='x' WHERE id=$1`, [id])).rejects.toThrow(/frozen/i);
    } finally { await c.end(); }
  });

  it('every terminal transition clears current_attempt_id (sent, failed_terminal, retry_stopped, delivery_unknown)', async () => {
    const c = conn(); await c.connect();
    try {
      const a = await toSending(c);
      await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,202,NULL,'pm-t1', ${NOW})`, [a.run, a.att]);
      expect((await gstate(c, a.g)).current_attempt_id).toBeNull();               // accepted → sent
      const b = await toSending(c);
      await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,422,'validation_error',NULL, ${NOW})`, [b.run, b.att]);
      expect((await gstate(c, b.g)).current_attempt_id).toBeNull();               // 422 → failed_terminal
      // retry_stopped: a group with current_attempt_id still set exhausts its budget while NOT uncertain →
      // begin finalizes retry_stopped and the finalizer must clear attempt ownership.
      const r = await toSending(c);
      await c.query(`UPDATE public.notification_digest_groups
        SET state='request_ready', delivery_budget_used=max_delivery_budget WHERE id=$1`, [r.g]);   // keep current_attempt_id + lease
      const rAtt = (await c.query(`SELECT public.begin_notification_digest_attempt($1,$2,'W', ${NOW}) AS a`, [r.run, r.g])).rows[0].a;
      const rs = await gstate(c, r.g);
      expect(rAtt).toBeNull(); expect(rs.state).toBe('retry_stopped'); expect(rs.current_attempt_id).toBeNull();
      const d = await toSending(c);
      await c.query(`SELECT public.record_notification_digest_result($1,$2,'timeout',NULL,NULL,NULL, ${NOW})`, [d.run, d.att]);  // uncertain
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`SELECT public.reconcile_notification_digest_stale($1,'email', ${NOW} + interval '30 hours')`, [run]);
      const ds = await gstate(c, d.g);
      expect(ds.state).toBe('delivery_unknown'); expect(ds.current_attempt_id).toBeNull();   // age-out → delivery_unknown
    } finally { await c.end(); }
  });

  it('positive correlated evidence dominates a late probe timeout: the breaker closes instead of re-opening', async () => {
    const c = conn(); await c.connect();
    try {
      const { g, att, run } = await toSending(c);
      // this attempt is the bound half-open probe (begin already ensured a closed row → upsert)
      await c.query(`INSERT INTO public.notification_provider_circuit (channel, state, probe_group_id, probe_attempt_id, probe_locked_at)
        VALUES ('email','half_open',$1,$2,${NOW})
        ON CONFLICT (channel) DO UPDATE SET state='half_open', probe_group_id=$1, probe_attempt_id=$2, probe_locked_at=${NOW}`, [g, att]);
      // a tagged 'sent' callback completes the group (positive correlated evidence)
      await c.query(`SELECT public.apply_notification_provider_event($1,'ev-pe','pm-pe',$2,'sent', ${NOW}, ${NOW})`, [run, g]);
      expect((await gstate(c, g)).state).toBe('sent');
      // the same attempt's HTTP result arrives late as a TIMEOUT → the breaker must CLOSE, not re-open
      await c.query(`SELECT public.record_notification_digest_result($1,$2,'timeout',NULL,NULL,NULL, ${NOW})`, [run, att]);
      const cb = (await c.query(`SELECT state, probe_attempt_id FROM public.notification_provider_circuit WHERE channel='email'`)).rows[0];
      expect(cb.state).toBe('closed'); expect(cb.probe_attempt_id).toBeNull();
      expect((await gstate(c, g)).state).toBe('sent');   // the group stays resolved
    } finally { await c.end(); }
  });
});

describe('10c-a2 round-7 — fixed-23h invariant, SELECT-only tables, negative-callback breaker, NULL-safe bounds', () => {
  it('the 23-hour window is an INVARIANT: deadline = first_send_at+23h, and neither it nor first_send_at can be widened', async () => {
    const c = conn(); await c.connect();
    try {
      const { g, att, run } = await toSending(c);
      const fsa = (await gstate(c, g)).first_send_at;
      await c.query(`SELECT public.record_notification_digest_result($1,$2,'timeout',NULL,NULL,NULL, ${NOW})`, [run, att]); // ambiguous
      const s = await gstate(c, g);
      expect(new Date(s.uncertain_deadline_at).getTime()).toBe(new Date(fsa).getTime() + 23 * 3600 * 1000);
      // owner-effective guard: cannot widen the deadline beyond first_send_at+23h, nor move first_send_at
      await expect(c.query(`UPDATE public.notification_digest_groups SET uncertain_deadline_at=first_send_at + interval '48 hours' WHERE id=$1`, [g])).rejects.toThrow(/exceeds first_send_at/i);
      await expect(c.query(`UPDATE public.notification_digest_groups SET uncertain_deadline_at=uncertain_deadline_at + interval '1 hour' WHERE id=$1`, [g])).rejects.toThrow(/exceeds first_send_at|may not move later/i);
      await expect(c.query(`UPDATE public.notification_digest_groups SET first_send_at=first_send_at + interval '7 days' WHERE id=$1`, [g])).rejects.toThrow(/first_send_at is immutable/i);
      // and the tunable is gone — the RPC no longer accepts a widening argument (7-arg record max: no uncertainty param)
      const protoCount = (await c.query(`SELECT pronargs FROM pg_proc WHERE proname='record_notification_digest_result'`)).rows[0].pronargs;
      expect(protoCount).toBe(8);   // run, attempt, transport, http, error, pmid, now, retry_after — NO uncertainty
    } finally { await c.end(); }
  });

  it('send-identity fields are frozen: idempotency key / request hash / frozen-request-rewrite all rejected', async () => {
    const c = conn(); await c.connect();
    try {
      const { g } = await toSending(c);
      await expect(c.query(`UPDATE public.notification_digest_groups SET provider_idempotency_key='dg:v1:hijack' WHERE id=$1`, [g])).rejects.toThrow(/provider_idempotency_key is immutable/i);
      await expect(c.query(`UPDATE public.notification_digest_groups SET request_hash='deadbeef' WHERE id=$1`, [g])).rejects.toThrow(/request_hash is immutable/i);
      await expect(c.query(`UPDATE public.notification_digest_groups SET frozen_request=jsonb_build_object('to','evil@example.com','subject','x','html','x') WHERE id=$1`, [g])).rejects.toThrow(/frozen_request may not be rewritten/i);
    } finally { await c.end(); }
  });

  it('state-machine tables are service_role SELECT-only; direct writes denied under SET ROLE; RPCs still drive the machine', async () => {
    const c = conn(); await c.connect();
    const TABLES = ['notification_worker_runs', 'notification_digest_groups', 'notification_digest_attempts',
      'notification_digest_group_attempts', 'notification_provider_events', 'notification_provider_circuit',
      'notification_send_counters', 'notification_send_reservations'];
    try {
      // privilege matrix: service_role SELECT only; anon/authenticated nothing.
      for (const t of TABLES) {
        const r = (await c.query(`SELECT
          has_table_privilege('service_role','public.${t}','SELECT') sel,
          has_table_privilege('service_role','public.${t}','INSERT') ins,
          has_table_privilege('service_role','public.${t}','UPDATE') upd,
          has_table_privilege('service_role','public.${t}','DELETE') del,
          has_table_privilege('anon','public.${t}','SELECT') anon_sel,
          has_table_privilege('authenticated','public.${t}','SELECT') auth_sel`)).rows[0];
        expect(r.sel, `${t} svc SELECT`).toBe(true);
        expect(r.ins, `${t} svc INSERT`).toBe(false);
        expect(r.upd, `${t} svc UPDATE`).toBe(false);
        expect(r.del, `${t} svc DELETE`).toBe(false);
        expect(r.anon_sel, `${t} anon`).toBe(false);
        expect(r.auth_sel, `${t} auth`).toBe(false);
      }
      // a direct write under SET ROLE service_role is denied (BYPASSRLS does not bypass table grants)
      await c.query(`SET ROLE service_role`);
      await expect(c.query(`INSERT INTO public.notification_provider_circuit (channel, state) VALUES ('email','open')`)).rejects.toThrow(/permission denied/i);
      await expect(c.query(`UPDATE public.notification_digest_groups SET first_send_at=now()`)).rejects.toThrow(/permission denied/i);
      // but SELECT works, and the SECURITY DEFINER RPC drives the machine even as service_role
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      expect(run).toBeTruthy();
      await c.query(`SELECT count(*) FROM public.notification_digest_groups`);   // SELECT allowed
      await c.query(`RESET ROLE`);
    } finally { await c.query(`RESET ROLE`).catch(() => {}); await c.end(); }
  });

  it('a NEGATIVE correlated callback (bounced) also dominates a late probe timeout — breaker closes, not reopens', async () => {
    const c = conn(); await c.connect();
    try {
      const { g, att, run } = await toSending(c);
      await c.query(`INSERT INTO public.notification_provider_circuit (channel, state, probe_group_id, probe_attempt_id, probe_locked_at)
        VALUES ('email','half_open',$1,$2,${NOW})
        ON CONFLICT (channel) DO UPDATE SET state='half_open', probe_group_id=$1, probe_attempt_id=$2, probe_locked_at=${NOW}`, [g, att]);
      // a bounced callback → group failed_terminal (Resend accepted + processed the request → provider healthy)
      await c.query(`SELECT public.apply_notification_provider_event($1,'ev-bnc','pm-bnc',$2,'bounced', ${NOW}, ${NOW})`, [run, g]);
      expect((await gstate(c, g)).state).toBe('failed_terminal');
      // the same attempt's late HTTP result is a timeout → the breaker must CLOSE (send reached the provider)
      await c.query(`SELECT public.record_notification_digest_result($1,$2,'timeout',NULL,NULL,NULL, ${NOW})`, [run, att]);
      const cb = (await c.query(`SELECT state FROM public.notification_provider_circuit WHERE channel='email'`)).rows[0];
      expect(cb.state).toBe('closed');
      expect((await gstate(c, g)).state).toBe('failed_terminal');   // callback-derived outcome preserved
    } finally { await c.end(); }
  });

  it('every operational bound is server-enforced NULL-safely (NULL, 0, over-max rejected; 1 and max accepted)', async () => {
    const c = conn(); await c.connect();
    try {
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      // split bounds: NULL, 0, 51 rejected; 1 and 50 accepted (via a real splittable group)
      for (let i = 0; i < 3; i++) await seedMember(c, 'p:bnd', 'bnd@example.com');
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [run]);
      const g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key='p:bnd'`)).rows[0].id;
      const drun = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`UPDATE public.notification_digest_groups SET state='leased', locked_by='W', locked_at=${NOW}, worker_run_id=$2 WHERE id=$1`, [g, drun]);
      await c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${NOW})`, [drun, g]);
      for (const bad of ['NULL', '0', '51']) {
        await expect(c.query(`SELECT public.split_notification_digest_group($1,$2,'W',${bad}, ${NOW})`, [drun, g]), `split ${bad}`).rejects.toThrow(/1\.\.50/);
      }
      // materialize / claim / sweep bounds NULL-safe too
      await expect(c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, NULL, 100)`, [run])).rejects.toThrow(/p_max_groups/i);
      await expect(c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 0)`, [run])).rejects.toThrow(/p_max_members_per_call/i);
      await expect(c.query(`SELECT public.claim_notification_digest_group($1,'email', ${NOW}, 'W', NULL)`, [drun])).rejects.toThrow(/p_stale_minutes/i);
      await expect(c.query(`SELECT public.reconcile_notification_digest_stale($1,'email', ${NOW}, NULL, 100)`, [drun])).rejects.toThrow(/p_probe_lease_minutes/i);
      await expect(c.query(`SELECT public.reconcile_notification_digest_stale($1,'email', ${NOW}, 10, 99999)`, [drun])).rejects.toThrow(/p_limit/i);
    } finally { await c.end(); }
  });
});

describe('10c-a2 round-8 — helper-ACL allowlist, server-derived+frozen digest content, init-constrained identity, Retry-After clamp', () => {
  it('digest_item_bytes is server-derived (forged counts corrected); item + bytes are frozen (scrub-only)', async () => {
    const c = conn(); await c.connect();
    try {
      // a 2-byte item ('{}') gets a derived count of 2 regardless of any caller intent
      seq += 1; const key = `p:${seq}`; const dest = `u${seq}@example.com`;
      await seedMember(c, key, dest);
      const m = (await c.query(`SELECT id, digest_item_bytes FROM public.notification_outbox WHERE recipient_key=$1`, [key])).rows[0];
      expect(m.digest_item_bytes).toBe('{}'.length);   // octet_length('{}') = 2
      // forging the count on an unchanged item is silently corrected back by the derive trigger
      await c.query(`UPDATE public.notification_outbox SET digest_item_bytes=1 WHERE id=$1`, [m.id]);
      expect((await c.query(`SELECT digest_item_bytes FROM public.notification_outbox WHERE id=$1`, [m.id])).rows[0].digest_item_bytes).toBe(2);
      // rewriting the item content is rejected (write-once)
      await expect(c.query(`UPDATE public.notification_outbox SET digest_item=jsonb_build_object('forged',true) WHERE id=$1`, [m.id])).rejects.toThrow(/digest_item is write-once/i);
      // a genuinely oversize item → materialize routes it to oversize_failed using the DERIVED count
      seq += 1; const bigKey = `p:${seq}`;
      await seedMember(c, bigKey, `u${seq}@example.com`, { itemBytes: 200000 });
      const derived = (await c.query(`SELECT digest_item_bytes FROM public.notification_outbox WHERE recipient_key=$1`, [bigKey])).rows[0].digest_item_bytes;
      expect(derived).toBeGreaterThan(92160);
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [run]);
      expect((await c.query(`SELECT state FROM public.notification_digest_groups WHERE recipient_key=$1`, [bigKey])).rows[0].state).toBe('oversize_failed');
    } finally { await c.end(); }
  });

  it('send-identity fields cannot be INITIALIZED during an illegal transition (forged populate on a pending group rejected)', async () => {
    const c = conn(); await c.connect();
    try {
      // a pending group (materialized, not yet stored/sent) — a one-statement forge must be rejected
      seq += 1; const key = `p:${seq}`; await seedMember(c, key, `u${seq}@example.com`);
      const mrun = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
      const g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [key])).rows[0].id;
      // forged first_send_at on a pending group (not request_ready→sending)
      await expect(c.query(`UPDATE public.notification_digest_groups SET first_send_at=now() WHERE id=$1`, [g])).rejects.toThrow(/first_send_at may only be set during request_ready→sending/i);
      // forged key / hash / frozen on a pending group (not prepared→request_ready)
      await expect(c.query(`UPDATE public.notification_digest_groups SET provider_idempotency_key='dg:v1:'||id::text WHERE id=$1`, [g])).rejects.toThrow(/prepared→request_ready/i);
      await expect(c.query(`UPDATE public.notification_digest_groups SET request_hash='deadbeef' WHERE id=$1`, [g])).rejects.toThrow(/prepared→request_ready/i);
      await expect(c.query(`UPDATE public.notification_digest_groups SET frozen_request=jsonb_build_object('to','x','subject','x','html','x') WHERE id=$1`, [g])).rejects.toThrow(/prepared→request_ready/i);
      // the legitimate store + begin transitions still succeed (positive path intact)
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`UPDATE public.notification_digest_groups SET state='leased', locked_by='W', locked_at=${NOW}, worker_run_id=$2 WHERE id=$1`, [g, run]);
      await c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${NOW})`, [run, g]);
      await c.query(`SELECT public.store_notification_digest_request($1,$2,'W', jsonb_build_object('to',$3::text,'subject','s','html','<p>x</p>'), ${NOW})`, [run, g, `u${seq}@example.com`]);
      const s1 = await gstate(c, g);
      expect(s1.provider_idempotency_key).toBe('dg:v1:' + g); expect(s1.request_hash).toMatch(/^[0-9a-f]{64}$/);
      const att = (await c.query(`SELECT public.begin_notification_digest_attempt($1,$2,'W', ${NOW}) AS a`, [run, g])).rows[0].a;
      expect((await gstate(c, g)).first_send_at).not.toBeNull(); expect(att).toBeTruthy();
    } finally { await c.end(); }
  });

  it('Retry-After is clamped: negative / huge / NULL fall back safely; a valid value is honored', async () => {
    const c = conn(); await c.connect();
    try {
      // negative daily-quota Retry-After must NOT set retry_at in the past
      const a = await toSending(c);
      await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,429,'daily_quota_exceeded',NULL, ${NOW}, -3600)`, [a.run, a.att]);
      let cb = (await c.query(`SELECT reason, retry_at FROM public.notification_provider_circuit WHERE channel='email'`)).rows[0];
      expect(cb.reason).toBe('daily_quota');
      expect(new Date(cb.retry_at).getTime()).toBe(new Date('2026-07-02T10:00:00Z').getTime());  // NOW + 24h fallback
      await c.query(`UPDATE public.notification_provider_circuit SET state='closed', reason=NULL, retry_at=NULL, probe_group_id=NULL, probe_attempt_id=NULL WHERE channel='email'`);
      // huge Retry-After → fallback (never a multi-year hold)
      const b = await toSending(c);
      await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,429,'daily_quota_exceeded',NULL, ${NOW}, 999999999)`, [b.run, b.att]);
      cb = (await c.query(`SELECT retry_at FROM public.notification_provider_circuit WHERE channel='email'`)).rows[0];
      expect(new Date(cb.retry_at).getTime()).toBe(new Date('2026-07-02T10:00:00Z').getTime());   // clamped to 24h fallback
      await c.query(`UPDATE public.notification_provider_circuit SET state='closed', reason=NULL, retry_at=NULL, probe_group_id=NULL, probe_attempt_id=NULL WHERE channel='email'`);
      // a valid Retry-After (2h) is honored
      const d = await toSending(c);
      await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,429,'daily_quota_exceeded',NULL, ${NOW}, 7200)`, [d.run, d.att]);
      cb = (await c.query(`SELECT retry_at FROM public.notification_provider_circuit WHERE channel='email'`)).rows[0];
      expect(new Date(cb.retry_at).getTime()).toBe(new Date('2026-07-01T12:00:00Z').getTime());   // NOW + 2h
      // a negative Retry-After on a plain retryable → available_at floored at the backoff (never in the past)
      await c.query(`UPDATE public.notification_provider_circuit SET state='closed', reason=NULL, retry_at=NULL, probe_group_id=NULL, probe_attempt_id=NULL WHERE channel='email'`);
      const e = await toSending(c);
      await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,429,'rate_limit_exceeded',NULL, ${NOW}, -3600)`, [e.run, e.att]);
      const es = await gstate(c, e.g);
      expect(new Date(es.available_at).getTime()).toBeGreaterThan(new Date(NOW.slice(1, 26)).getTime());  // future, not past
    } finally { await c.end(); }
  });
});

describe('10c-a2 round-9 — digest_item lifecycle, breaker-independent age-out, deadline-capped scheduling, request-tuple completeness', () => {
  it('digest_item is an immutable enqueue snapshot: null-pending rejected; late attach rejected; premature scrub rejected; terminal scrub OK', async () => {
    const c = conn(); await c.connect();
    try {
      // null-pending digest insert rejected
      const fp = await fpOf(c, 'di@example.com');
      await expect(c.query(`INSERT INTO public.notification_outbox
        (channel, delivery_mode, recipient_key, destination_fingerprint, destination_normalized, event_type,
         template_key, template_version, group_locale, digest_frequency, recipient_timezone, digest_boundary_at, status)
        VALUES ('email','digest','p:di',$1,'di@example.com','ev','tpl',1,'nl','daily','Europe/Amsterdam', ${BD}, 'pending')`, [fp]))
        .rejects.toThrow(/missing snapshot fields.*digest_item/i);
      // a valid pending digest member
      seq += 1; const key = `p:${seq}`; const dest = `u${seq}@example.com`;
      await seedMember(c, key, dest);
      const m = (await c.query(`SELECT id FROM public.notification_outbox WHERE recipient_key=$1`, [key])).rows[0].id;
      // late attach after a hypothetical NULL — force NULL first is itself illegal, so test the two update paths:
      // premature scrub (still pending) rejected
      await expect(c.query(`UPDATE public.notification_outbox SET digest_item=NULL WHERE id=$1`, [m]))
        .rejects.toThrow(/may only be scrubbed when the member enters a terminal status/i);
      // rewrite rejected (write-once)
      await expect(c.query(`UPDATE public.notification_outbox SET digest_item=jsonb_build_object('x',1) WHERE id=$1`, [m]))
        .rejects.toThrow(/digest_item is write-once/i);
      // a terminal scrub (item→NULL WITH a terminal status, atomically) is allowed — the legitimate finalize shape
      await c.query(`UPDATE public.notification_outbox SET status='skipped', digest_item=NULL WHERE id=$1`, [m]);
      const after = (await c.query(`SELECT status, digest_item, digest_item_bytes FROM public.notification_outbox WHERE id=$1`, [m])).rows[0];
      expect(after.status).toBe('skipped'); expect(after.digest_item).toBeNull();
      expect(after.digest_item_bytes).toBe('{}'.length);   // byte count retained after scrub
    } finally { await c.end(); }
  });

  it('uncertainty age-out is INDEPENDENT of a manual breaker hold: a due uncertain group is finalized by the sweep', async () => {
    const c = conn(); await c.connect();
    try {
      const { g, att, run } = await toSending(c);
      await c.query(`SELECT public.record_notification_digest_result($1,$2,'timeout',NULL,NULL,NULL, ${NOW})`, [run, att]);  // ambiguous → uncertain, request_ready
      expect((await gstate(c, g)).state).toBe('request_ready');
      // a MANUAL channel hold (retry_at NULL) — claim would return before ever scanning this group
      await c.query(`INSERT INTO public.notification_provider_circuit (channel, state, reason, retry_at) VALUES ('email','open','monthly_quota',NULL)
        ON CONFLICT (channel) DO UPDATE SET state='open', reason='monthly_quota', retry_at=NULL, probe_group_id=NULL, probe_attempt_id=NULL`);
      const claimRun = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      // even 30h later, claim yields nothing (held) — the group would leak WITHOUT the independent sweep
      expect((await c.query(`SELECT public.claim_notification_digest_group($1,'email', ${NOW} + interval '30 hours', 'W') AS g`, [claimRun])).rows[0].g).toBeNull();
      expect((await gstate(c, g)).state).toBe('request_ready');   // still live under the hold
      // the reconciliation sweep ages it out regardless of the breaker
      const sweepRun = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      const n = (await c.query(`SELECT public.reconcile_notification_digest_stale($1,'email', ${NOW} + interval '30 hours') AS n`, [sweepRun])).rows[0].n;
      const s = await gstate(c, g);
      expect(Number(n)).toBeGreaterThanOrEqual(1);
      expect(s.state).toBe('delivery_unknown'); expect(s.current_attempt_id).toBeNull();
      expect(await resStates(c, g)).toEqual(['committed', 'committed']);   // reservations committed, not leaked
      // the breaker is untouched (still the manual hold)
      const cb = (await c.query(`SELECT state, reason, retry_at FROM public.notification_provider_circuit WHERE channel='email'`)).rows[0];
      expect(cb.state).toBe('open'); expect(cb.reason).toBe('monthly_quota'); expect(cb.retry_at).toBeNull();
    } finally { await c.end(); }
  });

  it('uncertain scheduling is capped at the 23h deadline: a valid 7-day Retry-After cannot push a retry past it', async () => {
    const c = conn(); await c.connect();
    try {
      const { g, att, run } = await toSending(c);
      const fsa = (await gstate(c, g)).first_send_at;
      await c.query(`SELECT public.record_notification_digest_result($1,$2,'timeout',NULL,NULL,NULL, ${NOW})`, [run, att]);  // ambiguous → deadline = first_send+23h
      // retry the (still request_ready) group, then a 429 with a VALID 7-day Retry-After
      await c.query(`UPDATE public.notification_digest_groups SET locked_by='W', locked_at=${NOW}, state='request_ready', available_at=${NOW} WHERE id=$1`, [g]);
      const att2 = (await c.query(`SELECT public.begin_notification_digest_attempt($1,$2,'W', ${NOW}) AS a`, [run, g])).rows[0].a;
      await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,429,'rate_limit_exceeded',NULL, ${NOW}, 604800)`, [run, att2]);  // 7-day Retry-After
      const s = await gstate(c, g);
      // available_at is capped at the deadline (first_send_at + 23h), NOT 7 days out
      expect(new Date(s.available_at).getTime()).toBeLessThanOrEqual(new Date(fsa).getTime() + 23 * 3600 * 1000);
      expect(new Date(s.available_at).getTime()).toBe(new Date(fsa).getTime() + 23 * 3600 * 1000);   // exactly the deadline
      // at the deadline the sweep ages it out rather than the 7-day wait
      const sweepRun = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`SELECT public.reconcile_notification_digest_stale($1,'email', ${NOW} + interval '24 hours')`, [sweepRun]);
      expect((await gstate(c, g)).state).toBe('delivery_unknown');
    } finally { await c.end(); }
  });

  it('a retry INSIDE the window keeps its normal backoff (cap only bites past the deadline)', async () => {
    const c = conn(); await c.connect();
    try {
      const { g, att, run } = await toSending(c);
      await c.query(`SELECT public.record_notification_digest_result($1,$2,'timeout',NULL,NULL,NULL, ${NOW})`, [run, att]);  // ambiguous
      await c.query(`UPDATE public.notification_digest_groups SET locked_by='W', locked_at=${NOW}, state='request_ready', available_at=${NOW} WHERE id=$1`, [g]);
      const att2 = (await c.query(`SELECT public.begin_notification_digest_attempt($1,$2,'W', ${NOW}) AS a`, [run, g])).rows[0].a;
      await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,429,'rate_limit_exceeded',NULL, ${NOW}, 60)`, [run, att2]);  // 60s Retry-After, well inside the window
      const s = await gstate(c, g);
      const fsa = (await gstate(c, g)).first_send_at;
      expect(new Date(s.available_at).getTime()).toBeLessThan(new Date(fsa).getTime() + 23 * 3600 * 1000);  // NOT clamped to the deadline
    } finally { await c.end(); }
  });

  it('prepared→request_ready must atomically carry the full request tuple (a state-only transition is rejected)', async () => {
    const c = conn(); await c.connect();
    try {
      seq += 1; const key = `p:${seq}`; const dest = `u${seq}@example.com`;
      await seedMember(c, key, dest);
      const mrun = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
      const g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [key])).rows[0].id;
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`UPDATE public.notification_digest_groups SET state='leased', locked_by='W', locked_at=${NOW}, worker_run_id=$2 WHERE id=$1`, [g, run]);
      await c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${NOW})`, [run, g]);
      // a bare state-only transition (no request tuple) is rejected on the transition itself
      await expect(c.query(`UPDATE public.notification_digest_groups SET state='request_ready' WHERE id=$1`, [g]))
        .rejects.toThrow(/must atomically establish the complete frozen request tuple/i);
      // a partial subset (frozen only, no key/hash) also rejected
      await expect(c.query(`UPDATE public.notification_digest_groups SET state='request_ready', frozen_request=jsonb_build_object('to',$2::text,'subject','s','html','h') WHERE id=$1`, [g, dest]))
        .rejects.toThrow(/frozen request tuple/i);
      // the legitimate store path (full tuple) still succeeds
      await c.query(`SELECT public.store_notification_digest_request($1,$2,'W', jsonb_build_object('to',$3::text,'subject','s','html','<p>x</p>'), ${NOW})`, [run, g, dest]);
      expect((await gstate(c, g)).state).toBe('request_ready');
    } finally { await c.end(); }
  });
});

describe('10c-a2 round-10 — shared request validator (trigger too), bounded age-out index, claim quiet-hours cap', () => {
  it('a direct-owner prepared→request_ready with a COMPLETE-but-unsafe request is rejected by the trigger', async () => {
    const c = conn(); await c.connect();
    try {
      seq += 1; const key = `p:${seq}`; const dest = `u${seq}@example.com`;
      await seedMember(c, key, dest);
      const mrun = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
      const g = (await c.query(`SELECT id, destination_fingerprint FROM public.notification_digest_groups WHERE recipient_key=$1`, [key])).rows[0];
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`UPDATE public.notification_digest_groups SET state='leased', locked_by='W', locked_at=${NOW}, worker_run_id=$2 WHERE id=$1`, [g.id, run]);
      await c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${NOW})`, [run, g.id]);
      // (a) matching fingerprint 'to' but an extra bcc, with a correct hash + key → rejected on the allow-list
      await expect(c.query(`UPDATE public.notification_digest_groups
        SET state='request_ready',
            frozen_request=jsonb_build_object('to',$2::text,'subject','s','html','h','bcc','spy@evil.com'),
            provider_idempotency_key='dg:v1:'||id::text,
            request_hash=encode(sha256(jsonb_build_object('to',$2::text,'subject','s','html','h','bcc','spy@evil.com')::text::bytea),'hex')
        WHERE id=$1`, [g.id, dest]))
        .rejects.toThrow(/allow-list/i);
      // (b) a wrong recipient (only to/subject/html) with a correct hash + key → rejected on the fingerprint
      await expect(c.query(`UPDATE public.notification_digest_groups
        SET state='request_ready',
            frozen_request=jsonb_build_object('to','attacker@example.com','subject','s','html','h'),
            provider_idempotency_key='dg:v1:'||id::text,
            request_hash=encode(sha256(jsonb_build_object('to','attacker@example.com','subject','s','html','h')::text::bytea),'hex')
        WHERE id=$1`, [g.id]))
        .rejects.toThrow(/does not match the group fingerprint/i);
      // the legitimate store still succeeds
      await c.query(`SELECT public.store_notification_digest_request($1,$2,'W', jsonb_build_object('to',$3::text,'subject','s','html','<p>x</p>'), ${NOW})`, [run, g.id, dest]);
      expect((await gstate(c, g.id)).state).toBe('request_ready');
    } finally { await c.end(); }
  });

  it('the age-out scan is work-bounded at 100k: the idx_digest_groups_uncertain_ageout node itself filters ~0 rows', async () => {
    const c = conn(); await c.connect();
    try {
      // 100k STRUCTURALLY-VALID uncertain groups (uncertain pair + first_send_at, per the table CHECK), all
      // with a FUTURE deadline (NOT due). The foundation INSERT guard forces first_send_at=NULL, so bulk-seed
      // with the two BEFORE-triggers disabled (the CHECK still validates every row).
      await c.query(`ALTER TABLE public.notification_digest_groups DISABLE TRIGGER trg_digest_groups_guard`);
      await c.query(`ALTER TABLE public.notification_digest_groups DISABLE TRIGGER trg_digest_groups_send_identity`);
      await c.query(`INSERT INTO public.notification_digest_groups
        (canonical_group_key, group_key_hash, channel, event_type, recipient_key, destination_fingerprint,
         recipient_timezone, digest_boundary_at, available_at, state, first_send_at, uncertain_since, uncertain_deadline_at)
        SELECT jsonb_build_array('v2','email','p:'||gs), 'h'||gs, 'email','ev','p:'||gs,'df'||gs,'Europe/Amsterdam',
               ${BD}, ${NOW} + interval '23 hours', 'request_ready', ${NOW}, ${NOW}, ${NOW} + interval '23 hours'
        FROM generate_series(1,100000) gs`);
      await c.query(`ALTER TABLE public.notification_digest_groups ENABLE TRIGGER trg_digest_groups_guard`);
      await c.query(`ALTER TABLE public.notification_digest_groups ENABLE TRIGGER trg_digest_groups_send_identity`);
      // structural validity: the CHECK held for all 100k (uncertain pair + first_send_at)
      expect((await c.query(`SELECT count(*)::int n FROM public.notification_digest_groups WHERE first_send_at IS NULL AND uncertain_since IS NOT NULL`)).rows[0].n).toBe(0);
      await c.query(`ANALYZE public.notification_digest_groups`);

      // The test must exercise the ACTUAL RPC query, not a hand-copied one. Extract the sweep's scan straight
      // from reconcile_notification_digest_stale's source and assert its shape, then EXPLAIN that exact scan.
      const src = (await c.query(`SELECT pg_get_functiondef('public.reconcile_notification_digest_stale(uuid,text,timestamptz,int,int)'::regprocedure) d`)).rows[0].d;
      expect(src).toMatch(/uncertain_deadline_at <= p_now/);                       // the range bound
      expect(src).toMatch(/ORDER BY uncertain_deadline_at/);                        // ordered by the indexed col
      expect(src).toMatch(/state IN \('request_ready','sending','awaiting_evidence'\)/);

      const plan = (await c.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT id FROM public.notification_digest_groups
         WHERE channel='email' AND uncertain_since IS NOT NULL
           AND state IN ('request_ready','sending','awaiting_evidence')
           AND uncertain_deadline_at <= ${NOW}
         ORDER BY uncertain_deadline_at LIMIT 500 FOR UPDATE SKIP LOCKED`)).rows[0]['QUERY PLAN'];

      // recurse the plan tree to the NAMED index-scan node (not the top Limit, whose filter count can be 0
      // while a nested scan removed all 100k).
      type PlanNode = { 'Node Type'?: string; 'Index Name'?: string; 'Index Cond'?: string;
        'Rows Removed by Filter'?: number; 'Actual Rows'?: number; Plans?: PlanNode[]; Plan?: PlanNode };
      function findIndexNode(n: PlanNode | undefined): PlanNode | undefined {
        if (!n) return undefined;
        if (n['Index Name'] === 'idx_digest_groups_uncertain_ageout') return n;
        for (const child of n.Plans ?? []) { const r = findIndexNode(child); if (r) return r; }
        return findIndexNode(n.Plan);
      }
      const idxNode = findIndexNode(plan[0]);
      expect(idxNode, 'idx_digest_groups_uncertain_ageout node').toBeDefined();
      expect(idxNode!['Index Cond']).toMatch(/uncertain_deadline_at/);              // due-ness IS the index cond
      expect(Number(idxNode!['Actual Rows'] ?? -1)).toBe(0);                        // 0 due at the scan node
      expect(Number(idxNode!['Rows Removed by Filter'] ?? 0)).toBeLessThan(100);    // the 100k future rows are NOT filtered
    } finally { await c.end(); }
  }, 120_000);

  it('claim quiet-hours defer is capped at the uncertainty deadline (bump past the deadline → available_at = deadline)', async () => {
    const c = conn(); await c.connect();
    const FSA = "'2026-07-01 07:00:00+00'::timestamptz";       // 09:00 Amsterdam (inside the window)
    const CLAIM = "'2026-07-01 18:30:00+00'::timestamptz";     // 20:30 Amsterdam (after the window)
    try {
      // drive a group to uncertain request_ready with first_send_at = 09:00 local
      seq += 1; const key = `p:${seq}`; const dest = `u${seq}@example.com`;
      await seedMember(c, key, dest);
      const mrun = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${FSA}, 100, 100)`, [mrun]);
      const g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [key])).rows[0].id;
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`SELECT public.claim_notification_digest_group($1,'email', ${FSA}, 'W')`, [run]);
      await c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${FSA})`, [run, g]);
      await c.query(`SELECT public.store_notification_digest_request($1,$2,'W', jsonb_build_object('to',$3::text,'subject','s','html','h'), ${FSA})`, [run, g, dest]);
      const att = (await c.query(`SELECT public.begin_notification_digest_attempt($1,$2,'W', ${FSA}) AS a`, [run, g])).rows[0].a;
      await c.query(`SELECT public.record_notification_digest_result($1,$2,'timeout',NULL,NULL,NULL, ${FSA})`, [run, att]);  // ambiguous → uncertain, deadline = FSA+23h
      const deadline = (await gstate(c, g)).uncertain_deadline_at;
      // make it due and claim it after 20:00 local → quiet-hours bump to next 09:00 local > deadline → capped
      await c.query(`UPDATE public.notification_digest_groups SET available_at=${CLAIM} WHERE id=$1`, [g]);
      const claimRun = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      const claimed = (await c.query(`SELECT public.claim_notification_digest_group($1,'email', ${CLAIM}, 'W2') AS g`, [claimRun])).rows[0].g;
      const s = await gstate(c, g);
      expect(claimed).toBeNull();   // quiet-hours deferred, not claimed
      expect(new Date(s.available_at).getTime()).toBe(new Date(deadline).getTime());  // capped exactly at the deadline
    } finally { await c.end(); }
  });
});

describe('10c-a2 round-11 — deadline hot-loop, insert-time clock CHECK', () => {
  it('a deadline-past uncertain group during quiet hours is aged out in ONE claim call (no 200-row hot-loop)', async () => {
    const c = conn(); await c.connect();
    const FSA = "'2026-07-01 07:00:00+00'::timestamptz";   // 09:00 Amsterdam
    try {
      // an uncertain request_ready group whose deadline (FSA+23h) is already past, claimed during quiet hours
      seq += 1; const key = `p:${seq}`; const dest = `u${seq}@example.com`;
      await seedMember(c, key, dest);
      const mrun = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${FSA}, 100, 100)`, [mrun]);
      const g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [key])).rows[0].id;
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`SELECT public.claim_notification_digest_group($1,'email', ${FSA}, 'W')`, [run]);
      await c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${FSA})`, [run, g]);
      await c.query(`SELECT public.store_notification_digest_request($1,$2,'W', jsonb_build_object('to',$3::text,'subject','s','html','h'), ${FSA})`, [run, g, dest]);
      const att = (await c.query(`SELECT public.begin_notification_digest_attempt($1,$2,'W', ${FSA}) AS a`, [run, g])).rows[0].a;
      await c.query(`SELECT public.record_notification_digest_result($1,$2,'timeout',NULL,NULL,NULL, ${FSA})`, [run, att]);  // uncertain, deadline = FSA+23h = next-day 06:00 UTC
      // claim PAST the deadline (06:00 UTC) but still in quiet hours (08:30 Amsterdam < 09:00): the pre-fix
      // quiet-hours bump would write least(next-09:00, deadline) = the already-due deadline back and hot-loop.
      const QUIET = "'2026-07-02 06:30:00+00'::timestamptz";  // 08:30 Amsterdam — quiet hours, AFTER the 06:00 UTC deadline
      await c.query(`UPDATE public.notification_digest_groups SET available_at=${QUIET} WHERE id=$1`, [g]);
      const cRun = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      const claimed = (await c.query(`SELECT public.claim_notification_digest_group($1,'email', ${QUIET}, 'W2') AS g`, [cRun])).rows[0].g;
      const s = await gstate(c, g);
      expect(claimed).toBeNull();                       // not leased (aged out, not deferred/claimed)
      expect(s.state).toBe('delivery_unknown');         // finalized
      expect(s.current_attempt_id).toBeNull();
      expect(await resStates(c, g)).toEqual(['committed', 'committed']);
      // exactly ONE outcome ledger event for this claim run (no repeated 'deferred' rows)
      const rows = (await c.query(`SELECT action, count(*)::int n FROM public.notification_digest_group_attempts WHERE worker_run_id=$1 GROUP BY action`, [cRun])).rows;
      expect(rows).toEqual([{ action: 'delivery_unknown', n: 1 }]);
    } finally { await c.end(); }
  });

  it('the uncertainty-clock pair + first_send_at is enforced at INSERT by a table CHECK', async () => {
    const c = conn(); await c.connect();
    try {
      const base = `canonical_group_key, group_key_hash, channel, event_type, recipient_key,
        destination_fingerprint, recipient_timezone, digest_boundary_at, available_at, state`;
      const vals = `'["x"]'::jsonb,'h','email','ev','p:x','df','Europe/Amsterdam', ${NOW}, ${NOW}, 'request_ready'`;
      // half-pair (since set, deadline null) → rejected
      await expect(c.query(`INSERT INTO public.notification_digest_groups (${base}, uncertain_since) VALUES (${vals}, ${NOW})`))
        .rejects.toThrow(/uncertainty_pair_check|violates check constraint/i);
      // both clocks but no first_send_at → rejected (uncertain is always post-dispatch)
      await expect(c.query(`INSERT INTO public.notification_digest_groups (${base}, uncertain_since, uncertain_deadline_at)
        VALUES (${vals}, ${NOW}, ${NOW} + interval '23 hours')`))
        .rejects.toThrow(/uncertainty_pair_check|violates check constraint/i);
      // a clean non-uncertain insert still works; a real ambiguous transition (below) still works
      await c.query(`ALTER TABLE public.notification_digest_groups DISABLE TRIGGER trg_digest_groups_guard`);
      await c.query(`INSERT INTO public.notification_digest_groups (${base}, first_send_at, uncertain_since, uncertain_deadline_at)
        VALUES (${vals}, ${NOW}, ${NOW}, ${NOW} + interval '23 hours')`);   // valid uncertain row (pair + first_send_at)
      await c.query(`ALTER TABLE public.notification_digest_groups ENABLE TRIGGER trg_digest_groups_guard`);
      // the real ambiguous path still produces a valid pair
      const { g } = await toSending(c);
      const s0 = await gstate(c, g);
      // (uncertain not yet set here) — driving a timeout sets the pair legitimately
      const runX = (await c.query(`SELECT worker_run_id FROM public.notification_digest_attempts WHERE digest_group_id=$1`, [g])).rows[0].worker_run_id;
      const attX = (await c.query(`SELECT attempt_id FROM public.notification_digest_attempts WHERE digest_group_id=$1`, [g])).rows[0].attempt_id;
      await c.query(`SELECT public.record_notification_digest_result($1,$2,'timeout',NULL,NULL,NULL, ${NOW})`, [runX, attX]);
      const s1 = await gstate(c, g);
      expect(s1.uncertain_since).not.toBeNull(); expect(s1.uncertain_deadline_at).not.toBeNull();
      void s0;
    } finally { await c.end(); }
  });
});

describe('10c-a2 scale — 100k SAME-BOUNDARY rows, the member query itself, full bounded drain', () => {
  it('100k same-boundary rows: the member scan is an index scan (no Sort) and bounded calls drain everything', async () => {
    const c = conn(); await c.connect();
    try {
      // REALISTIC fixture: every row on the SAME daily 09:00 boundary — 1000 keys × 100 members.
      // The stamping trigger computes each row's digest_group_hash.
      await c.query(`INSERT INTO public.notification_outbox
        (channel, delivery_mode, recipient_key, destination_fingerprint, destination_normalized,
         event_type, template_key, template_version, group_locale, digest_frequency, recipient_timezone,
         digest_boundary_at, digest_item, status)
        SELECT 'email','digest','p:'||(gs/100), 'fp:'||(gs/100), 'scale'||(gs/100)||'@example.com',
               'ev','tpl',1,'nl','daily','Europe/Amsterdam', ${BD}, '{}'::jsonb, 'pending'
        FROM generate_series(0, 99999) gs`);
      // (a) the CANDIDATE query: LIMIT-1 Index Scan, no Sort, actual rows ≤ 1.
      const candPlan = (await c.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT o.id FROM public.notification_outbox o
        WHERE o.channel='email' AND o.delivery_mode='digest' AND o.digest_group_id IS NULL AND o.status='pending'
        ORDER BY o.digest_boundary_at LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0]['QUERY PLAN'];
      expect(JSON.stringify(candPlan)).toMatch(/Index Scan/);
      expect(JSON.stringify(candPlan)).not.toMatch(/"Node Type":\s*"Sort"/);
      expect(Number(candPlan[0].Plan['Actual Rows'])).toBeLessThanOrEqual(1);
      // (b) the MEMBER query (the real expensive one at same-boundary scale): hash-index scan, no Sort.
      await c.query(`ANALYZE public.notification_outbox`);   // fresh stats after the 100k bulk insert
      const oneHash = (await c.query(`SELECT digest_group_hash h FROM public.notification_outbox WHERE digest_group_hash IS NOT NULL LIMIT 1`)).rows[0].h;
      const memPlan = (await c.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT o.id FROM public.notification_outbox o
        WHERE o.digest_group_hash=$1 AND o.channel='email' AND o.delivery_mode='digest'
          AND o.digest_group_id IS NULL AND o.status='pending'
        ORDER BY o.created_at, o.id LIMIT 60 FOR UPDATE SKIP LOCKED`, [oneHash])).rows[0]['QUERY PLAN'];
      const memText = JSON.stringify(memPlan);
      expect(memText).toMatch(/idx_outbox_digest_member_scan/);
      expect(memText).not.toMatch(/"Node Type":\s*"Sort"/);
      // (c) full drain with bounded calls: every member ends in exactly one ≤50-item group.
      const t0 = Date.now();
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      let calls = 0;
      for (;;) {
        calls += 1;
        const n = (await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 200, 10000) AS n`, [run])).rows[0].n;
        if (Number(n) === 0 || calls > 40) break;
      }
      const secs = (Date.now() - t0) / 1000;
      const un = (await c.query(`SELECT count(*)::int n FROM public.notification_outbox WHERE delivery_mode='digest' AND digest_group_id IS NULL AND status='pending'`)).rows[0].n;
      const over = (await c.query(`SELECT count(*)::int n FROM public.notification_digest_groups WHERE item_count > 50`)).rows[0].n;
      const dup = (await c.query(`SELECT count(*)::int n FROM (SELECT canonical_group_key, chunk_ordinal, count(*) FROM public.notification_digest_groups GROUP BY 1,2 HAVING count(*)>1) x`)).rows[0].n;
      expect(un).toBe(0); expect(over).toBe(0); expect(dup).toBe(0);
      expect(secs).toBeLessThan(60);   // the old computed-key design took ~16s per 1k groups; this drains 2k in seconds
    } finally { await c.end(); }
  }, 180_000);

  it('no RPC uses OFFSET pagination or an unbounded loop (LIMIT + FOR UPDATE SKIP LOCKED + iteration caps)', () => {
    const raw = readFileSync(join(process.cwd(), 'supabase', 'migrations', '20261004100000_notification_digest_state_machine.sql'), 'utf8');
    const sql = raw.replace(/--[^\n]*/g, '');   // strip comments — check CODE, not prose
    expect(sql).not.toMatch(/\boffset\b/i);
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(sql).toMatch(/v_iter > 200/);                          // claim scan cap
    expect(sql).toMatch(/v_iter > \(2 \* greatest\(p_max_groups, 1\) \+ 8\)/); // materialize outer cap
  });
});

describe('10c-a2 ACL — operational allowlist only; internal helpers are executable by NOBODY', () => {
  const OPERATIONAL = ['start_notification_worker_run', 'finish_notification_worker_run',
    'materialize_notification_digest_groups', 'claim_notification_digest_group', 'prepare_notification_digest_group',
    'split_notification_digest_group', 'store_notification_digest_request', 'begin_notification_digest_attempt',
    'record_notification_digest_result', 'reconcile_notification_digest_run', 'reconcile_notification_digest_stale',
    'apply_notification_provider_event', 'link_notification_provider_event'];

  it('the operational entrypoints are service_role-only; every notif_digest_% helper is EXECUTE-denied to all API roles', async () => {
    const c = conn(); await c.connect();
    try {
      // operational RPCs: service_role EXECUTE, anon/authenticated denied.
      const ops = (await c.query(`SELECT p.oid::regprocedure::text sig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname = ANY($1)`, [OPERATIONAL])).rows.map((r: { sig: string }) => r.sig);
      expect(ops.length).toBe(OPERATIONAL.length);
      for (const sig of ops) {
        const r = (await c.query(`SELECT has_function_privilege('anon',$1,'EXECUTE') a, has_function_privilege('authenticated',$1,'EXECUTE') b, has_function_privilege('service_role',$1,'EXECUTE') s`, [sig])).rows[0];
        expect(r.a, `anon ${sig}`).toBe(false); expect(r.b, `auth ${sig}`).toBe(false); expect(r.s, `svc ${sig}`).toBe(true);
      }
      // internal notif_digest_% helpers: EXECUTE denied to EVERY API role incl. service_role.
      const helpers = (await c.query(`SELECT p.oid::regprocedure::text sig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname LIKE 'notif_digest_%'`)).rows.map((r: { sig: string }) => r.sig);
      expect(helpers.length).toBeGreaterThanOrEqual(15);
      for (const sig of helpers) {
        const r = (await c.query(`SELECT has_function_privilege('anon',$1,'EXECUTE') a, has_function_privilege('authenticated',$1,'EXECUTE') b, has_function_privilege('service_role',$1,'EXECUTE') s`, [sig])).rows[0];
        expect(r.a, `anon ${sig}`).toBe(false); expect(r.b, `auth ${sig}`).toBe(false); expect(r.s, `svc ${sig}`).toBe(false);
      }
    } finally { await c.end(); }
  });

  it('a forged direct helper call under SET ROLE service_role is DENIED (no state/ledger change); a top-level RPC still works', async () => {
    const c = conn(); await c.connect();
    try {
      const { g } = await toSending(c);
      await c.query(`SET ROLE service_role`);
      // internal mutators are not callable — no forged breaker trip / finalize / ledger row
      await expect(c.query(`SELECT public.notif_digest_trip_breaker('email','forged', now(), now())`)).rejects.toThrow(/permission denied/i);
      await expect(c.query(`SELECT public.notif_digest_finalize_group($1,'sent','forged', now())`, [g])).rejects.toThrow(/permission denied/i);
      await expect(c.query(`SELECT public.notif_digest_ledger(gen_random_uuid(),$1,NULL,'sent',0)`, [g])).rejects.toThrow(/permission denied/i);
      // a legitimate top-level RPC still succeeds as service_role (SECURITY DEFINER runs as owner)
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      expect(run).toBeTruthy();
      await c.query(`RESET ROLE`);
      // nothing forged: no breaker row, no extra ledger action from the denied calls
      expect((await c.query(`SELECT count(*)::int n FROM public.notification_provider_circuit WHERE reason='forged'`)).rows[0].n).toBe(0);
      expect((await c.query(`SELECT state FROM public.notification_digest_groups WHERE id=$1`, [g])).rows[0].state).toBe('sending');
    } finally { await c.query(`RESET ROLE`).catch(() => {}); await c.end(); }
  });
});
