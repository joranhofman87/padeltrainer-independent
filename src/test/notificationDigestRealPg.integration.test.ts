// @vitest-environment node
// PR 10c-a1 — REAL-Postgres integration for the two contracts PGlite cannot exercise (Codex round-5):
//   (2) the FK-precondition cascade + SET NULL ORDERING on a genuine server, and
//   (3) the link RPC's CONCURRENCY safety across two live connections (FOR UPDATE serialization).
// Uses embedded-postgres (a real Postgres server, no Docker) so it runs identically locally and in CI.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Client } = pg;
const PORT = 54329;
let epg: InstanceType<typeof EmbeddedPostgres> | undefined;
let url = '';
let seq = 0;

const GROUP_COLS = `canonical_group_key, group_key_hash, channel, event_type, recipient_key,
  destination_fingerprint, recipient_timezone, digest_boundary_at, available_at`;
function groupVals(key: string) {
  return `'["${key}"]'::jsonb, 'h', 'email', 'ev', 'p', 'df', 'Europe/Amsterdam', now(), now()`;
}
async function newGroup(c: pg.Client): Promise<string> {
  seq += 1;
  return (await c.query(`INSERT INTO public.notification_digest_groups (${GROUP_COLS})
    VALUES (${groupVals(`g${seq}`)}) RETURNING id`)).rows[0].id;
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'digest-realpg-'));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE public.notification_event_types (key text PRIMARY KEY, supports_digest boolean NOT NULL DEFAULT false);
    CREATE TABLE public.notification_outbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), channel text NOT NULL DEFAULT 'email', status text NOT NULL DEFAULT 'pending',
      CONSTRAINT notification_outbox_status_check CHECK (status IN ('pending','processing','sent','delivered','failed','skipped','cancelled')));`);
  await c.query(readFileSync(join(process.cwd(), 'supabase', 'migrations',
    '20261002100000_notification_digest_schema_foundation.sql'), 'utf8'));
  await c.end();
}, 180_000);

afterAll(async () => { if (epg) await epg.stop(); });

describe('10c-a1 real-Postgres — FK-precondition cascade + SET NULL ordering', () => {
  it('deleting an eligible group cascades attempts/ledger/linked events/reservations and nulls the surviving outbox member', async () => {
    const c = new Client({ connectionString: url }); await c.connect();
    try {
      const g = await newGroup(c);
      await c.query(`UPDATE public.notification_digest_groups SET provider_message_id='pm-casc' WHERE id=$1`, [g]);
      const a = (await c.query(`INSERT INTO public.notification_digest_attempts (digest_group_id, provider_idempotency_key)
        VALUES ($1,'k') RETURNING attempt_id`, [g])).rows[0].attempt_id;
      await c.query(`INSERT INTO public.notification_digest_group_attempts (digest_group_id, attempt_id, action) VALUES ($1,$2,'attempt')`, [g, a]);
      await c.query(`INSERT INTO public.notification_provider_events (resend_event_id, provider_message_id, status, occurred_at)
        VALUES ('ev-casc','pm-casc','delivered',now())`);
      await c.query(`SELECT public.link_notification_provider_event('ev-casc',$1)`, [g]); // linked
      await c.query(`INSERT INTO public.notification_send_counters (counter_key, bucket_kind, bucket_start, cap)
        VALUES ('ck-casc','day',date_trunc('day',now()),100)`);
      await c.query(`INSERT INTO public.notification_send_reservations (digest_group_id, counter_key, bucket_start, state)
        VALUES ($1,'ck-casc',date_trunc('day',now()),'committed')`, [g]);
      const ob = (await c.query(`INSERT INTO public.notification_outbox (status) VALUES ('pending') RETURNING id`)).rows[0].id;
      await c.query(`UPDATE public.notification_outbox SET digest_group_id=$1 WHERE id=$2`, [g, ob]);

      // age it into a retention-eligible terminal state (disable the guard = a DDL power the app never has)
      await c.query(`ALTER TABLE public.notification_digest_groups DISABLE TRIGGER trg_digest_groups_guard`);
      await c.query(`UPDATE public.notification_digest_groups SET state='sent', terminal_at=now()-interval '200 days' WHERE id=$1`, [g]);
      await c.query(`ALTER TABLE public.notification_digest_groups ENABLE TRIGGER trg_digest_groups_guard`);

      await c.query(`DELETE FROM public.notification_digest_groups WHERE id=$1`, [g]); // real server cascade

      for (const t of ['notification_digest_attempts', 'notification_digest_group_attempts',
        'notification_provider_events', 'notification_send_reservations']) {
        const col = t === 'notification_provider_events' ? 'digest_group_id' : 'digest_group_id';
        const n = (await c.query(`SELECT count(*)::int n FROM public.${t} WHERE ${col}=$1`, [g])).rows[0].n;
        expect(n, `${t} cascaded`).toBe(0);
      }
      const outbox = (await c.query(`SELECT digest_group_id FROM public.notification_outbox WHERE id=$1`, [ob])).rows[0];
      expect(outbox.digest_group_id).toBeNull(); // surviving member, relation nulled
    } finally { await c.end(); }
  });

  it('deleting a finished run nulls the surviving attempt/ledger run references (SET NULL)', async () => {
    const c = new Client({ connectionString: url }); await c.connect();
    try {
      const g = await newGroup(c); // stays non-terminal → survives
      const run = (await c.query(`INSERT INTO public.notification_worker_runs (worker, channel, phase) VALUES ('w','email','dispatch') RETURNING run_id`)).rows[0].run_id;
      const a = (await c.query(`INSERT INTO public.notification_digest_attempts (digest_group_id, worker_run_id, provider_idempotency_key)
        VALUES ($1,$2,'k') RETURNING attempt_id`, [g, run])).rows[0].attempt_id;
      await c.query(`INSERT INTO public.notification_digest_group_attempts (digest_group_id, worker_run_id, attempt_id, action) VALUES ($1,$2,$3,'attempt')`, [g, run, a]);
      // age the run to retention-eligible, then delete it
      await c.query(`ALTER TABLE public.notification_worker_runs DISABLE TRIGGER trg_worker_runs_guard`);
      await c.query(`UPDATE public.notification_worker_runs SET status='succeeded', started_at=now()-interval '201 days', ended_at=now()-interval '200 days' WHERE run_id=$1`, [run]);
      await c.query(`ALTER TABLE public.notification_worker_runs ENABLE TRIGGER trg_worker_runs_guard`);
      await c.query(`DELETE FROM public.notification_worker_runs WHERE run_id=$1`, [run]);

      expect((await c.query(`SELECT worker_run_id FROM public.notification_digest_attempts WHERE attempt_id=$1`, [a])).rows[0].worker_run_id).toBeNull();
      expect((await c.query(`SELECT worker_run_id FROM public.notification_digest_group_attempts WHERE digest_group_id=$1`, [g])).rows[0].worker_run_id).toBeNull();
      // the audit rows themselves survive (group still alive)
      expect((await c.query(`SELECT count(*)::int n FROM public.notification_digest_attempts WHERE attempt_id=$1`, [a])).rows[0].n).toBe(1);
    } finally { await c.end(); }
  });

  it('a direct (non-cascade) delete of an audit row is still refused on a real server', async () => {
    const c = new Client({ connectionString: url }); await c.connect();
    try {
      const g = await newGroup(c);
      const a = (await c.query(`INSERT INTO public.notification_digest_attempts (digest_group_id, provider_idempotency_key) VALUES ($1,'k') RETURNING attempt_id`, [g])).rows[0].attempt_id;
      await expect(c.query(`DELETE FROM public.notification_digest_attempts WHERE attempt_id=$1`, [a])).rejects.toThrow(/direct delete forbidden/i);
    } finally { await c.end(); }
  });
});

describe('10c-a1 real-Postgres — link RPC concurrency (two live connections)', () => {
  async function seedOrphan(key: string): Promise<string> {
    const c = new Client({ connectionString: url }); await c.connect();
    try {
      const g = await newGroup(c);
      await c.query(`UPDATE public.notification_digest_groups SET provider_message_id=$1 WHERE id=$2`, [`pm-${key}`, g]);
      await c.query(`INSERT INTO public.notification_provider_events (resend_event_id, provider_message_id, status, occurred_at)
        VALUES ($1,$2,'delivered',now())`, [`ev-${key}`, `pm-${key}`]);
      return g;
    } finally { await c.end(); }
  }

  it('two concurrent retries linking the same event to the same group BOTH succeed (idempotent under a real race)', async () => {
    const g = await seedOrphan('conc');
    const a = new Client({ connectionString: url }); await a.connect();
    const b = new Client({ connectionString: url }); await b.connect();
    try {
      await a.query('BEGIN'); await b.query('BEGIN');
      const ra = await a.query(`SELECT public.link_notification_provider_event('ev-conc',$1) AS ok`, [g]); // A links + holds FOR UPDATE lock
      const bP = b.query(`SELECT public.link_notification_provider_event('ev-conc',$1) AS ok`, [g]); // B blocks on the lock
      await new Promise((r) => setTimeout(r, 400));
      await a.query('COMMIT'); // A commits the link
      const rb = await bP;     // B unblocks, re-reads under lock, idempotent no-op
      await b.query('COMMIT');
      expect(ra.rows[0].ok).toBe(true);
      expect(rb.rows[0].ok).toBe(true); // NOT a spurious trigger failure
      const linked = (await new Client({ connectionString: url }));
      await linked.connect();
      expect((await linked.query(`SELECT digest_group_id FROM public.notification_provider_events WHERE resend_event_id='ev-conc'`)).rows[0].digest_group_id).toBe(g);
      await linked.end();
    } finally { await a.end(); await b.end(); }
  });

  it('two concurrent retries to DIFFERENT groups: one succeeds, the other is rejected (no silent double-link)', async () => {
    const g1 = await seedOrphan('race');
    const c2 = new Client({ connectionString: url }); await c2.connect();
    const g2 = await newGroup(c2); await c2.end();
    const a = new Client({ connectionString: url }); await a.connect();
    const b = new Client({ connectionString: url }); await b.connect();
    try {
      await a.query('BEGIN'); await b.query('BEGIN');
      const ra = await a.query(`SELECT public.link_notification_provider_event('ev-race',$1) AS ok`, [g1]); // A links to g1
      const bP = b.query(`SELECT public.link_notification_provider_event('ev-race',$1) AS ok`, [g2]).then(() => 'ok').catch((e) => `err:${e.message}`); // B → g2 blocks
      await new Promise((r) => setTimeout(r, 400));
      await a.query('COMMIT');
      const rb = await bP;
      await b.query('ROLLBACK').catch(() => {});
      expect(ra.rows[0].ok).toBe(true);
      expect(String(rb)).toMatch(/different group/i); // B correctly rejected
    } finally { await a.end(); await b.end(); }
  });
});
