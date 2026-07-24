// @vitest-environment node
// PR 10c-a1 — digest SCHEMA FOUNDATION (ADR 0008). Loads the real migration 20261002100000 over minimal
// stubs of the two base tables it ALTERs, then proves tables/FKs/constraints/triggers/ACLs BEHAVE. CI's
// `supabase db reset` additionally validates the whole chain on real Postgres; this suite pins the
// authorization/immutability/lifecycle/referential behaviour (incl. the pg_trigger_depth() discrimination
// and grant-based DELETE denial under a BYPASSRLS service_role, matching Supabase).
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;
let seq = 0;

const NEW_TABLES = [
  'notification_worker_runs', 'notification_digest_groups', 'notification_digest_attempts',
  'notification_digest_group_attempts', 'notification_provider_events', 'notification_provider_circuit',
  'notification_send_counters', 'notification_send_reservations',
];
const AUDIT_APPEND_ONLY = ['notification_digest_group_attempts', 'notification_provider_events'];
const TERMINAL = `'sent'`;

// ── fixture helpers (run as the superuser/owner; specific deny-tests SET ROLE service_role) ─────────────
async function newGroup(over: Record<string, string> = {}): Promise<string> {
  seq += 1;
  const cols: Record<string, string> = {
    canonical_group_key: `'["k${seq}"]'::jsonb`, group_key_hash: `'h${seq}'`,
    channel: `'email'`, event_type: `'ev'`, recipient_key: `'p:x'`, destination_fingerprint: `'df'`,
    recipient_timezone: `'Europe/Amsterdam'`, digest_boundary_at: 'now()', available_at: 'now()', ...over,
  };
  const r = await db.query<{ id: string }>(
    `INSERT INTO public.notification_digest_groups (${Object.keys(cols).join(',')})
     VALUES (${Object.values(cols).join(',')}) RETURNING id`);
  return r.rows[0].id;
}
async function newAttempt(gid: string, over: Record<string, string> = {}): Promise<string> {
  seq += 1;
  const cols: Record<string, string> = {
    digest_group_id: `'${gid}'`, worker_run_id: 'NULL', provider_idempotency_key: `'idem-${seq}'`, ...over,
  };
  const r = await db.query<{ attempt_id: string }>(
    `INSERT INTO public.notification_digest_attempts (${Object.keys(cols).join(',')})
     VALUES (${Object.values(cols).join(',')}) RETURNING attempt_id`);
  return r.rows[0].attempt_id;
}
async function newRun(): Promise<string> {
  seq += 1;
  const r = await db.query<{ run_id: string }>(
    `INSERT INTO public.notification_worker_runs (worker, channel, phase) VALUES ('w','email','dispatch') RETURNING run_id`);
  return r.rows[0].run_id;
}
// a coherently-old finished run: started 201 days ago, ended 200 days ago (ended_at >= started_at, > 90d old)
async function oldFinishedRun(): Promise<string> {
  seq += 1;
  const r = await db.query<{ run_id: string }>(
    `INSERT INTO public.notification_worker_runs (worker, channel, phase, started_at)
     VALUES ('w','email','dispatch', now()-interval '201 days') RETURNING run_id`);
  const run = r.rows[0].run_id;
  await db.query(`UPDATE public.notification_worker_runs SET status='succeeded', ended_at=now()-interval '200 days' WHERE run_id='${run}'`);
  return run;
}
// terminal_at is guard-owned and cannot be backdated by a caller, so to simulate a 200-day-old terminal
// group we briefly disable the guard (a superuser/DDL power the app never has) and set it directly.
async function makeGroupTerminalOld(gid: string): Promise<void> {
  await db.exec(`ALTER TABLE public.notification_digest_groups DISABLE TRIGGER trg_digest_groups_guard;
    UPDATE public.notification_digest_groups SET state='sent', terminal_at=now()-interval '200 days' WHERE id='${gid}';
    ALTER TABLE public.notification_digest_groups ENABLE TRIGGER trg_digest_groups_guard;`);
}
async function asServiceRole<T>(sql: string): Promise<T> {
  await db.exec('SET ROLE service_role');
  try { return (await db.query(sql)) as T; }
  finally { await db.exec('RESET ROLE'); }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE public.notification_event_types (key text PRIMARY KEY, supports_digest boolean NOT NULL DEFAULT false);
    CREATE TABLE public.notification_outbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      channel text NOT NULL DEFAULT 'email',
      status text NOT NULL DEFAULT 'pending',
      CONSTRAINT notification_outbox_status_check CHECK (status IN
        ('pending','processing','sent','delivered','failed','skipped','cancelled')));
  `);
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations',
    '20261002100000_notification_digest_schema_foundation.sql'), 'utf8'));
});

describe('10c-a1 digest schema — tables + kill switch', () => {
  it('creates all 8 digest tables', async () => {
    const r = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_tables
      WHERE schemaname='public' AND tablename = ANY($1)`, [NEW_TABLES])).rows[0];
    expect(r.n).toBe(8);
  });

  it('adds the outbox snapshot columns + delivery_unknown status; digest_item_bytes nonnegative', async () => {
    const cols = (await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='notification_outbox'`)).rows.map((c) => c.column_name);
    for (const c of ['delivery_mode', 'recipient_key', 'digest_frequency', 'group_locale', 'recipient_timezone',
      'digest_boundary_at', 'template_version', 'destination_fingerprint', 'digest_item', 'digest_item_bytes', 'digest_group_id']) {
      expect(cols, c).toContain(c);
    }
    await expect(db.query(`INSERT INTO public.notification_outbox (status) VALUES ('delivery_unknown')`)).resolves.toBeTruthy();
    await expect(db.query(`INSERT INTO public.notification_outbox (status) VALUES ('bogus')`)).rejects.toThrow();
    await expect(db.query(`INSERT INTO public.notification_outbox (status, digest_item_bytes) VALUES ('pending',-1)`)).rejects.toThrow();
  });

  it('digest_engine_enabled defaults false and requires supports_digest (catalog kill switch)', async () => {
    await db.query(`INSERT INTO public.notification_event_types (key, supports_digest) VALUES ('ok', true)`);
    const d = (await db.query<{ digest_engine_enabled: boolean }>(
      `SELECT digest_engine_enabled FROM public.notification_event_types WHERE key='ok'`)).rows[0];
    expect(d.digest_engine_enabled).toBe(false);
    await expect(db.query(`INSERT INTO public.notification_event_types (key, supports_digest, digest_engine_enabled)
      VALUES ('bad', false, true)`)).rejects.toThrow();
    await expect(db.query(`INSERT INTO public.notification_event_types (key, supports_digest, digest_engine_enabled)
      VALUES ('good', true, true)`)).resolves.toBeTruthy();
  });
});

describe('10c-a1 digest schema — ACL, RLS, and NO delete grant anywhere', () => {
  it('anon + authenticated are denied ALL of SELECT/INSERT/UPDATE/DELETE on every digest table', async () => {
    for (const t of NEW_TABLES) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        for (const role of ['anon', 'authenticated']) {
          const r = (await db.query<{ ok: boolean }>(
            `SELECT has_table_privilege('${role}','public.${t}','${priv}') AS ok`)).rows[0];
          expect(r.ok, `${role} ${priv} ${t}`).toBe(false);
        }
      }
    }
  });

  it('service_role has SELECT everywhere but DELETE NOWHERE (deletion is retention-only)', async () => {
    for (const t of NEW_TABLES) {
      const r = (await db.query<{ sel: boolean; del: boolean }>(`
        SELECT has_table_privilege('service_role','public.${t}','SELECT') AS sel,
               has_table_privilege('service_role','public.${t}','DELETE') AS del`)).rows[0];
      expect(r.sel, `${t} select`).toBe(true);
      expect(r.del, `${t} delete`).toBe(false);
    }
  });

  it('append-only audit tables deny even UPDATE to service_role; attempts allow UPDATE (record) not DELETE', async () => {
    for (const t of AUDIT_APPEND_ONLY) {
      const r = (await db.query<{ upd: boolean }>(`SELECT has_table_privilege('service_role','public.${t}','UPDATE') AS upd`)).rows[0];
      expect(r.upd, `${t} update`).toBe(false);
    }
    const a = (await db.query<{ upd: boolean; del: boolean }>(`
      SELECT has_table_privilege('service_role','public.notification_digest_attempts','UPDATE') AS upd,
             has_table_privilege('service_role','public.notification_digest_attempts','DELETE') AS del`)).rows[0];
    expect(a.upd).toBe(true); expect(a.del).toBe(false);
  });

  it('every digest table has RLS enabled + FORCED and ZERO policies', async () => {
    for (const t of NEW_TABLES) {
      const c = (await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = ('public.'||$1)::regclass`, [t])).rows[0];
      expect(c.relrowsecurity, `${t} RLS`).toBe(true);
      expect(c.relforcerowsecurity, `${t} FORCE`).toBe(true);
      const p = (await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='public' AND tablename=$1`, [t])).rows[0];
      expect(p.n, `${t} policies`).toBe(0);
    }
  });

  it('the spoofable app.digest_purge GUC helper is GONE (no notif_digest_purge_active function)', async () => {
    const r = (await db.query<{ reg: string | null }>(`SELECT to_regprocedure('public.notif_digest_purge_active()')::text AS reg`)).rows[0];
    expect(r.reg).toBeNull();
  });
});

describe('10c-a1 digest schema — attempt lifecycle guard', () => {
  it('attempts are born unrecorded: pre-recorded or pre-outcome inserts are rejected', async () => {
    const g = await newGroup();
    await expect(db.query(`INSERT INTO public.notification_digest_attempts
      (digest_group_id, provider_idempotency_key, recorded_at) VALUES ('${g}','k',now())`)).rejects.toThrow();
    await expect(db.query(`INSERT INTO public.notification_digest_attempts
      (digest_group_id, provider_idempotency_key, outcome_class) VALUES ('${g}','k','accepted')`)).rejects.toThrow();
    await expect(db.query(`INSERT INTO public.notification_digest_attempts
      (digest_group_id, provider_idempotency_key, provider_message_id) VALUES ('${g}','k','msg')`)).rejects.toThrow();
  });

  it('a top-level update that does not set recorded_at is rejected (pre-record outcome mutation)', async () => {
    const g = await newGroup(); const a = await newAttempt(g);
    await expect(db.query(`UPDATE public.notification_digest_attempts SET outcome_class='accepted' WHERE attempt_id='${a}'`)).rejects.toThrow();
  });

  it('recording requires a non-null outcome_class and happens exactly once', async () => {
    const g = await newGroup(); const a = await newAttempt(g);
    await expect(db.query(`UPDATE public.notification_digest_attempts SET recorded_at=now() WHERE attempt_id='${a}'`)).rejects.toThrow();
    await expect(db.query(`UPDATE public.notification_digest_attempts
      SET recorded_at=now(), outcome_class='accepted', http_status=202 WHERE attempt_id='${a}'`)).resolves.toBeTruthy();
    await expect(db.query(`UPDATE public.notification_digest_attempts SET outcome_class='terminal' WHERE attempt_id='${a}'`)).rejects.toThrow();
  });

  it('worker_run_id + identity/request fields are immutable; direct delete forbidden', async () => {
    const g = await newGroup(); const run = await newRun(); const a = await newAttempt(g);
    await expect(db.query(`UPDATE public.notification_digest_attempts
      SET recorded_at=now(), outcome_class='accepted', worker_run_id='${run}' WHERE attempt_id='${a}'`)).rejects.toThrow();
    await expect(db.query(`UPDATE public.notification_digest_attempts
      SET recorded_at=now(), outcome_class='accepted', provider_idempotency_key='hacked' WHERE attempt_id='${a}'`)).rejects.toThrow();
    await expect(db.query(`DELETE FROM public.notification_digest_attempts WHERE attempt_id='${a}'`)).rejects.toThrow();
  });
});

describe('10c-a1 digest schema — worker-run lifecycle guard', () => {
  it('runs are born unfinished: inserting an already-finished run is rejected', async () => {
    await expect(db.query(`INSERT INTO public.notification_worker_runs (worker, channel, phase, status, ended_at)
      VALUES ('w','email','dispatch','succeeded',now())`)).rejects.toThrow();
  });

  it('finishes exactly once, valid status AND ended_at together; status-only + identity change rejected', async () => {
    const run = await newRun();
    await expect(db.query(`UPDATE public.notification_worker_runs SET status='succeeded' WHERE run_id='${run}'`)).rejects.toThrow();
    await expect(db.query(`UPDATE public.notification_worker_runs SET ended_at=now() WHERE run_id='${run}'`)).rejects.toThrow();
    await expect(db.query(`UPDATE public.notification_worker_runs SET ended_at=now(), status='succeeded', worker='evil' WHERE run_id='${run}'`)).rejects.toThrow();
    await expect(db.query(`UPDATE public.notification_worker_runs SET ended_at=now(), status='succeeded' WHERE run_id='${run}'`)).resolves.toBeTruthy();
    await expect(db.query(`UPDATE public.notification_worker_runs SET status='failed' WHERE run_id='${run}'`)).rejects.toThrow();
  });

  it('a run cannot end before it starts (temporal validity)', async () => {
    const run = await newRun(); // started_at defaults to now()
    await expect(db.query(`UPDATE public.notification_worker_runs
      SET status='succeeded', ended_at=now()-interval '1 day' WHERE run_id='${run}'`)).rejects.toThrow(/before it starts/i);
    await expect(db.query(`UPDATE public.notification_worker_runs
      SET status='succeeded', ended_at=now() WHERE run_id='${run}'`)).resolves.toBeTruthy();
  });

  it('an unfinished run cannot be deleted; a fresh finished run cannot; a >90-day finished run can', async () => {
    const running = await newRun();
    await expect(db.query(`DELETE FROM public.notification_worker_runs WHERE run_id='${running}'`)).rejects.toThrow(/unfinished/i);
    const fresh = await newRun();
    await db.query(`UPDATE public.notification_worker_runs SET status='succeeded', ended_at=now() WHERE run_id='${fresh}'`);
    await expect(db.query(`DELETE FROM public.notification_worker_runs WHERE run_id='${fresh}'`)).rejects.toThrow(/retention age/i);
    const done = await oldFinishedRun();
    await expect(db.query(`DELETE FROM public.notification_worker_runs WHERE run_id='${done}'`)).resolves.toBeTruthy();
  });
});

describe('10c-a1 digest schema — append-only audit tables', () => {
  it('ledger + provider_events reject direct UPDATE and direct DELETE', async () => {
    const g = await newGroup();
    const e = (await db.query<{ event_id: string }>(`INSERT INTO public.notification_digest_group_attempts
      (digest_group_id, action) VALUES ('${g}','materialized') RETURNING event_id`)).rows[0].event_id;
    await expect(db.query(`UPDATE public.notification_digest_group_attempts SET action='sent' WHERE event_id='${e}'`)).rejects.toThrow();
    await expect(db.query(`DELETE FROM public.notification_digest_group_attempts WHERE event_id='${e}'`)).rejects.toThrow();
    await db.query(`UPDATE public.notification_digest_groups SET provider_message_id='pm-ao' WHERE id='${g}'`);
    await db.query(`INSERT INTO public.notification_provider_events (resend_event_id, provider_message_id, digest_group_id, status, occurred_at)
      VALUES ('re-ao','pm-ao','${g}','delivered', now())`);
    await expect(db.query(`UPDATE public.notification_provider_events SET status='bounced' WHERE resend_event_id='re-ao'`)).rejects.toThrow();
    await expect(db.query(`DELETE FROM public.notification_provider_events WHERE resend_event_id='re-ao'`)).rejects.toThrow();
  });
});

describe('10c-a1 digest schema — controlled + bounded retention', () => {
  it('service_role cannot DELETE groups/runs directly even with a spoofed GUC in the statement', async () => {
    const g = await newGroup({ state: TERMINAL });
    const run = await oldFinishedRun();
    await expect(asServiceRole(`DELETE FROM public.notification_digest_groups WHERE id='${g}'`)).rejects.toThrow(/permission denied/i);
    await expect(asServiceRole(
      `DELETE FROM public.notification_worker_runs WHERE run_id='${run}' AND set_config('app.digest_purge','on',true) IS NOT NULL`))
      .rejects.toThrow(/permission denied/i);
  });

  it('a non-terminal group cannot be deleted; only terminal, retention-eligible groups leave', async () => {
    const active = await newGroup({ state: `'sending'` });
    await expect(db.query(`DELETE FROM public.notification_digest_groups WHERE id='${active}'`)).rejects.toThrow(/not terminal/i);
  });

  it('enforces the ADR policy windows (group>=90, counter>=35) and a hard limit cap (fail closed)', async () => {
    await expect(db.query(`SELECT public.purge_notification_digest(-1, 35, 500)`)).rejects.toThrow();
    await expect(db.query(`SELECT public.purge_notification_digest(89, 35, 500)`)).rejects.toThrow();   // < 90
    await expect(db.query(`SELECT public.purge_notification_digest(90, 34, 500)`)).rejects.toThrow();   // < 35
    await expect(db.query(`SELECT public.purge_notification_digest(90, 35, 0)`)).rejects.toThrow();     // limit < 1
    await expect(db.query(`SELECT public.purge_notification_digest(90, 35, 20000)`)).rejects.toThrow(); // limit > 10000
    await expect(db.query(`SELECT public.purge_notification_digest(90, 35, 500)`)).resolves.toBeTruthy();
  });

  it('an old-but-newly-terminal group survives 90 days; a fresh terminal group cannot be deleted', async () => {
    // Codex repro: an old pending group transitions to terminal — the schema-owned clock starts NOW.
    const g = await newGroup({ state: `'pending'`, updated_at: `now()-interval '200 days'` });
    await db.query(`UPDATE public.notification_digest_groups SET state='sent' WHERE id='${g}'`); // terminal_at := now()
    await db.query(`SELECT public.purge_notification_digest(90, 35, 500)`);
    expect((await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.notification_digest_groups WHERE id='${g}'`)).rows[0].n).toBe(1);
    await expect(db.query(`DELETE FROM public.notification_digest_groups WHERE id='${g}'`)).rejects.toThrow(/retention age/i);
  });

  it('a caller cannot backdate the retention clock by presetting terminal_at at insert', async () => {
    const g = await newGroup({ state: TERMINAL, terminal_at: `now()-interval '200 days'` }); // guard overwrites → now()
    await db.query(`SELECT public.purge_notification_digest(90, 35, 500)`);
    expect((await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.notification_digest_groups WHERE id='${g}'`)).rows[0].n).toBe(1);
  });

  it('purge deletes eligible terminal groups (cascading audit) + finished runs, returning counts', async () => {
    const g = await newGroup();
    const a = await newAttempt(g);
    await db.query(`UPDATE public.notification_digest_groups SET current_attempt_id='${a}' WHERE id='${g}'`);
    await db.query(`INSERT INTO public.notification_digest_group_attempts (digest_group_id, attempt_id, action) VALUES ('${g}','${a}','attempt')`);
    const ob = (await db.query<{ id: string }>(`INSERT INTO public.notification_outbox (status) VALUES ('pending') RETURNING id`)).rows[0].id;
    await db.query(`UPDATE public.notification_outbox SET digest_group_id='${g}' WHERE id='${ob}'`);
    await makeGroupTerminalOld(g);
    await oldFinishedRun(); // an old finished run for the runs_deleted assertion

    const r = (await db.query<{ groups_deleted: number; runs_deleted: number }>(
      `SELECT groups_deleted, runs_deleted FROM public.purge_notification_digest(90, 35, 500)`)).rows[0];
    expect(r.groups_deleted).toBeGreaterThanOrEqual(1);
    expect(r.runs_deleted).toBeGreaterThanOrEqual(1);
    expect((await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.notification_digest_attempts WHERE digest_group_id='${g}'`)).rows[0].n).toBe(0);
    expect((await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.notification_digest_group_attempts WHERE digest_group_id='${g}'`)).rows[0].n).toBe(0);
    // outbox row preserved, relation nulled
    expect((await db.query<{ digest_group_id: string | null }>(`SELECT digest_group_id FROM public.notification_outbox WHERE id='${ob}'`)).rows[0].digest_group_id).toBeNull();
  });
});

describe('10c-a1 digest schema — reservations are never released while uncertain', () => {
  it('counter retention preserves an old counter that still backs a live reserved reservation', async () => {
    const g = await newGroup({ state: `'sending'` }); // non-terminal
    await db.query(`INSERT INTO public.notification_send_counters (counter_key, bucket_kind, bucket_start, cap)
      VALUES ('cpres','day', date_trunc('day', now()-interval '200 days'), 100)`);
    await db.query(`INSERT INTO public.notification_send_reservations (digest_group_id, counter_key, bucket_start, state)
      VALUES ('${g}','cpres', date_trunc('day', now()-interval '200 days'), 'reserved')`);
    await db.query(`SELECT public.purge_notification_digest(90, 35, 500)`);
    expect((await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.notification_send_counters WHERE counter_key='cpres'`)).rows[0].n).toBe(1);
    expect((await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.notification_send_reservations WHERE digest_group_id='${g}'`)).rows[0].n).toBe(1);
  });

  it('a counter cannot be deleted while a reservation references it (RESTRICT, not CASCADE)', async () => {
    const g = await newGroup({ state: `'sending'` });
    await db.query(`INSERT INTO public.notification_send_counters (counter_key, bucket_kind, bucket_start, cap)
      VALUES ('crestrict','hour', date_trunc('hour', now()), 10)`);
    await db.query(`INSERT INTO public.notification_send_reservations (digest_group_id, counter_key, bucket_start, state)
      VALUES ('${g}','crestrict', date_trunc('hour', now()), 'reserved')`);
    await expect(db.query(`DELETE FROM public.notification_send_counters WHERE counter_key='crestrict'`)).rejects.toThrow();
  });
});

describe('10c-a1 digest schema — immutable snapshots + identities', () => {
  it('outbox snapshot fields are write-once and digest_group_id cannot be re-pointed', async () => {
    const g1 = await newGroup(); const g2 = await newGroup();
    const ob = (await db.query<{ id: string }>(`INSERT INTO public.notification_outbox
      (status, delivery_mode, recipient_key, digest_frequency, group_locale, recipient_timezone, digest_boundary_at, template_version, destination_fingerprint)
      VALUES ('pending','digest','p:x','daily','nl','Europe/Amsterdam',now(),1,'df') RETURNING id`)).rows[0].id;
    await expect(db.query(`UPDATE public.notification_outbox SET recipient_key='p:y' WHERE id='${ob}'`)).rejects.toThrow(/write-once/i);
    await expect(db.query(`UPDATE public.notification_outbox SET digest_boundary_at=now()+interval '1 day' WHERE id='${ob}'`)).rejects.toThrow(/write-once/i);
    await expect(db.query(`UPDATE public.notification_outbox SET delivery_mode='instant' WHERE id='${ob}'`)).rejects.toThrow(/write-once/i);
    await expect(db.query(`UPDATE public.notification_outbox SET status='processing' WHERE id='${ob}'`)).resolves.toBeTruthy(); // benign
    await expect(db.query(`UPDATE public.notification_outbox SET digest_group_id='${g1}' WHERE id='${ob}'`)).resolves.toBeTruthy(); // attach (NULL→group)
    await expect(db.query(`UPDATE public.notification_outbox SET digest_group_id='${g2}' WHERE id='${ob}'`)).rejects.toThrow(/retention cascade/i); // re-point
    await expect(db.query(`UPDATE public.notification_outbox SET digest_group_id=NULL WHERE id='${ob}'`)).rejects.toThrow(/retention cascade/i); // top-level detach
    // only the retention cascade (a group delete → outbox FK SET NULL, depth>1) may detach a member:
    await makeGroupTerminalOld(g1);
    await db.query(`SELECT public.purge_notification_digest(90, 35, 500)`);
    expect((await db.query<{ digest_group_id: string | null }>(`SELECT digest_group_id FROM public.notification_outbox WHERE id='${ob}'`)).rows[0].digest_group_id).toBeNull();
  });

  it('group canonical identity + boundary are immutable; provider_message_id is write-once', async () => {
    const g = await newGroup();
    await expect(db.query(`UPDATE public.notification_digest_groups SET canonical_group_key='["hacked"]'::jsonb WHERE id='${g}'`)).rejects.toThrow(/immutable/i);
    await expect(db.query(`UPDATE public.notification_digest_groups SET digest_boundary_at=now()+interval '1 day' WHERE id='${g}'`)).rejects.toThrow(/immutable/i);
    await expect(db.query(`UPDATE public.notification_digest_groups SET recipient_key='p:evil' WHERE id='${g}'`)).rejects.toThrow(/immutable/i);
    await expect(db.query(`UPDATE public.notification_digest_groups SET provider_message_id='pm1' WHERE id='${g}'`)).resolves.toBeTruthy();
    await expect(db.query(`UPDATE public.notification_digest_groups SET provider_message_id='pm2' WHERE id='${g}'`)).rejects.toThrow(/write-once/i);
    await expect(db.query(`UPDATE public.notification_digest_groups SET available_at=now()+interval '1 hour' WHERE id='${g}'`)).resolves.toBeTruthy(); // mutable
  });

  it('reservation origin (attempt_id write-once, bucket immutable) is enforced', async () => {
    const g = await newGroup(); const a1 = await newAttempt(g); const a2 = await newAttempt(g);
    await db.query(`INSERT INTO public.notification_send_counters (counter_key, bucket_kind, bucket_start, cap) VALUES ('cimm','hour',date_trunc('hour',now()),10)`);
    await db.query(`INSERT INTO public.notification_send_reservations (digest_group_id, counter_key, attempt_id, bucket_start, state)
      VALUES ('${g}','cimm','${a1}',date_trunc('hour',now()),'reserved')`);
    await expect(db.query(`UPDATE public.notification_send_reservations SET attempt_id='${a2}' WHERE digest_group_id='${g}' AND counter_key='cimm'`)).rejects.toThrow(/write-once/i);
    await expect(db.query(`UPDATE public.notification_send_reservations SET bucket_start=now()+interval '1 hour' WHERE digest_group_id='${g}' AND counter_key='cimm'`)).rejects.toThrow(/immutable/i);
    await expect(db.query(`UPDATE public.notification_send_reservations SET state='committed' WHERE digest_group_id='${g}' AND counter_key='cimm'`)).resolves.toBeTruthy(); // mutable
  });
});

describe('10c-a1 digest schema — cross-table referential identity', () => {
  it('a ledger row cannot reference an attempt from a different group', async () => {
    const ga = await newGroup(); const gb = await newGroup(); const a = await newAttempt(ga);
    await expect(db.query(`INSERT INTO public.notification_digest_group_attempts (digest_group_id, attempt_id, action)
      VALUES ('${gb}','${a}','attempt')`)).rejects.toThrow();
    await expect(db.query(`INSERT INTO public.notification_digest_group_attempts (digest_group_id, attempt_id, action)
      VALUES ('${ga}','${a}','attempt')`)).resolves.toBeTruthy();
  });

  it('a provider event can only link to the group whose provider_message_id it carries', async () => {
    const g = await newGroup(); await db.query(`UPDATE public.notification_digest_groups SET provider_message_id='pm-match' WHERE id='${g}'`);
    await expect(db.query(`INSERT INTO public.notification_provider_events (resend_event_id, provider_message_id, digest_group_id, status, occurred_at)
      VALUES ('re-wrong','pm-other','${g}','sent',now())`)).rejects.toThrow();
    await expect(db.query(`INSERT INTO public.notification_provider_events (resend_event_id, provider_message_id, digest_group_id, status, occurred_at)
      VALUES ('re-right','pm-match','${g}','sent',now())`)).resolves.toBeTruthy();
    await expect(db.query(`INSERT INTO public.notification_provider_events (resend_event_id, provider_message_id, status, occurred_at)
      VALUES ('re-orphan','pm-anything','delivered',now())`)).resolves.toBeTruthy(); // orphan (no group) allowed
  });

  it('purging a probe group clears BOTH probe_group_id and probe_attempt_id atomically', async () => {
    const g = await newGroup();
    const a = await newAttempt(g);
    await db.query(`INSERT INTO public.notification_provider_circuit (channel, state, probe_group_id, probe_attempt_id)
      VALUES ('email-probe','half_open','${g}','${a}')`);
    await makeGroupTerminalOld(g);
    await db.query(`SELECT public.purge_notification_digest(90, 35, 500)`);
    const c = (await db.query<{ probe_group_id: string | null; probe_attempt_id: string | null }>(
      `SELECT probe_group_id, probe_attempt_id FROM public.notification_provider_circuit WHERE channel='email-probe'`)).rows[0];
    expect(c.probe_group_id).toBeNull();
    expect(c.probe_attempt_id).toBeNull();
  });

  it('superseded_by has a real FK and SET-NULLs when the superseding group is purged', async () => {
    const sup = await newGroup();
    const child = await newGroup({ state: `'pending'` });
    await expect(db.query(`UPDATE public.notification_digest_groups SET superseded_by='99999999-0000-0000-0000-000000000000' WHERE id='${child}'`)).rejects.toThrow();
    await db.query(`UPDATE public.notification_digest_groups SET superseded_by='${sup}' WHERE id='${child}'`);
    await makeGroupTerminalOld(sup);
    await db.query(`SELECT public.purge_notification_digest(90, 35, 500)`);
    const c = (await db.query<{ superseded_by: string | null }>(`SELECT superseded_by FROM public.notification_digest_groups WHERE id='${child}'`)).rows[0];
    expect(c.superseded_by).toBeNull();
  });

  it('a reservation bucket_start must match its counter bucket_start', async () => {
    const g = await newGroup();
    await db.query(`INSERT INTO public.notification_send_counters (counter_key, bucket_kind, bucket_start, cap) VALUES ('cbucket','hour',date_trunc('hour',now()),10)`);
    await expect(db.query(`INSERT INTO public.notification_send_reservations (digest_group_id, counter_key, bucket_start, state)
      VALUES ('${g}','cbucket', date_trunc('hour',now())+interval '1 hour', 'reserved')`)).rejects.toThrow();
    await expect(db.query(`INSERT INTO public.notification_send_reservations (digest_group_id, counter_key, bucket_start, state)
      VALUES ('${g}','cbucket', date_trunc('hour',now()), 'reserved')`)).resolves.toBeTruthy();
  });
});

describe('10c-a1 digest schema — provider-event orphan-then-link lifecycle', () => {
  it('an orphan links to its matching group exactly once, via the RPC, then is immutable', async () => {
    const g = await newGroup(); await db.query(`UPDATE public.notification_digest_groups SET provider_message_id='pm-link' WHERE id='${g}'`);
    await db.query(`INSERT INTO public.notification_provider_events (resend_event_id, provider_message_id, status, occurred_at)
      VALUES ('orph-1','pm-link','delivered',now())`); // arrives before correlation (digest_group_id NULL)
    await expect(db.query(`SELECT public.link_notification_provider_event('orph-1','${g}')`)).resolves.toBeTruthy();
    expect((await db.query<{ digest_group_id: string | null }>(`SELECT digest_group_id FROM public.notification_provider_events WHERE resend_event_id='orph-1'`)).rows[0].digest_group_id).toBe(g);
    // second re-link rejected
    await expect(db.query(`SELECT public.link_notification_provider_event('orph-1','${g}')`)).rejects.toThrow(/already linked/i);
  });

  it('linking to a group whose provider_message_id does not match the event is rejected', async () => {
    const g = await newGroup(); await db.query(`UPDATE public.notification_digest_groups SET provider_message_id='pm-a' WHERE id='${g}'`);
    await db.query(`INSERT INTO public.notification_provider_events (resend_event_id, provider_message_id, status, occurred_at)
      VALUES ('orph-mismatch','pm-b','delivered',now())`); // event carries pm-b, group has pm-a
    await expect(db.query(`SELECT public.link_notification_provider_event('orph-mismatch','${g}')`)).rejects.toThrow();
  });

  it('service_role cannot link by direct UPDATE (only the SECURITY DEFINER RPC can)', async () => {
    const g = await newGroup(); await db.query(`UPDATE public.notification_digest_groups SET provider_message_id='pm-direct' WHERE id='${g}'`);
    await db.query(`INSERT INTO public.notification_provider_events (resend_event_id, provider_message_id, status, occurred_at)
      VALUES ('orph-direct','pm-direct','delivered',now())`);
    await expect(asServiceRole(`UPDATE public.notification_provider_events SET digest_group_id='${g}' WHERE resend_event_id='orph-direct'`)).rejects.toThrow(/permission denied/i);
  });

  it('a linked event is removed when its group is purged (callback-before-record → correlate → purge)', async () => {
    const g = await newGroup(); await db.query(`UPDATE public.notification_digest_groups SET provider_message_id='pm-purge' WHERE id='${g}'`);
    await db.query(`INSERT INTO public.notification_provider_events (resend_event_id, provider_message_id, status, occurred_at)
      VALUES ('orph-purge','pm-purge','delivered',now())`);
    await db.query(`SELECT public.link_notification_provider_event('orph-purge','${g}')`);
    await makeGroupTerminalOld(g);
    await db.query(`SELECT public.purge_notification_digest(90, 35, 500)`);
    expect((await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.notification_provider_events WHERE resend_event_id='orph-purge'`)).rows[0].n).toBe(0);
  });

  it('stale unlinked orphans are pruned by retention; fresh orphans and direct deletes are not', async () => {
    await db.query(`INSERT INTO public.notification_provider_events (resend_event_id, provider_message_id, status, occurred_at, received_at)
      VALUES ('orph-stale','pm-s','delivered', now()-interval '40 days', now()-interval '40 days')`);
    await db.query(`INSERT INTO public.notification_provider_events (resend_event_id, provider_message_id, status, occurred_at, received_at)
      VALUES ('orph-fresh','pm-f','delivered', now(), now())`);
    await expect(db.query(`DELETE FROM public.notification_provider_events WHERE resend_event_id='orph-fresh'`)).rejects.toThrow(/not yet stale/i);
    const r = (await db.query<{ orphan_events_deleted: number }>(`SELECT orphan_events_deleted FROM public.purge_notification_digest(90, 35, 500)`)).rows[0];
    expect(r.orphan_events_deleted).toBeGreaterThanOrEqual(1);
    expect((await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.notification_provider_events WHERE resend_event_id='orph-stale'`)).rows[0].n).toBe(0);
    expect((await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.notification_provider_events WHERE resend_event_id='orph-fresh'`)).rows[0].n).toBe(1);
  });
});

describe('10c-a1 digest schema — enum + range constraints', () => {
  it('group.state, provider_status, worker phase, ledger action, provider status, outcome reject junk', async () => {
    const g = await newGroup();
    await expect(db.query(`UPDATE public.notification_digest_groups SET state='made_up' WHERE id='${g}'`)).rejects.toThrow();
    await expect(db.query(`INSERT INTO public.notification_worker_runs (worker, channel, phase) VALUES ('w','email','sideways')`)).rejects.toThrow();
    await expect(db.query(`INSERT INTO public.notification_digest_group_attempts (digest_group_id, action) VALUES ('${g}','teleported')`)).rejects.toThrow();
    await db.query(`UPDATE public.notification_digest_groups SET provider_message_id='pm-enum' WHERE id='${g}'`);
    await expect(db.query(`INSERT INTO public.notification_provider_events (resend_event_id, provider_message_id, digest_group_id, status, occurred_at)
      VALUES ('re-enum','pm-enum','${g}','exploded',now())`)).rejects.toThrow();
    const a = await newAttempt(g);
    await expect(db.query(`UPDATE public.notification_digest_attempts SET recorded_at=now(), outcome_class='vibes' WHERE attempt_id='${a}'`)).rejects.toThrow();
  });

  it('provider_status is coupled 1:1 to provider_status_rank', async () => {
    const g = await newGroup();
    await expect(db.query(`UPDATE public.notification_digest_groups SET provider_status='sent', provider_status_rank=3 WHERE id='${g}'`)).rejects.toThrow();
    await expect(db.query(`UPDATE public.notification_digest_groups SET provider_status='delivered', provider_status_rank=3 WHERE id='${g}'`)).resolves.toBeTruthy();
    await expect(db.query(`UPDATE public.notification_digest_groups SET provider_status='complained', provider_status_rank=5 WHERE id='${g}'`)).resolves.toBeTruthy();
  });

  it('enforces the 50-item group maximum and nonnegative counters/bytes/ordinals', async () => {
    await expect(newGroup({ item_count: '51' })).rejects.toThrow();
    await expect(newGroup({ total_item_bytes: '-1' })).rejects.toThrow();
    await expect(newGroup({ chunk_ordinal: '-1' })).rejects.toThrow();
    await expect(newGroup({ max_delivery_budget: '0' })).rejects.toThrow();
    await expect(newGroup({ item_count: '50' })).resolves.toBeTruthy();
    await expect(db.query(`INSERT INTO public.notification_send_counters (counter_key, bucket_kind, bucket_start, used, cap) VALUES ('nu','hour',now(),-1,10)`)).rejects.toThrow();
  });

  it('group (canonical_group_key, chunk_ordinal) + provider_message_id are unique (two distinct groups)', async () => {
    await db.query(`INSERT INTO public.notification_digest_groups
      (canonical_group_key, group_key_hash, channel, event_type, recipient_key, destination_fingerprint, recipient_timezone, digest_boundary_at, available_at)
      VALUES ('["dup"]'::jsonb,'h','email','ev','p:x','df','Europe/Amsterdam',now(),now())`);
    await expect(db.query(`INSERT INTO public.notification_digest_groups
      (canonical_group_key, group_key_hash, channel, event_type, recipient_key, destination_fingerprint, recipient_timezone, digest_boundary_at, available_at)
      VALUES ('["dup"]'::jsonb,'h','email','ev','p:x','df','Europe/Amsterdam',now(),now())`)).rejects.toThrow();
    const g1 = await newGroup(); const g2 = await newGroup();
    await db.query(`UPDATE public.notification_digest_groups SET provider_message_id='shared' WHERE id='${g1}'`);
    await expect(db.query(`UPDATE public.notification_digest_groups SET provider_message_id='shared' WHERE id='${g2}'`)).rejects.toThrow();
  });
});

// ── migration-wide ACL scanner: named-table grants AND schema-wide ALL TABLES grants to public roles ─────
function tableGrantOffenders(sqlFiles: { name: string; sql: string }[]): string[] {
  const offenders: string[] = [];
  const unquote = (s: string) => s.replace(/"/g, '').trim().toLowerCase();
  for (const { name, sql } of sqlFiles) {
    const stripped = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
    for (const raw of stripped.split(';')) {
      const st = raw.replace(/\s+/g, ' ').trim();
      if (!/^GRANT\b/i.test(st)) continue;
      const toIdx = st.toUpperCase().lastIndexOf(' TO ');
      if (toIdx < 0) continue;
      const roles = st.slice(toIdx + 4);
      if (!/(^|[\s,"])(PUBLIC|anon|authenticated)([\s,"]|$)/i.test(roles)) continue;
      const target = st.slice(0, toIdx);
      const schemaWide = target.match(/\bON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+(.+)$/i);
      if (schemaWide) {
        if (schemaWide[1].split(',').map(unquote).includes('public')) { offenders.push(`${name}: ${st}`); continue; }
      }
      if (NEW_TABLES.some((t) => new RegExp(`(^|[\\s.,"])${t}([\\s,"(]|$)`, 'i').test(target))) offenders.push(`${name}: ${st}`);
    }
  }
  return offenders;
}

describe('10c-a1 digest schema — migration-wide ACL guard', () => {
  const allMigrations = () => {
    const dir = join(process.cwd(), 'supabase', 'migrations');
    return readdirSync(dir).filter((x) => x.endsWith('.sql')).map((f) => ({ name: f, sql: readFileSync(join(dir, f), 'utf8') }));
  };
  it('no migration GRANTs a digest table to PUBLIC/anon/authenticated (named or schema-wide)', () => {
    expect(tableGrantOffenders(allMigrations())).toEqual([]);
  });
  it('the scanner catches named, quoted, comma-list and schema-wide offenders (self-test)', () => {
    const synthetic = [
      { name: 'a.sql', sql: `GRANT SELECT ON public.notification_digest_groups TO anon;` },
      { name: 'b.sql', sql: `GRANT ALL ON TABLE "notification_provider_events" TO authenticated;` },
      { name: 'c.sql', sql: `GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;` },
      { name: 'd.sql', sql: `GRANT SELECT ON ALL TABLES IN SCHEMA storage, public TO authenticated;` },
      { name: 'e.sql', sql: `GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO PUBLIC;` },
      { name: 'ok.sql', sql: `GRANT SELECT ON ALL TABLES IN SCHEMA storage TO anon;` },
      { name: 'ok2.sql', sql: `GRANT SELECT ON public.notification_digest_groups TO service_role;` },
    ];
    expect(tableGrantOffenders(synthetic).map((o) => o.split(':')[0]).sort()).toEqual(['a.sql', 'b.sql', 'c.sql', 'd.sql', 'e.sql']);
  });
});
