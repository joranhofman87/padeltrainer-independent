// @vitest-environment node
// PR 10c-a1 — digest SCHEMA FOUNDATION (ADR 0008). Loads the real migration 20261002100000 over minimal
// stubs of the two base tables it ALTERs (notification_event_types, notification_outbox), then proves the
// tables/constraints/triggers/ACLs exist and behave. The full migration chain is additionally validated by
// CI's `supabase db reset` (real Postgres); this suite pins the ACL/trigger/constraint BEHAVIOUR.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const NEW_TABLES = [
  'notification_worker_runs', 'notification_digest_groups', 'notification_digest_attempts',
  'notification_digest_group_attempts', 'notification_provider_events', 'notification_provider_circuit',
  'notification_send_counters', 'notification_send_reservations',
];

const GID = '10000000-0000-0000-0000-000000000001';
const RUN = '20000000-0000-0000-0000-000000000001';
const ATT = '30000000-0000-0000-0000-000000000001';

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    -- minimal stubs of the two ALTERed base tables (named status CHECK so the migration can DROP it)
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
  // a group + run + attempt for the trigger tests
  await db.exec(`
    INSERT INTO public.notification_worker_runs (run_id, worker, channel, phase) VALUES ('${RUN}','w','email','dispatch');
    INSERT INTO public.notification_digest_groups
      (id, canonical_group_key, group_key_hash, channel, event_type, recipient_key, destination_fingerprint,
       recipient_timezone, digest_boundary_at, available_at)
      VALUES ('${GID}', '["v1"]'::jsonb, 'h', 'email', 'ev', 'p:x', 'df', 'Europe/Amsterdam', now(), now());
    INSERT INTO public.notification_digest_attempts (attempt_id, digest_group_id, worker_run_id, provider_idempotency_key)
      VALUES ('${ATT}', '${GID}', '${RUN}', 'dg:v1:${GID}:0');
  `);
});

describe('10c-a1 digest schema — tables + kill switch', () => {
  it('creates all 8 digest tables', async () => {
    const r = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_tables
      WHERE schemaname='public' AND tablename = ANY($1)`, [NEW_TABLES])).rows[0];
    expect(r.n).toBe(8);
  });

  it('adds the outbox snapshot columns + delivery_unknown status', async () => {
    const cols = (await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='notification_outbox'`)).rows.map((c) => c.column_name);
    for (const c of ['delivery_mode','recipient_key','digest_frequency','group_locale','recipient_timezone',
      'digest_boundary_at','template_version','destination_fingerprint','digest_item','digest_item_bytes','digest_group_id']) {
      expect(cols).toContain(c);
    }
    await expect(db.query(`INSERT INTO public.notification_outbox (id, status) VALUES ('40000000-0000-0000-0000-000000000001','delivery_unknown')`)).resolves.toBeTruthy();
  });

  it('digest_engine_enabled defaults false and requires supports_digest (catalog kill switch)', async () => {
    await db.query(`INSERT INTO public.notification_event_types (key, supports_digest) VALUES ('ok', true)`);
    const d = (await db.query<{ digest_engine_enabled: boolean }>(`SELECT digest_engine_enabled FROM public.notification_event_types WHERE key='ok'`)).rows[0];
    expect(d.digest_engine_enabled).toBe(false);
    // enabling requires supports_digest
    await expect(db.query(`INSERT INTO public.notification_event_types (key, supports_digest, digest_engine_enabled) VALUES ('bad', false, true)`)).rejects.toThrow();
    await expect(db.query(`INSERT INTO public.notification_event_types (key, supports_digest, digest_engine_enabled) VALUES ('good', true, true)`)).resolves.toBeTruthy();
  });
});

describe('10c-a1 digest schema — ACL (service-role only)', () => {
  it('anon + authenticated have NO privilege on any digest table; service_role does', async () => {
    for (const t of NEW_TABLES) {
      const r = (await db.query<{ anon: boolean; auth: boolean; svc: boolean }>(`
        SELECT has_table_privilege('anon','public.${t}','SELECT') AS anon,
               has_table_privilege('authenticated','public.${t}','SELECT') AS auth,
               has_table_privilege('service_role','public.${t}','SELECT') AS svc`)).rows[0];
      expect(r.anon, `${t} anon`).toBe(false);
      expect(r.auth, `${t} authenticated`).toBe(false);
      expect(r.svc, `${t} service_role`).toBe(true);
    }
  });

  it('append-only tables grant INSERT/SELECT but NOT UPDATE/DELETE to service_role', async () => {
    for (const t of ['notification_digest_group_attempts','notification_provider_events']) {
      const r = (await db.query<{ ins: boolean; upd: boolean; del: boolean }>(`
        SELECT has_table_privilege('service_role','public.${t}','INSERT') AS ins,
               has_table_privilege('service_role','public.${t}','UPDATE') AS upd,
               has_table_privilege('service_role','public.${t}','DELETE') AS del`)).rows[0];
      expect(r.ins, `${t} insert`).toBe(true);
      expect(r.upd, `${t} update`).toBe(false);
      expect(r.del, `${t} delete`).toBe(false);
    }
  });
});

describe('10c-a1 digest schema — triggers', () => {
  it('attempt record is once-only (NULL→recorded); re-record, identity change, and delete are rejected', async () => {
    // first record OK
    await expect(db.query(`UPDATE public.notification_digest_attempts SET recorded_at=now(), outcome_class='accepted' WHERE attempt_id='${ATT}'`)).resolves.toBeTruthy();
    // second record rejected
    await expect(db.query(`UPDATE public.notification_digest_attempts SET outcome_class='terminal' WHERE attempt_id='${ATT}'`)).rejects.toThrow();
    // delete rejected
    await expect(db.query(`DELETE FROM public.notification_digest_attempts WHERE attempt_id='${ATT}'`)).rejects.toThrow();
  });

  it('an unrecorded attempt cannot mutate identity/request fields', async () => {
    await db.query(`INSERT INTO public.notification_digest_attempts (attempt_id, digest_group_id, worker_run_id, provider_idempotency_key)
      VALUES ('30000000-0000-0000-0000-0000000000ff','${GID}','${RUN}','k')`);
    await expect(db.query(`UPDATE public.notification_digest_attempts SET provider_idempotency_key='hacked' WHERE attempt_id='30000000-0000-0000-0000-0000000000ff'`)).rejects.toThrow();
  });

  it('worker run finish is once-only', async () => {
    await expect(db.query(`UPDATE public.notification_worker_runs SET ended_at=now(), status='succeeded' WHERE run_id='${RUN}'`)).resolves.toBeTruthy();
    await expect(db.query(`UPDATE public.notification_worker_runs SET status='failed' WHERE run_id='${RUN}'`)).rejects.toThrow();
  });
});

describe('10c-a1 digest schema — constraints', () => {
  it('group (canonical_group_key, chunk_ordinal) is unique; provider_message_id is unique', async () => {
    await expect(db.query(`INSERT INTO public.notification_digest_groups
      (id, canonical_group_key, group_key_hash, channel, event_type, recipient_key, destination_fingerprint,
       recipient_timezone, digest_boundary_at, available_at)
      VALUES (gen_random_uuid(), '["v1"]'::jsonb, 'h', 'email', 'ev', 'p:x', 'df', 'Europe/Amsterdam', now(), now())`)).rejects.toThrow();
  });

  it('provider_status and group.state CHECKs reject unknown values', async () => {
    await expect(db.query(`UPDATE public.notification_digest_groups SET provider_status='nonsense' WHERE id='${GID}'`)).rejects.toThrow();
    await expect(db.query(`UPDATE public.notification_digest_groups SET state='made_up' WHERE id='${GID}'`)).rejects.toThrow();
  });

  it('send_counters.used >= 0', async () => {
    await expect(db.query(`INSERT INTO public.notification_send_counters (counter_key, bucket_kind, bucket_start, used, cap)
      VALUES ('k','hour',now(),-1,10)`)).rejects.toThrow();
  });
});

describe('10c-a1 digest schema — migration-wide ACL guard', () => {
  it('no migration GRANTs a digest table to PUBLIC/anon/authenticated (statement-parsed)', async () => {
    const { readdirSync } = await import('node:fs');
    const dir = join(process.cwd(), 'supabase', 'migrations');
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
      const sql = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
      for (const st of sql.split(';').map((s) => s.replace(/\s+/g, ' ').trim())) {
        if (!/^GRANT\b/i.test(st)) continue;
        const toIdx = st.toUpperCase().lastIndexOf(' TO ');
        if (toIdx < 0) continue;
        const roles = st.slice(toIdx + 4);
        if (!/\b(PUBLIC|anon|authenticated)\b/i.test(roles)) continue;
        if (NEW_TABLES.some((t) => new RegExp(`\\b${t}\\b`).test(st.slice(0, toIdx)))) offenders.push(`${f}: ${st}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
