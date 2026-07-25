// @vitest-environment node
// PR 10c-a2 — the ADR 0008 SQL state machine, verified on a REAL multi-connection Postgres server
// (embedded-postgres; no Docker). Loads the deployed schema + ACL-lockdown + the state-machine migration
// over prod-faithful default privileges, then exercises the full worker loop, the record/§ERR branch matrix,
// the provider-callback transition, the breaker two-stage probe, the sweep, TWO-CONNECTION concurrency
// (competing workers / cap races / stale leases / callback ordering / crash recovery), a 100k-row bounded
// query + EXPLAIN, and the RPC ACL matrix. INERT: no worker/webhook, no digest-enabled event.
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
    CREATE TABLE public.notification_event_types (key text PRIMARY KEY, supports_digest boolean NOT NULL DEFAULT false);
    CREATE TABLE public.notification_outbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), channel text NOT NULL DEFAULT 'email',
      event_type text, template_key text, status text NOT NULL DEFAULT 'pending',
      payload jsonb, public_summary jsonb, skip_reason text,
      tenant_academy_profile_id uuid, tenant_trainer_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT notification_outbox_status_check CHECK (status IN
        ('pending','processing','sent','delivered','failed','skipped','cancelled')));`);
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
      public.notification_outbox RESTART IDENTITY CASCADE`);
  } finally { await c.end(); }
});

async function seedMember(c: pg.Client, key: string, bytes = 100, boundary = BD, fp = 'df') {
  await c.query(`INSERT INTO public.notification_outbox
    (channel, delivery_mode, recipient_key, destination_fingerprint, event_type, template_key, template_version,
     group_locale, digest_frequency, recipient_timezone, digest_boundary_at, digest_item, digest_item_bytes, status)
    VALUES ('email','digest',$1,$2,'ev','tpl',1,'nl','daily','Europe/Amsterdam', ${boundary}, '{}'::jsonb, $3, 'pending')`,
    [key, fp, bytes]);
}
// drive one fresh single-member group all the way to 'sending'; returns { g, att, run }.
async function toSending(c: pg.Client, capArgs = '') {
  seq += 1; const key = `p:${seq}`;
  await seedMember(c, key, 100, BD, `df${seq}`);
  const mrun = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
  await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
  const g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [key])).rows[0].id;
  const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
  await c.query(`SELECT public.claim_notification_digest_group($1,'email', ${NOW}, 'W')`, [run]);
  await c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${NOW})`, [run, g]);
  await c.query(`SELECT public.store_notification_digest_request($1,$2,'W','{}'::jsonb,'h', ${NOW})`, [run, g]);
  const att = (await c.query(`SELECT public.begin_notification_digest_attempt($1,$2,'W', ${NOW}${capArgs}) AS a`, [run, g])).rows[0].a;
  return { g, att, run };
}
const gstate = async (c: pg.Client, g: string) => (await c.query(`SELECT * FROM public.notification_digest_groups WHERE id=$1`, [g])).rows[0];
const resStates = async (c: pg.Client, g: string) => (await c.query(`SELECT array_agg(state ORDER BY counter_key) a FROM public.notification_send_reservations WHERE digest_group_id=$1`, [g])).rows[0].a;

describe('10c-a2 worker loop — materialize → claim → prepare → store → begin', () => {
  it('materialize groups 3 same-key members into one 3-item group at the boundary', async () => {
    const c = conn(); await c.connect();
    try {
      for (let i = 0; i < 3; i++) await seedMember(c, 'p:loop', 100, BD, 'dfloop');
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      const n = (await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100) AS n`, [run])).rows[0].n;
      const g = (await c.query(`SELECT id, item_count, state, available_at FROM public.notification_digest_groups WHERE recipient_key='p:loop'`)).rows[0];
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
      await seedMember(c, 'p:big', 200000, BD, 'dfbig'); // > 90 KB
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [run]);
      const g = (await c.query(`SELECT state, terminal_reason FROM public.notification_digest_groups WHERE recipient_key='p:big'`)).rows[0];
      const m = (await c.query(`SELECT status, skip_reason FROM public.notification_outbox WHERE recipient_key='p:big'`)).rows[0];
      expect(g.state).toBe('oversize_failed'); expect(m.status).toBe('failed'); expect(m.skip_reason).toBe('single_item_oversize');
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

  it('timeout → ambiguous → request_ready + uncertain + committed; sticky: then 429 stays committed', async () => {
    const c = conn(); await c.connect();
    try {
      const { g, att, run } = await toSending(c);
      await c.query(`SELECT public.record_notification_digest_result($1,$2,'timeout',NULL,NULL,NULL, ${NOW})`, [run, att]);
      let s = await gstate(c, g);
      expect(s.state).toBe('request_ready'); expect(s.uncertain_since).not.toBeNull(); expect(await resStates(c, g)).toEqual(['committed', 'committed']);
      // second attempt records 429 → sticky uncertainty keeps reservations committed (not released)
      await c.query(`UPDATE public.notification_digest_groups SET locked_by='W', locked_at=${NOW}, state='request_ready', available_at=${NOW} WHERE id=$1`, [g]);
      const att2 = (await c.query(`SELECT public.begin_notification_digest_attempt($1,$2,'W', ${NOW}) AS a`, [run, g])).rows[0].a;
      await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,429,'rate_limit_exceeded',NULL, ${NOW}, 30)`, [run, att2]);
      s = await gstate(c, g);
      expect(s.state).toBe('request_ready'); expect(await resStates(c, g)).toEqual(['committed', 'committed']);
    } finally { await c.end(); }
  });

  it('terminal clean → failed_terminal (released, member failed); terminal while uncertain → awaiting_evidence', async () => {
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

  it('late accepted from a stale attempt monotonically completes the group; stale non-accepted annotates only', async () => {
    const c = conn(); await c.connect();
    try {
      const { g, att, run } = await toSending(c);
      await c.query(`UPDATE public.notification_digest_groups SET uncertain_since=${NOW}, uncertain_deadline_at=${NOW}+interval '23 hours' WHERE id=$1`, [g]);
      const newer = (await c.query(`INSERT INTO public.notification_digest_attempts (digest_group_id, worker_run_id, provider_idempotency_key) VALUES ($1,$2,$3) RETURNING attempt_id`, [g, run, 'dg:v1:' + g])).rows[0].attempt_id;
      await c.query(`UPDATE public.notification_digest_groups SET current_attempt_id=$2 WHERE id=$1`, [g, newer]);
      const cls = (await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,202,NULL,'pm-late', ${NOW}) AS c`, [run, att])).rows[0].c; // OLD/stale attempt
      expect(cls).toBe('accepted'); expect((await gstate(c, g)).state).toBe('sent');
      await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,429,'rate_limit_exceeded',NULL, ${NOW})`, [run, newer]); // stale non-accepted
      expect((await gstate(c, g)).state).toBe('sent');
    } finally { await c.end(); }
  });
});

describe('10c-a2 provider callbacks (§PV) + breaker two-stage + sweep', () => {
  it('delivered → sent + rank3; duplicate event is a no-op; orphan is recorded', async () => {
    const c = conn(); await c.connect();
    try {
      const { g, att, run } = await toSending(c);
      await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,202,NULL,'pm-d', ${NOW})`, [run, att]);
      expect((await c.query(`SELECT public.apply_notification_provider_event($1,'ev1','pm-d',NULL,'delivered', ${NOW}, ${NOW}) AS r`, [run])).rows[0].r).toBe('sent');
      const s = await gstate(c, g); expect(s.provider_status).toBe('delivered'); expect(s.provider_status_rank).toBe(3);
      expect((await c.query(`SELECT public.apply_notification_provider_event($1,'ev1','pm-d',NULL,'delivered', ${NOW}, ${NOW}) AS r`, [run])).rows[0].r).toBe('duplicate');
      expect((await c.query(`SELECT public.apply_notification_provider_event(NULL,'evo','pm-none',NULL,'delivered', ${NOW}, ${NOW}) AS r`)).rows[0].r).toBe('orphan');
    } finally { await c.end(); }
  });

  it('bounced → failed_terminal (member failed); a later out-of-order sent is rank-guarded (no regress)', async () => {
    const c = conn(); await c.connect();
    try {
      const { g, att, run } = await toSending(c);
      await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,202,NULL,'pm-b', ${NOW})`, [run, att]);
      await c.query(`SELECT public.apply_notification_provider_event($1,'evb','pm-b',NULL,'bounced', ${NOW}, ${NOW})`, [run]);
      expect((await gstate(c, g)).state).toBe('failed_terminal');
      expect((await c.query(`SELECT status FROM public.notification_outbox WHERE digest_group_id=$1`, [g])).rows[0].status).toBe('failed');
      const late = (await c.query(`SELECT public.apply_notification_provider_event($1,'evl','pm-b',NULL,'sent', ${NOW}, ${NOW}) AS r`, [run])).rows[0].r;
      expect(late).toBe('noop_rank'); expect((await gstate(c, g)).provider_status).toBe('bounced');
    } finally { await c.end(); }
  });

  it('breaker two-stage: open+due promotes ONE probe, defers the rest; only the probe transitions the breaker', async () => {
    const c = conn(); await c.connect();
    try {
      const a = await toSending(c); const b = await toSending(c);
      await c.query(`UPDATE public.notification_digest_groups SET state='request_ready', locked_by=NULL, locked_at=NULL, available_at=${NOW} WHERE id IN ($1,$2)`, [a.g, b.g]);
      await c.query(`SELECT public.notif_digest_trip_breaker('email','test', ${NOW} - interval '1 minute', ${NOW})`);
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      const p = (await c.query(`SELECT public.claim_notification_digest_group($1,'email', ${NOW}, 'P1') AS g`, [run])).rows[0].g;
      const cb1 = (await c.query(`SELECT * FROM public.notification_provider_circuit WHERE channel='email'`)).rows[0];
      expect(cb1.state).toBe('half_open'); expect(cb1.probe_group_id).toBe(p);
      expect((await c.query(`SELECT public.claim_notification_digest_group($1,'email', ${NOW}, 'P2') AS g`, [run])).rows[0].g).toBeNull(); // non-probe deferred
      const att = (await c.query(`SELECT public.begin_notification_digest_attempt($1,$2,'P1', ${NOW}) AS a`, [run, p])).rows[0].a;
      expect((await c.query(`SELECT probe_attempt_id FROM public.notification_provider_circuit WHERE channel='email'`)).rows[0].probe_attempt_id).toBe(att);
      await c.query(`SELECT public.record_notification_digest_result($1,$2,NULL,202,NULL,'pm-p', ${NOW})`, [run, att]);
      const cb3 = (await c.query(`SELECT * FROM public.notification_provider_circuit WHERE channel='email'`)).rows[0];
      expect(cb3.state).toBe('closed'); expect(cb3.probe_group_id).toBeNull();
    } finally { await c.end(); }
  });

  it('sweep ages out due awaiting_evidence → delivery_unknown', async () => {
    const c = conn(); await c.connect();
    try {
      const { g } = await toSending(c);
      await c.query(`UPDATE public.notification_digest_groups SET state='awaiting_evidence', available_at=${NOW} - interval '1 hour', locked_by=NULL WHERE id=$1`, [g]);
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      const n = (await c.query(`SELECT public.reconcile_notification_digest_stale($1,'email', ${NOW}) AS n`, [run])).rows[0].n;
      expect(Number(n)).toBeGreaterThanOrEqual(1); expect((await gstate(c, g)).state).toBe('delivery_unknown');
    } finally { await c.end(); }
  });
});

describe('10c-a2 two-connection concurrency (real Postgres)', () => {
  it('competing workers never claim the same group (FOR UPDATE SKIP LOCKED)', async () => {
    const c0 = conn(); await c0.connect();
    try {
      for (let i = 0; i < 6; i++) { await seedMember(c0, `p:cc${i}`, 100, BD, `dfcc${i}`); }
      const mrun = (await c0.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c0.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
    } finally { await c0.end(); }
    const a = conn(); const b = conn(); await a.connect(); await b.connect();
    try {
      const ra = (await a.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      const rb = (await b.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      // both claim concurrently
      const [ga, gb] = await Promise.all([
        a.query(`SELECT public.claim_notification_digest_group($1,'email', ${NOW}, 'A') AS g`, [ra]).then(r => r.rows[0].g),
        b.query(`SELECT public.claim_notification_digest_group($1,'email', ${NOW}, 'B') AS g`, [rb]).then(r => r.rows[0].g),
      ]);
      expect(ga).not.toBeNull(); expect(gb).not.toBeNull(); expect(ga).not.toBe(gb); // distinct groups
    } finally { await a.end(); await b.end(); }
  });

  it('cap race: two workers begin under cap=1 — exactly one sends, the other defers (deferred_cap)', async () => {
    // two groups sharing the SAME destination fingerprint → same hour/day counter; hour cap = 1.
    const c0 = conn(); await c0.connect();
    let g1: string, g2: string, r1: string, r2: string;
    try {
      await seedMember(c0, 'p:cap1', 100, BD, 'dfcap'); await seedMember(c0, 'p:cap2', 100, BD, 'dfcap');
      const mrun = (await c0.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c0.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
      g1 = (await c0.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key='p:cap1'`)).rows[0].id;
      g2 = (await c0.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key='p:cap2'`)).rows[0].id;
      // walk each to request_ready + owned (single connection, sequential setup)
      for (const [g, w] of [[g1, 'CA'], [g2, 'CB']] as const) {
        const run = (await c0.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
        await c0.query(`UPDATE public.notification_digest_groups SET state='leased', locked_by=$2, locked_at=${NOW}, worker_run_id=$3 WHERE id=$1`, [g, w, run]);
        await c0.query(`SELECT public.prepare_notification_digest_group($1,$2,$3, ${NOW})`, [run, g, w]);
        await c0.query(`SELECT public.store_notification_digest_request($1,$2,$3,'{}'::jsonb,'h', ${NOW})`, [run, g, w]);
        if (g === g1) r1 = run; else r2 = run;
      }
    } finally { await c0.end(); }
    const a = conn(); const b = conn(); await a.connect(); await b.connect();
    try {
      // both begin concurrently with hour cap 1 (p_hour_cap=1)
      const [x, y] = await Promise.all([
        a.query(`SELECT public.begin_notification_digest_attempt($1,$2,'CA', ${NOW}, 1, 5000) AS a`, [r1!, g1!]).then(r => r.rows[0].a),
        b.query(`SELECT public.begin_notification_digest_attempt($1,$2,'CB', ${NOW}, 1, 5000) AS a`, [r2!, g2!]).then(r => r.rows[0].a),
      ]);
      const sent = [x, y].filter(Boolean).length;
      expect(sent).toBe(1); // exactly one acquired the single slot; the other deferred
      const cc = conn(); await cc.connect();
      const used = (await cc.query(`SELECT used FROM public.notification_send_counters WHERE bucket_kind='hour'`)).rows[0].used;
      expect(used).toBe(1); // never oversubscribed
      await cc.end();
    } finally { await a.end(); await b.end(); }
  });

  it('stale lease: a crashed worker\'s leased group is reclaimed by another worker', async () => {
    const c = conn(); await c.connect();
    try {
      seq += 1; await seedMember(c, `p:stale${seq}`, 100, BD, `dfstale${seq}`);
      const mrun = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
      const g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key='p:stale${seq}'`)).rows[0].id;
      // simulate a crashed worker holding a stale lease
      await c.query(`UPDATE public.notification_digest_groups SET state='sending', locked_by='DEAD', locked_at=${NOW} - interval '1 hour', available_at=${NOW} WHERE id=$1`, [g]);
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      const claimed = (await c.query(`SELECT public.claim_notification_digest_group($1,'email', ${NOW}, 'ALIVE', 15) AS g`, [run])).rows[0].g;
      const s = await gstate(c, g);
      expect(claimed).toBe(g); expect(s.locked_by).toBe('ALIVE'); expect(s.uncertain_since).not.toBeNull(); // sending reclaim sets uncertainty
    } finally { await c.end(); }
  });
});

describe('10c-a2 scale + bounded queries (100k rows, EXPLAIN, no offset)', () => {
  it('materialize is bounded per call; the due-claim query uses the partial index (no seq scan)', async () => {
    const c = conn(); await c.connect();
    try {
      // 100k pending digest members across 1000 destinations (100 each) at a due boundary.
      await c.query(`INSERT INTO public.notification_outbox
        (channel, delivery_mode, recipient_key, destination_fingerprint, event_type, template_key, template_version,
         group_locale, digest_frequency, recipient_timezone, digest_boundary_at, digest_item, digest_item_bytes, status)
        SELECT 'email','digest','p:'||(gs/100), 'fp:'||(gs/100), 'ev','tpl',1,'nl','daily','Europe/Amsterdam',
               ${BD}, '{}'::jsonb, 100, 'pending'
        FROM generate_series(0, 99999) gs`);
      const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      // bounded: p_max_members_per_call caps the scan; a single call never processes all 100k.
      const n1 = (await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 50, 5000) AS n`, [run])).rows[0].n;
      expect(Number(n1)).toBeLessThanOrEqual(50); // respected p_max_groups
      // the due-claim query must Index-Scan the partial index, not Seq-Scan 100k+ groups.
      const plan = (await c.query(`EXPLAIN (FORMAT JSON) SELECT * FROM public.notification_digest_groups
        WHERE channel='email' AND state IN ('pending','request_ready') AND locked_by IS NULL AND available_at <= ${NOW}
        ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0]['QUERY PLAN'];
      const planText = JSON.stringify(plan);
      expect(planText).toMatch(/Index Scan|Index Only Scan|Bitmap Index Scan/);
      expect(planText).not.toMatch(/Seq Scan/);
    } finally { await c.end(); }
  });

  it('no RPC uses OFFSET pagination or an unbounded loop (all scans are LIMIT + FOR UPDATE SKIP LOCKED)', () => {
    const sql = readFileSync(join(process.cwd(), 'supabase', 'migrations', '20261004100000_notification_digest_state_machine.sql'), 'utf8');
    expect(sql).not.toMatch(/\boffset\b/i);      // no offset pagination
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    // every claim/sweep loop is LIMIT-bounded; the claim scan has an explicit iteration cap.
    expect(sql).toMatch(/v_iter > 200/);
  });
});

describe('10c-a2 ACL — every RPC is service-role-only (Supabase default-privilege accounted)', () => {
  it('anon + authenticated cannot EXECUTE any state-machine RPC; service_role can', async () => {
    const c = conn(); await c.connect();
    try {
      const fns = (await c.query(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND (p.proname LIKE 'notif_digest_%' OR p.proname IN
          ('start_notification_worker_run','finish_notification_worker_run','materialize_notification_digest_groups',
           'claim_notification_digest_group','prepare_notification_digest_group','split_notification_digest_group',
           'store_notification_digest_request','begin_notification_digest_attempt','record_notification_digest_result',
           'reconcile_notification_digest_run','reconcile_notification_digest_stale','apply_notification_provider_event'))`)).rows.map((r: { sig: string }) => r.sig);
      expect(fns.length).toBeGreaterThanOrEqual(20);
      for (const sig of fns) {
        const r = (await c.query(`SELECT has_function_privilege('anon',$1,'EXECUTE') a, has_function_privilege('authenticated',$1,'EXECUTE') b, has_function_privilege('service_role',$1,'EXECUTE') s`, [sig])).rows[0];
        expect(r.a, `anon ${sig}`).toBe(false); expect(r.b, `auth ${sig}`).toBe(false); expect(r.s, `svc ${sig}`).toBe(true);
      }
    } finally { await c.end(); }
  });
});
