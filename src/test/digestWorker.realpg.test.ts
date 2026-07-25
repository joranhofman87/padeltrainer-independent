// @vitest-environment node
// PR 10c-a3 — the digest WORKER loop, driven end-to-end against a REAL multi-connection Postgres
// (embedded-postgres) with the full deployed migration chain (10c-a1 foundation + ACL + 10c-a2 state machine +
// 10c-a3 render-oversize) and a SCRIPTED fake Resend. Covers the required fault-injection matrix: disabled /
// config-invalid zero-mutation, two-worker concurrency, crash boundaries, multi-item split, single-item
// oversize terminalization, exact frozen-request dispatch, one HTTP per attempt, timeout/network ambiguity,
// record-failure recovery, stale-lease recovery, bounded invocation, and truthful run reconciliation.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDigestWorker, type WorkerDeps, type WorkerLimits } from '../../supabase/functions/_shared/digest-worker-core.ts';
import type { ResendSendOnceResult } from '../../supabase/functions/_shared/resend-send-once.ts';

const PORT = 54347;
let epg: InstanceType<typeof EmbeddedPostgres> | undefined;
let url = '';
let seq = 0;
const conn = () => new pg.Client({ connectionString: url });

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'digest-worker-'));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  await epg.initialise(); await epg.start();
  url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
  const c = conn(); await c.connect();
  await c.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    CREATE TABLE public.notification_event_types (key text PRIMARY KEY, supports_digest boolean NOT NULL DEFAULT false, required_delivery boolean NOT NULL DEFAULT false);
    CREATE TABLE public.notification_contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), person_id uuid, user_id uuid, guest_player_id uuid, channel text NOT NULL DEFAULT 'email', destination_normalized text NOT NULL, consent_status text NOT NULL DEFAULT 'unknown', consent_scope text NOT NULL DEFAULT 'global', consent_academy_profile_id uuid, consent_trainer_id uuid, revoked_at timestamptz, is_primary boolean NOT NULL DEFAULT false, verified_at timestamptz);
    CREATE FUNCTION public.is_notification_consent_in_scope(_a text,_b uuid,_c uuid,_d uuid,_e uuid) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;
    CREATE TABLE public.notification_outbox (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), channel text NOT NULL DEFAULT 'email', event_type text, template_key text, status text NOT NULL DEFAULT 'pending', payload jsonb, skip_reason text, destination_normalized text, contact_id uuid, recipient_person_id uuid, recipient_user_id uuid, recipient_guest_player_id uuid, tenant_academy_profile_id uuid, tenant_trainer_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT notification_outbox_status_check CHECK (status IN ('pending','processing','sent','delivered','failed','skipped','cancelled')));
    CREATE TABLE public.email_suppression_stub (email text PRIMARY KEY);
    CREATE FUNCTION public.is_email_suppressed(p text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM public.email_suppression_stub WHERE email = lower(p)) $$;
    CREATE TABLE public.notification_preferences_v2 (user_id uuid NOT NULL, event_type text NOT NULL, email_frequency text NOT NULL DEFAULT 'instant', UNIQUE (user_id, event_type));
    CREATE TABLE public.persons (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE, email text);`);
  for (const f of ['20261002100000_notification_digest_schema_foundation.sql', '20261003100000_notification_digest_acl_lockdown.sql',
    '20261004100000_notification_digest_state_machine.sql', '20261005100000_notification_digest_render_oversize.sql',
    '20261005110000_notification_digest_request_hash_bytea_fix.sql']) {
    await c.query(readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8'));
  }
  await c.end();
}, 180_000);

afterAll(async () => { if (epg) await epg.stop(); });

beforeEach(async () => {
  const c = conn(); await c.connect();
  try {
    await c.query(`TRUNCATE public.notification_digest_groups, public.notification_digest_attempts,
      public.notification_digest_group_attempts, public.notification_provider_events, public.notification_provider_circuit,
      public.notification_send_counters, public.notification_send_reservations, public.notification_worker_runs,
      public.notification_outbox, public.email_suppression_stub, public.notification_preferences_v2, public.notification_contacts,
      public.persons RESTART IDENTITY CASCADE`);
  } finally { await c.end(); }
});

const NOW = new Date('2026-07-01T10:00:00Z');
const BD = "'2026-07-01 06:00:00+00'::timestamptz";
const FIXED_LIMITS: WorkerLimits = { maxMaterializeGroups: 200, maxMaterializeMembers: 5000, maxAttempts: 100, sweepLimit: 500, wallClockMs: 60_000 };

/** Named-arg RPC caller: object keys → `p_x => $n` (jsonb-cast for object values). Throws on DB error. */
function mkRpc(c: pg.Client) {
  return async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const keys = Object.keys(args);
    const named = keys.map((k, i) => (args[k] !== null && typeof args[k] === 'object') ? `${k} => $${i + 1}::jsonb` : `${k} => $${i + 1}`).join(', ');
    const vals = keys.map((k) => (args[k] !== null && typeof args[k] === 'object') ? JSON.stringify(args[k]) : args[k]);
    const r = await c.query(`SELECT public.${name}(${named}) AS result`, vals);
    return r.rows[0]?.result ?? null;
  };
}

type DepOverrides = Partial<Pick<WorkerDeps, 'enabled' | 'apiKeyPresent' | 'limits' | 'now'>> & {
  send?: (payload: { to: string[]; subject: string; html: string }, opts: { idempotencyKey: string }) => ResendSendOnceResult;
  wrapRpc?: (rpc: WorkerDeps['rpc']) => WorkerDeps['rpc'];
  logs?: Record<string, unknown>[];
  sendCalls?: Array<{ payload: { to: string[]; subject: string; html: string }; opts: { idempotencyKey: string } }>;
  frozenSeen?: Array<{ request: { to: string; subject: string; html: string }; idempotencyKey: string } | null>;
  tokenSuffix?: string;
};

function mkDeps(c: pg.Client, o: DepOverrides = {}): WorkerDeps {
  const rawRpc = mkRpc(c);
  const sendCalls = o.sendCalls ?? [];
  const defaultSend = (): ResendSendOnceResult => ({ kind: 'response', httpStatus: 202, providerMessageId: 're_' + (++seq), errorName: null, retryAfterSeconds: null });
  return {
    enabled: o.enabled ?? true,
    apiKeyPresent: o.apiKeyPresent ?? true,
    channel: 'email',
    from: 'PadelTrainer.ai <noreply@app.padeltrainer.ai>',
    limits: o.limits ?? FIXED_LIMITS,
    rpc: o.wrapRpc ? o.wrapRpc(rawRpc) : rawRpc,
    loadMembers: async (g) => {
      const r = await c.query(`SELECT destination_normalized, digest_item, group_locale FROM public.notification_outbox WHERE digest_group_id=$1 AND status='pending' ORDER BY created_at, id`, [g]);
      return r.rows.map((row) => ({ destination: row.destination_normalized, digestItem: row.digest_item, locale: row.group_locale }));
    },
    loadFrozen: async (g) => {
      const r = await c.query(`SELECT frozen_request, provider_idempotency_key FROM public.notification_digest_groups WHERE id=$1`, [g]);
      const row = r.rows[0];
      const out = (!row || !row.frozen_request || !row.provider_idempotency_key)
        ? null : { request: row.frozen_request, idempotencyKey: row.provider_idempotency_key };
      o.frozenSeen?.push(out);   // capture the PERSISTED request the worker read (it is scrubbed once terminal)
      return out;
    },
    sendOnce: (payload, opts) => {
      sendCalls.push({ payload, opts });
      return Promise.resolve(o.send ? o.send(payload, opts) : defaultSend());
    },
    now: o.now ?? (() => NOW),
    monotonicNowMs: (() => { let t = 0; return () => (t += 1); })(),
    newToken: () => `notification-digest-worker:${o.tokenSuffix ?? 'w'}:${++seq}`,
    log: (e) => { (o.logs ?? []).push(e); },
  };
}

async function seedDigestGroup(c: pg.Client, key: string, dest: string, items: object[]) {
  const fp = (await c.query(`SELECT public.notif_digest_destination_fingerprint($1) f`, [dest])).rows[0].f;
  const uid = (await c.query(`SELECT gen_random_uuid() u`)).rows[0].u;
  await c.query(`INSERT INTO public.persons (user_id, email) VALUES ($1,$2)`, [uid, dest]);
  for (const item of items) {
    await c.query(`INSERT INTO public.notification_outbox
      (channel, delivery_mode, recipient_key, destination_fingerprint, destination_normalized, recipient_user_id,
       event_type, template_key, template_version, group_locale, digest_frequency, recipient_timezone,
       digest_boundary_at, digest_item, status)
      VALUES ('email','digest',$1,$2,$3,$4,'ev','tpl',1,'en','daily','Europe/Amsterdam', ${BD}, $5, 'pending')`,
      [key, fp, dest, uid, JSON.stringify(item)]);
  }
}
const gstate = async (c: pg.Client, g: string) => (await c.query(`SELECT * FROM public.notification_digest_groups WHERE id=$1`, [g])).rows[0];

describe('10c-a3 digest worker — inertness + happy path + dispatch contract', () => {
  it('DISABLED / no-API-key: ZERO database mutations (no worker run, no groups touched)', async () => {
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'p:1', 'a@example.com', [{ title: 'x' }]);
      let rpcCalls = 0;
      const deps = mkDeps(c, { enabled: false, wrapRpc: (r) => (n, a) => { rpcCalls++; return r(n, a); } });
      const s1 = await runDigestWorker(deps);
      expect(s1.status).toBe('disabled');
      const s2 = await runDigestWorker(mkDeps(c, { apiKeyPresent: false, wrapRpc: (r) => (n, a) => { rpcCalls++; return r(n, a); } }));
      expect(s2.status).toBe('disabled');
      expect(rpcCalls).toBe(0);                                        // NO rpc calls at all
      expect((await c.query(`SELECT count(*)::int n FROM public.notification_worker_runs`)).rows[0].n).toBe(0);
      expect((await c.query(`SELECT count(*)::int n FROM public.notification_digest_groups`)).rows[0].n).toBe(0);
      expect((await c.query(`SELECT count(*)::int n FROM public.notification_outbox WHERE status<>'pending'`)).rows[0].n).toBe(0);
    } finally { await c.end(); }
  });

  it('happy path: materialize→…→send→record delivers; sends the EXACT persisted frozen request + idempotency key; ONE HTTP per attempt', async () => {
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'p:1', 'a@example.com', [{ title: 'Booking confirmed', url: 'https://x/1' }]);
      const sendCalls: DepOverrides['sendCalls'] = [];
      const frozenSeen: DepOverrides['frozenSeen'] = [];
      const s = await runDigestWorker(mkDeps(c, { sendCalls, frozenSeen }));
      expect(s.status).toBe('ok'); expect(s.materialized).toBe(1); expect(s.sent).toBe(1); expect(s.recorded).toBe(1);
      const g = (await c.query(`SELECT * FROM public.notification_digest_groups WHERE recipient_key='p:1'`)).rows[0];
      expect(g.state).toBe('sent'); expect(g.provider_message_id).toMatch(/^re_/);
      expect(g.frozen_request).toBeNull();          // scrubbed on terminal (no PII retained post-send)
      // the worker sent the EXACT request the STATE MACHINE persisted (captured at loadFrozen, pre-scrub) — a
      // re-render would diverge — with the PERSISTED idempotency key dg:v1:<group>.
      const persisted = frozenSeen[0]!;
      expect(persisted.idempotencyKey).toBe('dg:v1:' + g.id);
      expect(sendCalls.length).toBe(1);
      expect(sendCalls[0].payload.to).toEqual([persisted.request.to]);
      expect(sendCalls[0].payload.subject).toBe(persisted.request.subject);
      expect(sendCalls[0].payload.html).toBe(persisted.request.html);
      expect(sendCalls[0].opts.idempotencyKey).toBe(persisted.idempotencyKey);
      // exactly one attempt, one HTTP call
      expect((await c.query(`SELECT count(*)::int n FROM public.notification_digest_attempts WHERE digest_group_id=$1`, [g.id])).rows[0].n).toBe(1);
    } finally { await c.end(); }
  });

  it('bounded: maxAttempts caps claims per invocation even with more due groups', async () => {
    const c = conn(); await c.connect();
    try {
      for (let i = 0; i < 5; i++) await seedDigestGroup(c, `p:${i}`, `u${i}@example.com`, [{ title: 't' }]);
      const s = await runDigestWorker(mkDeps(c, { limits: { ...FIXED_LIMITS, maxAttempts: 1 } }));
      expect(s.claimed).toBe(1);                                       // only one group processed
      expect((await c.query(`SELECT count(*)::int n FROM public.notification_digest_groups WHERE state='sent'`)).rows[0].n).toBe(1);
    } finally { await c.end(); }
  });

  it('truthful run finish: a run-level RPC failure finishes the run as failed (never a false succeeded)', async () => {
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'p:1', 'a@example.com', [{ title: 't' }]);
      // make the SWEEP (a run-level step) throw → the dispatch run must finish 'failed'
      const wrapRpc: DepOverrides['wrapRpc'] = (r) => (n, a) => (n === 'reconcile_notification_digest_stale' ? Promise.reject(new Error('boom')) : r(n, a));
      await expect(runDigestWorker(mkDeps(c, { wrapRpc }))).rejects.toThrow();
      const run = (await c.query(`SELECT status, ended_at FROM public.notification_worker_runs WHERE phase='dispatch' ORDER BY started_at DESC LIMIT 1`)).rows[0];
      expect(run.status).toBe('failed'); expect(run.ended_at).not.toBeNull();
    } finally { await c.end(); }
  });
});

describe('10c-a3 digest worker — fault injection', () => {
  it('timeout/network → ambiguous (uncertain, request_ready), no false send', async () => {
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'p:1', 'a@example.com', [{ title: 't' }]);
      const s = await runDigestWorker(mkDeps(c, { send: () => ({ kind: 'transport', transport: 'timeout', message: 't/o' }) }));
      expect(s.recorded).toBe(1); expect(s.sent).toBe(0);
      const g = (await c.query(`SELECT * FROM public.notification_digest_groups WHERE recipient_key='p:1'`)).rows[0];
      expect(g.state).toBe('request_ready'); expect(g.uncertain_since).not.toBeNull();
    } finally { await c.end(); }
  });

  it('a 429 with Retry-After defers (retryable), reservations released; a 422 terminalizes failed', async () => {
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'r:1', 'a@example.com', [{ title: 't' }]);
      await runDigestWorker(mkDeps(c, { send: () => ({ kind: 'response', httpStatus: 429, providerMessageId: null, errorName: 'rate_limit_exceeded', retryAfterSeconds: 30 }) }));
      expect((await c.query(`SELECT state FROM public.notification_digest_groups WHERE recipient_key='r:1'`)).rows[0].state).toBe('request_ready');
      await seedDigestGroup(c, 't:1', 'b@example.com', [{ title: 't' }]);
      await runDigestWorker(mkDeps(c, { send: (p) => (p.to[0] === 'b@example.com'
        ? { kind: 'response', httpStatus: 422, providerMessageId: null, errorName: 'validation_error', retryAfterSeconds: null }
        : { kind: 'response', httpStatus: 202, providerMessageId: 're_x', errorName: null, retryAfterSeconds: null }) }));
      expect((await c.query(`SELECT state FROM public.notification_digest_groups WHERE recipient_key='t:1'`)).rows[0].state).toBe('failed_terminal');
    } finally { await c.end(); }
  });

  it('single-item RENDER oversize → terminalized oversize_failed (never loops)', async () => {
    const c = conn(); await c.connect();
    try {
      // one item whose RAW bytes ≤ 90 KB but whose ESCAPED render blows past it ("<" → "&lt;", 4×).
      await seedDigestGroup(c, 'o:1', 'a@example.com', [{ title: '<'.repeat(30000) }]);
      const sendCalls: DepOverrides['sendCalls'] = [];
      const s = await runDigestWorker(mkDeps(c, { sendCalls }));
      expect(s.oversizeFailed).toBe(1); expect(sendCalls.length).toBe(0);   // never sent
      expect((await c.query(`SELECT state, terminal_reason FROM public.notification_digest_groups WHERE recipient_key='o:1'`)).rows[0]).toMatchObject({ state: 'oversize_failed', terminal_reason: 'render_oversize' });
    } finally { await c.end(); }
  });

  it('multi-item RENDER oversize → split into children that then send (never terminalized whole)', async () => {
    const c = conn(); await c.connect();
    try {
      // 44 items whose RAW bytes total ~36 KB (one group under the 90 KB / 50-item budget), but whose titles are
      // all "<" — HTML-escaped to "&lt;" (4×), the render balloons to ~143 KB (>90 KB) → split into two 22-item
      // children of ~72 KB each, which both fit and send. A single split level (no cascade).
      const items = Array.from({ length: 44 }, () => ({ title: '<'.repeat(800) }));
      await seedDigestGroup(c, 's:1', 'a@example.com', items);
      const s = await runDigestWorker(mkDeps(c, { limits: { ...FIXED_LIMITS, maxAttempts: 50 } }));
      expect(s.oversizeSplit).toBeGreaterThanOrEqual(1);
      const parent = (await c.query(`SELECT state FROM public.notification_digest_groups WHERE recipient_key='s:1' AND parent_group_id IS NULL`)).rows[0];
      expect(parent.state).toBe('superseded');
      const kids = (await c.query(`SELECT state FROM public.notification_digest_groups WHERE parent_group_id IS NOT NULL`)).rows;
      expect(kids.length).toBeGreaterThanOrEqual(2);
      expect(kids.every((k) => k.state === 'sent')).toBe(true);         // every child fit + sent
    } finally { await c.end(); }
  });

  it('record-failure recovery: a record() error leaves the attempt live; the run still succeeds; a later run recovers it', async () => {
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'p:1', 'a@example.com', [{ title: 't' }]);
      // first run: record throws → group left 'sending' with an unrecorded attempt; run status ok (group error counted)
      const wrapRpc: DepOverrides['wrapRpc'] = (r) => (n, a) => (n === 'record_notification_digest_result' ? Promise.reject(new Error('db blip')) : r(n, a));
      const s1 = await runDigestWorker(mkDeps(c, { wrapRpc }));
      expect(s1.status).toBe('ok'); expect(s1.groupErrors).toBe(1);
      const g1 = (await c.query(`SELECT * FROM public.notification_digest_groups WHERE recipient_key='p:1'`)).rows[0];
      expect(g1.state).toBe('sending');
      // second run, ≥15 min later: claim's stale-lease reclaim recovers the group (sending → uncertainty).
      const later = new Date(NOW.getTime() + 20 * 60 * 1000);
      await runDigestWorker(mkDeps(c, { now: () => later }));
      const g2 = await gstate(c, g1.id);
      expect(g2.uncertain_since).not.toBeNull();                        // recovered, not stuck
    } finally { await c.end(); }
  });

  it('two concurrent workers never double-send: each group sent exactly once', async () => {
    const c0 = conn(); await c0.connect();
    try { for (let i = 0; i < 6; i++) await seedDigestGroup(c0, `p:${i}`, `u${i}@example.com`, [{ title: 't' }]); } finally { await c0.end(); }
    const a = conn(); const b = conn(); await a.connect(); await b.connect();
    try {
      await Promise.all([
        runDigestWorker(mkDeps(a, { tokenSuffix: 'A' })),
        runDigestWorker(mkDeps(b, { tokenSuffix: 'B' })),
      ]);
      const cc = conn(); await cc.connect();
      // every group is sent, and each has exactly ONE recorded attempt (no double-send)
      const dup = (await cc.query(`SELECT count(*)::int n FROM (SELECT digest_group_id FROM public.notification_digest_attempts WHERE recorded_at IS NOT NULL GROUP BY digest_group_id HAVING count(*)>1) x`)).rows[0].n;
      const sent = (await cc.query(`SELECT count(*)::int n FROM public.notification_digest_groups WHERE state='sent'`)).rows[0].n;
      await cc.end();
      expect(dup).toBe(0); expect(sent).toBe(6);
    } finally { await a.end(); await b.end(); }
  });

  it('stale-lease recovery: a crashed worker\'s "sending" group is reclaimed on the next run', async () => {
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'p:1', 'a@example.com', [{ title: 't' }]);
      // simulate a crash after begin: leave the group 'sending', stale-locked, uncertainty unset
      await runDigestWorker(mkDeps(c, { send: () => { throw new Error('process died mid-send'); } })).catch(() => {});
      const g1 = (await c.query(`SELECT * FROM public.notification_digest_groups WHERE recipient_key='p:1'`)).rows[0];
      expect(g1.state).toBe('sending');
      const later = new Date(NOW.getTime() + 30 * 60 * 1000);
      await runDigestWorker(mkDeps(c, { now: () => later }));
      const g2 = await gstate(c, g1.id);
      expect(g2.uncertain_since).not.toBeNull();
    } finally { await c.end(); }
  });
});
