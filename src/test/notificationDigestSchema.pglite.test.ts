// @vitest-environment node
// PR 10c-a1 — digest SCHEMA FOUNDATION (ADR 0008). Loads the real migration 20261002100000 over minimal
// stubs of the two base tables it ALTERs (notification_event_types, notification_outbox), then proves the
// tables/FKs/constraints/triggers/ACLs exist and BEHAVE. CI's `supabase db reset` additionally validates
// the whole chain on real Postgres; this suite pins the ACL/trigger/constraint/referential behaviour, incl.
// the load-bearing pg_trigger_depth() discrimination (cascade/SET-NULL allowed, direct mutation blocked).
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

// ── fixture helpers ────────────────────────────────────────────────────────
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
async function newRun(over: Record<string, string> = {}): Promise<string> {
  seq += 1;
  const cols: Record<string, string> = { worker: `'w'`, channel: `'email'`, phase: `'dispatch'`, ...over };
  const r = await db.query<{ run_id: string }>(
    `INSERT INTO public.notification_worker_runs (${Object.keys(cols).join(',')})
     VALUES (${Object.values(cols).join(',')}) RETURNING run_id`);
  return r.rows[0].run_id;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
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

  it('adds the outbox snapshot columns (incl digest_group_id) + delivery_unknown status', async () => {
    const cols = (await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='notification_outbox'`)).rows.map((c) => c.column_name);
    for (const c of ['delivery_mode', 'recipient_key', 'digest_frequency', 'group_locale', 'recipient_timezone',
      'digest_boundary_at', 'template_version', 'destination_fingerprint', 'digest_item', 'digest_item_bytes', 'digest_group_id']) {
      expect(cols, c).toContain(c);
    }
    await expect(db.query(`INSERT INTO public.notification_outbox (status) VALUES ('delivery_unknown')`)).resolves.toBeTruthy();
    await expect(db.query(`INSERT INTO public.notification_outbox (status) VALUES ('bogus')`)).rejects.toThrow();
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

  it('outbox.digest_item_bytes must be nonnegative', async () => {
    await expect(db.query(`INSERT INTO public.notification_outbox (status, digest_item_bytes) VALUES ('pending', -1)`)).rejects.toThrow();
  });
});

describe('10c-a1 digest schema — ACL (service-role only) + RLS lockdown', () => {
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

  it('service_role has SELECT on every digest table', async () => {
    for (const t of NEW_TABLES) {
      const r = (await db.query<{ ok: boolean }>(
        `SELECT has_table_privilege('service_role','public.${t}','SELECT') AS ok`)).rows[0];
      expect(r.ok, t).toBe(true);
    }
  });

  it('append-only audit tables grant INSERT/SELECT but NOT UPDATE/DELETE to service_role', async () => {
    for (const t of AUDIT_APPEND_ONLY) {
      const r = (await db.query<{ ins: boolean; upd: boolean; del: boolean }>(`
        SELECT has_table_privilege('service_role','public.${t}','INSERT') AS ins,
               has_table_privilege('service_role','public.${t}','UPDATE') AS upd,
               has_table_privilege('service_role','public.${t}','DELETE') AS del`)).rows[0];
      expect(r.ins, `${t} insert`).toBe(true);
      expect(r.upd, `${t} update`).toBe(false);
      expect(r.del, `${t} delete`).toBe(false);
    }
  });

  it('attempts grant INSERT/SELECT/UPDATE but NOT DELETE to service_role', async () => {
    const r = (await db.query<{ ins: boolean; upd: boolean; del: boolean }>(`
      SELECT has_table_privilege('service_role','public.notification_digest_attempts','INSERT') AS ins,
             has_table_privilege('service_role','public.notification_digest_attempts','UPDATE') AS upd,
             has_table_privilege('service_role','public.notification_digest_attempts','DELETE') AS del`)).rows[0];
    expect(r.ins).toBe(true); expect(r.upd).toBe(true); expect(r.del).toBe(false);
  });

  it('every digest table has RLS enabled + FORCED and ZERO policies', async () => {
    for (const t of NEW_TABLES) {
      const c = (await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = ('public.' || $1)::regclass`, [t])).rows[0];
      expect(c.relrowsecurity, `${t} RLS`).toBe(true);
      expect(c.relforcerowsecurity, `${t} FORCE`).toBe(true);
      const p = (await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='public' AND tablename=$1`, [t])).rows[0];
      expect(p.n, `${t} policy count`).toBe(0);
    }
  });
});

describe('10c-a1 digest schema — attempt lifecycle guard', () => {
  it('a top-level update that does not set recorded_at is rejected (pre-record outcome mutation)', async () => {
    const g = await newGroup(); const a = await newAttempt(g);
    await expect(db.query(
      `UPDATE public.notification_digest_attempts SET outcome_class='accepted' WHERE attempt_id='${a}'`)).rejects.toThrow();
  });

  it('records exactly once (NULL→recorded); re-record is rejected', async () => {
    const g = await newGroup(); const a = await newAttempt(g);
    await expect(db.query(`UPDATE public.notification_digest_attempts
      SET recorded_at=now(), outcome_class='accepted', http_status=202 WHERE attempt_id='${a}'`)).resolves.toBeTruthy();
    await expect(db.query(`UPDATE public.notification_digest_attempts
      SET outcome_class='terminal' WHERE attempt_id='${a}'`)).rejects.toThrow();
  });

  it('worker_run_id is immutable during the record transition', async () => {
    const g = await newGroup(); const run = await newRun(); const a = await newAttempt(g);
    await expect(db.query(`UPDATE public.notification_digest_attempts
      SET recorded_at=now(), worker_run_id='${run}' WHERE attempt_id='${a}'`)).rejects.toThrow();
  });

  it('identity/request fields are immutable', async () => {
    const g = await newGroup(); const a = await newAttempt(g);
    await expect(db.query(`UPDATE public.notification_digest_attempts
      SET recorded_at=now(), provider_idempotency_key='hacked' WHERE attempt_id='${a}'`)).rejects.toThrow();
  });

  it('direct attempt delete is forbidden', async () => {
    const g = await newGroup(); const a = await newAttempt(g);
    await expect(db.query(`DELETE FROM public.notification_digest_attempts WHERE attempt_id='${a}'`)).rejects.toThrow();
  });
});

describe('10c-a1 digest schema — worker-run lifecycle guard', () => {
  it('finishes exactly once (valid status AND ended_at together)', async () => {
    const run = await newRun();
    await expect(db.query(`UPDATE public.notification_worker_runs
      SET ended_at=now(), status='succeeded' WHERE run_id='${run}'`)).resolves.toBeTruthy();
    await expect(db.query(`UPDATE public.notification_worker_runs
      SET status='failed' WHERE run_id='${run}'`)).rejects.toThrow();
  });

  it('rejects a status change without ended_at (status-only update)', async () => {
    const run = await newRun();
    await expect(db.query(`UPDATE public.notification_worker_runs
      SET status='succeeded' WHERE run_id='${run}'`)).rejects.toThrow();
  });

  it('rejects setting ended_at without a valid status', async () => {
    const run = await newRun();
    await expect(db.query(`UPDATE public.notification_worker_runs
      SET ended_at=now() WHERE run_id='${run}'`)).rejects.toThrow();
  });

  it('rejects identity mutation', async () => {
    const run = await newRun();
    await expect(db.query(`UPDATE public.notification_worker_runs
      SET ended_at=now(), status='succeeded', worker='evil' WHERE run_id='${run}'`)).rejects.toThrow();
  });

  it('rejects uncontrolled (direct) deletion', async () => {
    const run = await newRun();
    await expect(db.query(`DELETE FROM public.notification_worker_runs WHERE run_id='${run}'`)).rejects.toThrow();
  });
});

describe('10c-a1 digest schema — append-only audit tables', () => {
  it('ledger rejects direct UPDATE and direct DELETE', async () => {
    const g = await newGroup();
    const e = (await db.query<{ event_id: string }>(`INSERT INTO public.notification_digest_group_attempts
      (digest_group_id, action) VALUES ('${g}','materialized') RETURNING event_id`)).rows[0].event_id;
    await expect(db.query(`UPDATE public.notification_digest_group_attempts SET action='sent' WHERE event_id='${e}'`)).rejects.toThrow();
    await expect(db.query(`DELETE FROM public.notification_digest_group_attempts WHERE event_id='${e}'`)).rejects.toThrow();
  });

  it('provider_events rejects direct UPDATE and direct DELETE', async () => {
    const g = await newGroup();
    await db.query(`INSERT INTO public.notification_provider_events
      (resend_event_id, provider_message_id, digest_group_id, status, occurred_at)
      VALUES ('re-1','pmid-1','${g}','delivered', now())`);
    await expect(db.query(`UPDATE public.notification_provider_events SET status='bounced' WHERE resend_event_id='re-1'`)).rejects.toThrow();
    await expect(db.query(`DELETE FROM public.notification_provider_events WHERE resend_event_id='re-1'`)).rejects.toThrow();
  });
});

describe('10c-a1 digest schema — cascade + controlled retention', () => {
  it('deleting a group cascades attempts/ledger/provider_events/reservations and NULLs the outbox relation', async () => {
    const g = await newGroup();
    const a = await newAttempt(g);
    await db.query(`UPDATE public.notification_digest_groups SET current_attempt_id='${a}' WHERE id='${g}'`);
    await db.query(`INSERT INTO public.notification_digest_group_attempts (digest_group_id, attempt_id, action)
      VALUES ('${g}','${a}','attempt')`);
    await db.query(`INSERT INTO public.notification_provider_events
      (resend_event_id, provider_message_id, digest_group_id, status, occurred_at)
      VALUES ('re-casc','pmid-casc','${g}','sent', now())`);
    await db.query(`INSERT INTO public.notification_send_counters (counter_key, bucket_kind, bucket_start, cap)
      VALUES ('ck-casc','day',now(),100)`);
    await db.query(`INSERT INTO public.notification_send_reservations
      (digest_group_id, counter_key, attempt_id, bucket_start, state) VALUES ('${g}','ck-casc','${a}',now(),'reserved')`);
    const ob = (await db.query<{ id: string }>(
      `INSERT INTO public.notification_outbox (status) VALUES ('pending') RETURNING id`)).rows[0].id;
    await db.query(`UPDATE public.notification_outbox SET digest_group_id='${g}' WHERE id='${ob}'`);

    // plain top-level group delete → children cascade at depth>1 (allowed by the guards)
    await expect(db.query(`DELETE FROM public.notification_digest_groups WHERE id='${g}'`)).resolves.toBeTruthy();

    for (const [t, col] of [
      ['notification_digest_attempts', 'digest_group_id'], ['notification_digest_group_attempts', 'digest_group_id'],
      ['notification_provider_events', 'digest_group_id'], ['notification_send_reservations', 'digest_group_id']] as const) {
      const n = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${t} WHERE ${col}='${g}'`)).rows[0].n;
      expect(n, `${t} cascaded`).toBe(0);
    }
    const outbox = (await db.query<{ digest_group_id: string | null }>(
      `SELECT digest_group_id FROM public.notification_outbox WHERE id='${ob}'`)).rows[0];
    expect(outbox.digest_group_id).toBeNull(); // preserved row, nulled relation
  });

  it('purge_notification_digest() prunes a terminal group + a finished run via the controlled path', async () => {
    const g = await newGroup({ state: `'sent'`, updated_at: `now() - interval '200 days'` });
    await newAttempt(g);
    const run = await newRun();
    await db.query(`UPDATE public.notification_worker_runs SET ended_at=now() - interval '200 days', status='succeeded' WHERE run_id='${run}'`);
    await db.query(`SELECT public.purge_notification_digest(90, 35)`);
    const grp = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.notification_digest_groups WHERE id='${g}'`)).rows[0].n;
    const r = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.notification_worker_runs WHERE run_id='${run}'`)).rows[0].n;
    expect(grp).toBe(0); expect(r).toBe(0);
  });

  it('worker-run retention SET-NULLs surviving attempt/ledger back-refs (declared behaviour)', async () => {
    const g = await newGroup({ state: `'pending'` }); // pending → NOT purged, so its children survive
    const run = await newRun();
    await db.query(`UPDATE public.notification_worker_runs SET ended_at=now() - interval '200 days', status='succeeded' WHERE run_id='${run}'`);
    const a = await newAttempt(g, { worker_run_id: `'${run}'` });
    await db.query(`INSERT INTO public.notification_digest_group_attempts (digest_group_id, worker_run_id, attempt_id, action)
      VALUES ('${g}','${run}','${a}','attempt')`);
    await db.query(`SELECT public.purge_notification_digest(90, 35)`);
    const att = (await db.query<{ worker_run_id: string | null }>(
      `SELECT worker_run_id FROM public.notification_digest_attempts WHERE attempt_id='${a}'`)).rows[0];
    const led = (await db.query<{ worker_run_id: string | null }>(
      `SELECT worker_run_id FROM public.notification_digest_group_attempts WHERE digest_group_id='${g}'`)).rows[0];
    expect(att.worker_run_id).toBeNull(); // run pruned, attempt survives with nulled ref
    expect(led.worker_run_id).toBeNull();
  });
});

describe('10c-a1 digest schema — referential integrity (same-group FKs + lineage)', () => {
  it('current_attempt_id must reference an existing attempt in the SAME group', async () => {
    const ga = await newGroup(); const gb = await newGroup(); const a = await newAttempt(ga);
    await expect(db.query(`UPDATE public.notification_digest_groups SET current_attempt_id='${a}' WHERE id='${gb}'`)).rejects.toThrow();
    await expect(db.query(`UPDATE public.notification_digest_groups
      SET current_attempt_id='99999999-0000-0000-0000-000000000000' WHERE id='${ga}'`)).rejects.toThrow();
    await expect(db.query(`UPDATE public.notification_digest_groups SET current_attempt_id='${a}' WHERE id='${ga}'`)).resolves.toBeTruthy();
  });

  it('circuit probe_attempt_id must belong to probe_group_id', async () => {
    const ga = await newGroup(); const gb = await newGroup(); const a = await newAttempt(ga);
    await expect(db.query(`INSERT INTO public.notification_provider_circuit (channel, probe_group_id, probe_attempt_id)
      VALUES ('email-x','${gb}','${a}')`)).rejects.toThrow();
    await expect(db.query(`INSERT INTO public.notification_provider_circuit (channel, probe_group_id, probe_attempt_id)
      VALUES ('email-ok','${ga}','${a}')`)).resolves.toBeTruthy();
  });

  it('reservation attempt_id must belong to its group and counter_key must exist', async () => {
    const ga = await newGroup(); const gb = await newGroup(); const a = await newAttempt(ga);
    await db.query(`INSERT INTO public.notification_send_counters (counter_key, bucket_kind, bucket_start, cap)
      VALUES ('ck-ri','hour',now(),50)`);
    await expect(db.query(`INSERT INTO public.notification_send_reservations
      (digest_group_id, counter_key, attempt_id, bucket_start, state) VALUES ('${gb}','ck-ri','${a}',now(),'reserved')`)).rejects.toThrow();
    await expect(db.query(`INSERT INTO public.notification_send_reservations
      (digest_group_id, counter_key, attempt_id, bucket_start, state) VALUES ('${ga}','nope','${a}',now(),'reserved')`)).rejects.toThrow();
    await expect(db.query(`INSERT INTO public.notification_send_reservations
      (digest_group_id, counter_key, attempt_id, bucket_start, state) VALUES ('${ga}','ck-ri','${a}',now(),'reserved')`)).resolves.toBeTruthy();
  });

  it('parent_group_id SET-NULLs on parent purge so child lineage survives independent 90-day purging', async () => {
    const parent = await newGroup(); const child = await newGroup({ parent_group_id: `'${parent}'` });
    await db.query(`DELETE FROM public.notification_digest_groups WHERE id='${parent}'`);
    const c = (await db.query<{ parent_group_id: string | null }>(
      `SELECT parent_group_id FROM public.notification_digest_groups WHERE id='${child}'`)).rows[0];
    expect(c.parent_group_id).toBeNull();
  });
});

describe('10c-a1 digest schema — enum + range constraints', () => {
  it('group.state and provider_status reject unknown enum values', async () => {
    const g = await newGroup();
    await expect(db.query(`UPDATE public.notification_digest_groups SET state='made_up' WHERE id='${g}'`)).rejects.toThrow();
    await expect(db.query(`UPDATE public.notification_digest_groups SET provider_status='nonsense' WHERE id='${g}'`)).rejects.toThrow();
  });

  it('worker phase, ledger action, provider status and attempt outcome reject out-of-list values', async () => {
    await expect(db.query(`INSERT INTO public.notification_worker_runs (worker, channel, phase) VALUES ('w','email','sideways')`)).rejects.toThrow();
    const g = await newGroup();
    await expect(db.query(`INSERT INTO public.notification_digest_group_attempts (digest_group_id, action) VALUES ('${g}','teleported')`)).rejects.toThrow();
    await expect(db.query(`INSERT INTO public.notification_provider_events
      (resend_event_id, provider_message_id, digest_group_id, status, occurred_at) VALUES ('re-x','p','${g}','exploded', now())`)).rejects.toThrow();
    const a = await newAttempt(g);
    await expect(db.query(`UPDATE public.notification_digest_attempts SET recorded_at=now(), outcome_class='vibes' WHERE attempt_id='${a}'`)).rejects.toThrow();
  });

  it('enforces the 50-item group maximum and nonnegative counters/bytes/ordinals', async () => {
    await expect(newGroup({ item_count: '51' })).rejects.toThrow();          // > 50 rejected
    await expect(newGroup({ item_count: '-1' })).rejects.toThrow();
    await expect(newGroup({ total_item_bytes: '-1' })).rejects.toThrow();
    await expect(newGroup({ chunk_ordinal: '-1' })).rejects.toThrow();
    await expect(newGroup({ provider_attempts_started: '-1' })).rejects.toThrow();
    await expect(newGroup({ delivery_budget_used: '-1' })).rejects.toThrow();
    await expect(newGroup({ max_delivery_budget: '0' })).rejects.toThrow();   // must be > 0
    await expect(newGroup({ provider_status_rank: '-1' })).rejects.toThrow();
    await expect(newGroup({ item_count: '50' })).resolves.toBeTruthy();       // exactly 50 allowed
  });

  it('send_counters.used and .cap must be nonnegative', async () => {
    await expect(db.query(`INSERT INTO public.notification_send_counters (counter_key, bucket_kind, bucket_start, used, cap)
      VALUES ('neg-used','hour',now(),-1,10)`)).rejects.toThrow();
    await expect(db.query(`INSERT INTO public.notification_send_counters (counter_key, bucket_kind, bucket_start, used, cap)
      VALUES ('neg-cap','hour',now(),0,-1)`)).rejects.toThrow();
  });

  it('group (canonical_group_key, chunk_ordinal) is unique', async () => {
    await db.query(`INSERT INTO public.notification_digest_groups
      (canonical_group_key, group_key_hash, channel, event_type, recipient_key, destination_fingerprint,
       recipient_timezone, digest_boundary_at, available_at)
      VALUES ('["dup"]'::jsonb,'h','email','ev','p:x','df','Europe/Amsterdam',now(),now())`);
    await expect(db.query(`INSERT INTO public.notification_digest_groups
      (canonical_group_key, group_key_hash, channel, event_type, recipient_key, destination_fingerprint,
       recipient_timezone, digest_boundary_at, available_at)
      VALUES ('["dup"]'::jsonb,'h','email','ev','p:x','df','Europe/Amsterdam',now(),now())`)).rejects.toThrow();
  });

  it('provider_message_id is unique across two otherwise-distinct groups', async () => {
    const g1 = await newGroup(); const g2 = await newGroup();
    await expect(db.query(`UPDATE public.notification_digest_groups SET provider_message_id='shared-pmid' WHERE id='${g1}'`)).resolves.toBeTruthy();
    await expect(db.query(`UPDATE public.notification_digest_groups SET provider_message_id='shared-pmid' WHERE id='${g2}'`)).rejects.toThrow();
  });
});

// ── migration-wide ACL scanner: catches BOTH named-table grants and schema-wide ALL TABLES grants to
//    PUBLIC/anon/authenticated, tolerant of quoted identifiers + comma-separated schema lists. ────────────
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
      // (a) schema-wide: GRANT ... ON ALL TABLES IN SCHEMA <list> — flag if any schema in the list is public
      const schemaWide = target.match(/\bON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+(.+)$/i);
      if (schemaWide) {
        const schemas = schemaWide[1].split(',').map(unquote);
        if (schemas.includes('public')) { offenders.push(`${name}: ${st}`); continue; }
      }
      // (b) named digest table anywhere in the grant target (quoted or bare, possibly schema-qualified)
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

  it('the scanner itself catches named, quoted, comma-list and schema-wide offenders (self-test)', () => {
    const synthetic = [
      { name: 'a.sql', sql: `GRANT SELECT ON public.notification_digest_groups TO anon;` },
      { name: 'b.sql', sql: `GRANT ALL ON TABLE "notification_provider_events" TO authenticated;` },
      { name: 'c.sql', sql: `GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;` },
      { name: 'd.sql', sql: `GRANT SELECT ON ALL TABLES IN SCHEMA storage, public TO authenticated;` },
      { name: 'e.sql', sql: `GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO PUBLIC;` },
      { name: 'ok.sql', sql: `GRANT SELECT ON ALL TABLES IN SCHEMA storage TO anon;` }, // not public → fine
      { name: 'ok2.sql', sql: `GRANT SELECT ON public.notification_digest_groups TO service_role;` }, // svc → fine
    ];
    const hits = tableGrantOffenders(synthetic).map((o) => o.split(':')[0]);
    expect(hits.sort()).toEqual(['a.sql', 'b.sql', 'c.sql', 'd.sql', 'e.sql']);
  });
});
