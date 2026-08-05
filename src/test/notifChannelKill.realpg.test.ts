import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';

/**
 * N4 M2 — the per-channel KILL SWITCHES, instant side (contract CRITICAL 2 + HIGH 5).
 * Digest-side gates (claim/materialize/begin) are proven in digestWorker.realpg.test.ts over
 * the full engine; what lives here:
 *
 *  * the kill surface is SET-ONLY, owner-effectively: no UPDATE/DELETE/TRUNCATE by any path,
 *    and NO function in the schema can clear a kill;
 *  * claim_notification_outbox_batch refuses a killed channel FIRST — before the cap-cancel
 *    and the reap — with ZERO ledger mutations (a reapable stale row survives untouched);
 *  * kill-set and claim share the per-channel advisory lock: deterministic, both directions;
 *  * release gives claimed rows back — pending, the claim's attempt increment undone, a
 *    backoff — token-guarded, digest rows untouched;
 *  * channels are independent; the pre-provider read is service-role-only.
 *
 * REAL DDL doctrine: the outbox, event-types and restrictions tables and every function under
 * test come from the actual migrations, extracted verbatim — a hand-built stand-in is exactly
 * what hid the r.id-vs-run_id defect from M1's first battery.
 */

let epg: InstanceType<typeof EmbeddedPostgres>;
let c: InstanceType<typeof Client>;
let c2: InstanceType<typeof Client>;
const PORT = 54439;
const MIG = (f: string) =>
  readFileSync(resolve(__dirname, '..', '..', 'supabase', 'migrations', f), 'utf8');

const ADMIN = '11111111-1111-4111-8111-111111111111';
const PLAYER = '22222222-2222-4222-8222-222222222222';

const killDirect = async (channel = 'email') =>
  c.query(`INSERT INTO public.notification_channel_kill_switches (channel, reason, request_id)
           VALUES ($1, 'test kill', gen_random_uuid())`, [channel]);
const adminKill = async (client: InstanceType<typeof Client>, uid: string | null, channel = 'email', req?: string, reason = 'ops decided') => {
  await client.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [uid ?? '']);
  try {
    return (await client.query(`SELECT public.admin_activate_channel_kill($1,$2,$3) AS r`,
      [channel, reason, req ?? crypto.randomUUID()])).rows[0].r as string;
  } finally {
    await client.query(`SELECT set_config('request.jwt.claim.sub', '', false)`);
  }
};
const seedRow = async (over: Partial<{ status: string; channel: string; locked_at: string; locked_by: string; attempts: number; max_attempts: number; delivery_mode: string }> = {}) => {
  const r = await c.query(
    `INSERT INTO public.notification_outbox
       (channel, event_type, template_key, status, destination_normalized, scheduled_for,
        locked_at, locked_by, attempts, max_attempts, delivery_mode, payload, idempotency_key, recipient_user_id)
     VALUES ($1, 'ev_test', 'tpl', $2, 'a@example.com', now() - interval '1 minute',
             $3, $4, $5, $6, $7, '{}'::jsonb, gen_random_uuid()::text, '22222222-2222-4222-8222-222222222222')
     RETURNING id`,
    [over.channel ?? 'email', over.status ?? 'pending', over.locked_at ?? null, over.locked_by ?? null,
     over.attempts ?? 0, over.max_attempts ?? 3, over.delivery_mode ?? null]);
  return r.rows[0].id as string;
};
const claim = async (client: InstanceType<typeof Client>, worker = 'w:test', channel = 'email') =>
  (await client.query(`SELECT * FROM public.claim_notification_outbox_batch($1, $2, 20, 15)`, [channel, worker])).rows;
const rowOf = async (id: string) =>
  (await c.query(`SELECT * FROM public.notification_outbox WHERE id = $1`, [id])).rows[0];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'n4kill-rp-'));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  c = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
  await c.connect();
  c2 = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
  await c2.connect();
  await c.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TYPE public.app_role AS ENUM ('player', 'trainer', 'admin');
  `);
  const rolesMig = MIG('20260115184937_a9f9b073-efb2-4069-8c85-10e3c65c6124.sql');
  const userRolesDdl = rolesMig.match(/CREATE TABLE public\.user_roles \([\s\S]*?\);/)?.[0];
  const hasRole = rolesMig.match(/CREATE OR REPLACE FUNCTION public\.has_role[\s\S]*?\$\$;/)?.[0];
  if (!userRolesDdl || !hasRole) throw new Error('user_roles/has_role not found');
  await c.query(userRolesDdl);
  await c.query(hasRole);
  await c.query(`INSERT INTO auth.users (id) VALUES ($1), ($2)`, [ADMIN, PLAYER]);
  await c.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1,'admin'), ($2,'player')`, [ADMIN, PLAYER]);

  // REAL DDL: the outbox + event catalog from the foundation migration; the digest columns the
  // claim's predicates read from the digest foundation; the restrictions table from N3.
  // minimal FK targets the real outbox DDL references (shape-only stubs; nothing under test
  // reads them — the tables under test are extracted verbatim below)
  await c.query(`
    CREATE TABLE public.persons (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, email text);
    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE public.invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE public.notification_contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  `);
  const foundation = MIG('20260910100000_notification_foundation_schema.sql');
  const outboxDdl = foundation.match(/CREATE TABLE public\.notification_outbox \([\s\S]*?\);/)?.[0];
  const eventsDdl = foundation.match(/CREATE TABLE public\.notification_event_types \([\s\S]*?\);/)?.[0];
  if (!outboxDdl || !eventsDdl) throw new Error('outbox/event_types DDL not found in the foundation migration');
  await c.query(eventsDdl);
  await c.query(outboxDdl);
  const digestFoundation = MIG('20261002100000_notification_digest_schema_foundation.sql');
  const outboxAlter = digestFoundation.match(/ALTER TABLE public\.notification_outbox\n(?: {2}ADD COLUMN IF NOT EXISTS[\s\S]*?;)/)?.[0];
  if (!outboxAlter) throw new Error('outbox digest ALTER not found');
  await c.query(outboxAlter);
  const n3 = MIG('20261015110000_notif_n3_academy_restrictions.sql');
  const restrictionsDdl = n3.match(/CREATE TABLE public\.academy_notification_restrictions \([\s\S]*?\);/)?.[0];
  if (!restrictionsDdl) throw new Error('restrictions DDL not found');
  await c.query(restrictionsDdl);
  await c.query(`INSERT INTO public.notification_event_types (key, category, audience, priority) VALUES ('ev_test', 'booking', 'player', 'transactional')`);

  await c.query(MIG('20261017100000_notif_n4_channel_kill_switches.sql'));
}, 180_000);

afterAll(async () => { await c2?.end(); await c?.end(); await epg?.stop(); });

beforeEach(async () => {
  // clearing a kill is deliberately impossible through SQL — the harness resets the sanctioned
  // way (the same escape the owner's runbook documents)
  await c.query(`ALTER TABLE public.notification_channel_kill_switches DISABLE TRIGGER trg_notif_channel_kill_guard;`);
  await c.query(`DELETE FROM public.notification_channel_kill_switches;`);
  await c.query(`ALTER TABLE public.notification_channel_kill_switches ENABLE TRIGGER trg_notif_channel_kill_guard;`);
  await c.query(`DELETE FROM public.notification_outbox;`);
  await c.query(`DELETE FROM public.academy_notification_restrictions;`);
});

describe('admin_activate_channel_kill — the only write, admin-checked, request-id idempotent', () => {
  it('fail-closed: anonymous and non-admin callers are refused; admin succeeds', async () => {
    await expect(adminKill(c2, null)).rejects.toThrow(/platform admin only/);
    await expect(adminKill(c2, PLAYER)).rejects.toThrow(/platform admin only/);
    expect(await adminKill(c2, ADMIN)).toBe('killed');
    const row = (await c.query(`SELECT * FROM public.notification_channel_kill_switches WHERE channel='email'`)).rows[0];
    expect(row.activated_by).toBe(ADMIN);
    expect(row.reason).toBe('ops decided');
  });

  it('an exact request replay returns the same verdict; a reused id on another channel is refused', async () => {
    const req = crypto.randomUUID();
    expect(await adminKill(c2, ADMIN, 'email', req)).toBe('killed');
    expect(await adminKill(c2, ADMIN, 'email', req)).toBe('killed');   // network-retry replay
    // a reused id carrying a DIFFERENT decision (other reason) is refused — an id names ONE decision
    await expect(adminKill(c2, ADMIN, 'email', req, 'some other reason')).rejects.toThrow(/different decision/);
    await expect(adminKill(c2, ADMIN, 'whatsapp', req)).rejects.toThrow(/already used for a different decision/);
    expect((await c.query(`SELECT count(*)::int n FROM public.notification_channel_kill_switches`)).rows[0].n).toBe(1);
  });

  it("a second, different kill request on an already-killed channel is 'already_killed' — the FIRST evidence stands", async () => {
    const req1 = crypto.randomUUID();
    await adminKill(c2, ADMIN, 'email', req1, 'first reason');
    expect(await adminKill(c2, ADMIN, 'email', crypto.randomUUID(), 'second reason')).toBe('already_killed');
    const row = (await c.query(`SELECT reason, request_id FROM public.notification_channel_kill_switches WHERE channel='email'`)).rows[0];
    expect(row.reason).toBe('first reason');
    expect(row.request_id).toBe(req1);
  });

  it('reason and channel are validated', async () => {
    await expect(adminKill(c2, ADMIN, 'email', undefined, 'x')).rejects.toThrow(/reason/);
    await expect(adminKill(c2, ADMIN, 'push')).rejects.toThrow(/unknown channel/);
  });
});

describe('SET-ONLY, owner-effectively — nothing clears a kill', () => {
  it('UPDATE, DELETE and TRUNCATE are refused even as the owner', async () => {
    await killDirect();
    await expect(c.query(`UPDATE public.notification_channel_kill_switches SET reason = 'edited' WHERE channel='email'`))
      .rejects.toThrow(/SET-ONLY/);
    await expect(c.query(`DELETE FROM public.notification_channel_kill_switches WHERE channel='email'`))
      .rejects.toThrow(/SET-ONLY/);
    await expect(c.query(`TRUNCATE public.notification_channel_kill_switches`))
      .rejects.toThrow(/SET-ONLY/);
  });

  it('NO function in the schema can clear or deactivate a kill — the catalog proves the absence', async () => {
    const fns = (await c.query(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind = 'f'
        AND (p.proname ILIKE '%kill%' OR pg_get_functiondef(p.oid) ILIKE '%notification_channel_kill_switches%')
    `)).rows.map((r) => r.proname as string).sort();
    // the COMPLETE kill surface: gate, read, set, release, guard — and nothing shaped like a clear
    expect(fns).toEqual([
      'admin_activate_channel_kill',
      'is_notification_channel_killed',
      'notif_channel_kill_gate',
      'notif_channel_kill_guard',
      'release_notification_claims_on_kill',
    ]);
    for (const f of fns) {
      expect(f).not.toMatch(/clear|deactivate|remove|unkill|resume|enable/);
    }
    // and none of them contains a DELETE or reason-updating UPDATE against the kill table
    for (const f of ['admin_activate_channel_kill', 'notif_channel_kill_gate', 'is_notification_channel_killed', 'release_notification_claims_on_kill']) {
      const def = (await c.query(`SELECT pg_get_functiondef(p.oid) d FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1`, [f])).rows[0].d as string;
      expect(def, `${f} must not delete from the kill table`).not.toMatch(/DELETE\s+FROM\s+public\.notification_channel_kill_switches/i);
      expect(def, `${f} must not update the kill table`).not.toMatch(/UPDATE\s+public\.notification_channel_kill_switches/i);
    }
  });
});

describe('the claim gate — FIRST, with ZERO ledger mutations on a killed channel', () => {
  it('a live channel claims normally (sanity), and the reap works', async () => {
    const fresh = await seedRow();
    const reapable = await seedRow({ status: 'processing', locked_at: new Date(Date.now() - 30 * 60_000).toISOString(), locked_by: 'w:dead', attempts: 3, max_attempts: 3 });
    const rows = await claim(c);
    expect(rows.map((r) => r.outbox_id)).toEqual([fresh]);
    expect((await rowOf(reapable)).status).toBe('failed');       // reaped: out of retries + stale
  });

  it('killed: the claim returns EMPTY and the reapable row is UNTOUCHED — no cap-cancel, no reap, no claim', async () => {
    const fresh = await seedRow();
    const reapable = await seedRow({ status: 'processing', locked_at: new Date(Date.now() - 30 * 60_000).toISOString(), locked_by: 'w:dead', attempts: 3, max_attempts: 3 });
    await killDirect('email');
    expect(await claim(c)).toEqual([]);
    const f = await rowOf(fresh);
    expect(f.status).toBe('pending');
    expect(f.attempts).toBe(0);                                   // the claim increment never happened
    expect((await rowOf(reapable)).status).toBe('processing');    // the reap did NOT run — zero mutations
  });

  it('killed: even a cap-cancellable restricted row is untouched — the cap-cancel is also gated', async () => {
    const acadId = crypto.randomUUID();
    await c.query(`INSERT INTO public.academy_profiles (id) VALUES ($1)`, [acadId]);
    await c.query(`INSERT INTO public.academy_notification_restrictions (academy_profile_id, event_type, channel, max_frequency) VALUES ($1,'ev_test','email','off')`, [acadId]);
    const restricted = (await c.query(
      `INSERT INTO public.notification_outbox (channel, event_type, template_key, status, destination_normalized, scheduled_for, tenant_academy_profile_id, payload, idempotency_key, recipient_user_id)
       VALUES ('email','ev_test','tpl','pending','a@example.com', now() - interval '1 minute', $1, '{}'::jsonb, gen_random_uuid()::text, '22222222-2222-4222-8222-222222222222') RETURNING id`, [acadId])).rows[0].id;
    await killDirect('email');
    expect(await claim(c)).toEqual([]);
    expect((await rowOf(restricted)).status).toBe('pending');     // not even skipped: NO mutations
    // …and once un-killed (runbook reset), the same claim cap-cancels it — proving the seed was live
    await c.query(`ALTER TABLE public.notification_channel_kill_switches DISABLE TRIGGER trg_notif_channel_kill_guard;`);
    await c.query(`DELETE FROM public.notification_channel_kill_switches;`);
    await c.query(`ALTER TABLE public.notification_channel_kill_switches ENABLE TRIGGER trg_notif_channel_kill_guard;`);
    await claim(c);
    expect((await rowOf(restricted)).status).toBe('skipped');
  });

  it('channels are independent: a whatsapp kill leaves the email claim live', async () => {
    const fresh = await seedRow();
    await killDirect('whatsapp');
    expect((await claim(c)).map((r) => r.outbox_id)).toEqual([fresh]);
  });

  it('DETERMINISTIC kill-vs-claim, direction 1: the kill BLOCKS behind an in-flight claim, the NEXT claim refuses', async () => {
    await seedRow();
    await c.query('BEGIN');
    const first = await c.query(`SELECT * FROM public.claim_notification_outbox_batch('email','w:race',20,15)`);
    expect(first.rows.length).toBe(1);
    let settled = false;
    const killer = adminKill(c2, ADMIN, 'email').finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false);            // the kill waits out the claim transaction
    await c.query('COMMIT');
    expect(await killer).toBe('killed');
    await seedRow();
    expect(await claim(c)).toEqual([]);     // strictly-after: the next claim sees the kill
  });

  it('DETERMINISTIC kill-vs-claim, direction 2: a claim BLOCKS behind an in-flight kill, then refuses', async () => {
    await seedRow();
    await c.query('BEGIN');
    await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [ADMIN]);
    await c.query(`SELECT public.admin_activate_channel_kill('email','race test',$1)`, [crypto.randomUUID()]);
    let settled = false;
    const claimer = claim(c2, 'w:race2').finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false);            // the claim waits behind the uncommitted kill
    await c.query('COMMIT');
    expect(await claimer).toEqual([]);      // …and refuses once it lands
  });
});

describe('the pre-provider re-check and the admin RPC under concurrency — deterministic', () => {
  it('is_notification_channel_killed WAITS OUT an uncommitted kill, then answers true — never races past it', async () => {
    // the round-2 P1: a lock-free read could not see the admin's uncommitted kill INSERT and
    // answered false while the kill transaction was open — the worker reached the provider.
    await c.query('BEGIN');
    await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [ADMIN]);
    await c.query(`SELECT public.admin_activate_channel_kill('email','race kill',$1)`, [crypto.randomUUID()]);
    let settled = false;
    const check = c2.query(`SELECT public.is_notification_channel_killed('email') AS k`)
      .finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false);                 // provably serialized behind the open kill
    await c.query('COMMIT');
    expect((await check).rows[0].k).toBe(true);  // …and sees the committed truth
  });

  it('two CONCURRENT identical kill requests CONVERGE on killed — the loser replays, never diverges', async () => {
    const req = crypto.randomUUID();
    await c.query('BEGIN');
    await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [ADMIN]);
    expect((await c.query(`SELECT public.admin_activate_channel_kill('email','ops decided',$1) AS r`, [req])).rows[0].r).toBe('killed');
    let settled = false;
    const loser = adminKill(c2, ADMIN, 'email', req, 'ops decided').finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false);                 // serialized on the REQUEST lock
    await c.query('COMMIT');
    expect(await loser).toBe('killed');          // exact replay — NOT 'already_killed'
  });
});


describe('release_notification_claims_on_kill — defer, never terminal, never budget burn', () => {
  it('releases the claiming worker’s rows: pending again, the attempt increment undone, a backoff set', async () => {
    const id = await seedRow();
    const rows = await claim(c, 'w:mine');
    expect(rows.length).toBe(1);
    expect((await rowOf(id)).attempts).toBe(1);                   // the claim charged an attempt
    const n = (await c.query(`SELECT public.release_notification_claims_on_kill('email','w:mine') AS n`)).rows[0].n;
    expect(n).toBe(1);
    const r = await rowOf(id);
    expect(r.status).toBe('pending');
    expect(r.attempts).toBe(0);                                   // …and the release gave it back
    expect(r.locked_by).toBeNull();
    expect(new Date(r.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
  });

  it('token-guarded: another worker’s token releases NOTHING', async () => {
    const id = await seedRow();
    await claim(c, 'w:mine');
    expect((await c.query(`SELECT public.release_notification_claims_on_kill('email','w:other') AS n`)).rows[0].n).toBe(0);
    expect((await rowOf(id)).status).toBe('processing');
  });

  it('digest members are structurally out of scope', async () => {
    const dig = await seedRow({ status: 'processing', locked_by: 'w:mine', locked_at: new Date().toISOString(), attempts: 1, delivery_mode: 'digest' });
    expect((await c.query(`SELECT public.release_notification_claims_on_kill('email','w:mine') AS n`)).rows[0].n).toBe(0);
    expect((await rowOf(dig)).status).toBe('processing');
  });
});

describe('ACLs', () => {
  it('the read and the release are service-role paths; the kill table itself is reachable by NO api role', async () => {
    const as = async (role: string, sql: string) => {
      await c2.query(`SET ROLE ${role}`);
      try { await c2.query(sql); return null; }
      catch (e) { return (e as { code?: string }).code ?? 'error'; }
      finally { await c2.query(`RESET ROLE`); }
    };
    expect(await as('anon', `SELECT public.is_notification_channel_killed('email')`)).toBe('42501');
    expect(await as('authenticated', `SELECT public.is_notification_channel_killed('email')`)).toBe('42501');
    expect(await as('service_role', `SELECT public.is_notification_channel_killed('email')`)).toBeNull();
    expect(await as('anon', `SELECT public.release_notification_claims_on_kill('email','w')`)).toBe('42501');
    expect(await as('service_role', `SELECT * FROM public.notification_channel_kill_switches`)).toBe('42501');
    expect(await as('authenticated', `INSERT INTO public.notification_channel_kill_switches (channel, reason, request_id) VALUES ('email','x y z', gen_random_uuid())`)).toBe('42501');
  });
});
