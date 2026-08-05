import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';

/**
 * N3 M1 — tenant-aware per-row idempotency (the N3 design review's CRITICAL finding, thread
 * 019fd175-f39e-73a3-80c3-7c43f6b13f97).
 *
 * The defect this migration removes: the outbox unique identity was (channel, idempotency_key)
 * with a tenant-blind key, so for a multi-academy recipient an A-attributed row and a
 * B-attributed row for the same event+subject+recipient COLLIDED — first writer wins, ON
 * CONFLICT DO NOTHING silently swallowed the other tenant's intent. N3's per-academy caps make
 * that actively wrong: academy A's cap must produce an A-attributed outcome without eating B's.
 *
 * The contract's required cases, verbatim: "A/B same user, event and subject in BOTH insertion
 * orders" — plus same-tenant dedup still holding, and the canonical scope precedence
 * (academy > trainer > global).
 *
 * REAL files throughout: the production foundation schema (not a stub outbox — the migration
 * ALTERs the named constraint, so a stub with an inline UNIQUE would not even apply) and the
 * full resolver chain through its newest definition, then M1.
 */

let epg: InstanceType<typeof EmbeddedPostgres>;
let c: InstanceType<typeof Client>;
const PORT = 54431;

const MIG = (f: string) =>
  readFileSync(resolve(__dirname, '..', '..', 'supabase', 'migrations', f), 'utf8');

const U1 = '11111111-1111-4111-8111-111111111111';
const P1 = '22222222-2222-4222-8222-222222222222';
const A = '33333333-3333-4333-8333-333333333333'; // academy A
const B = '44444444-4444-4444-8444-444444444444'; // academy B
const T = '55555555-5555-4555-8555-555555555555'; // trainer

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'n3idem-rp-'));
  epg = new EmbeddedPostgres({
    databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  c = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
  await c.connect();

  // Stubs for the PRE-EXISTING app tables the chain references; REAL migrations for everything
  // under test (same device as the sibling realpg suites).
  await c.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT NULL::uuid $fn$;
    CREATE TABLE public.persons (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE, email text, preferred_language text);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, preferred_language text);
    CREATE TABLE public.person_links (guest_player_id uuid, person_id uuid);
    CREATE TABLE public.invoices (id uuid PRIMARY KEY);
    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY, timezone text NOT NULL DEFAULT 'Europe/Amsterdam');
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, timezone text NOT NULL DEFAULT 'Europe/Amsterdam');
    CREATE TABLE public.trainer_followers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), player_id uuid NOT NULL, trainer_id uuid NOT NULL,
      notify_new_availability boolean NOT NULL DEFAULT true, UNIQUE (player_id, trainer_id));
    CREATE TABLE public.notification_sends (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dedup_key text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.notification_preferences (
      user_id uuid PRIMARY KEY, open_slots_digest text NOT NULL DEFAULT 'weekly');
    -- pre-existing delivery log the foundation migration generalizes in place
    CREATE TABLE public.email_delivery_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type text NOT NULL, recipient_email text NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.email_suppression_stub (email text PRIMARY KEY);
    CREATE FUNCTION public.is_email_suppressed(p_email text) RETURNS boolean LANGUAGE sql STABLE AS
      $fn$ SELECT EXISTS (SELECT 1 FROM public.email_suppression_stub WHERE email = lower(p_email)) $fn$;
  `);

  for (const f of [
    '20260910100000_notification_foundation_schema.sql',
    '20260911100000_notification_resolver.sql',
    '20260912100000_notification_email_worker.sql',
    '20260922100000_notification_whatsapp_booking_optin_cadence.sql',
    '20261002100000_notification_digest_schema_foundation.sql',
    '20261003100000_notification_digest_acl_lockdown.sql',
    '20261004100000_notification_digest_state_machine.sql',
    '20261005110000_notification_digest_request_hash_bytea_fix.sql',
    '20261008100000_open_slots_player_event.sql',
    '20261009100000_notif_10cb_review_corrections.sql',
    '20261010100000_open_slots_item_types_and_plurals.sql',
    '20261011100000_notif_10cb_resolver_open_slots_digest.sql',
    '20261011130000_notif_10cb_open_slots_instant_payload.sql',
    '20261011110000_notif_10cb_enqueue_digest_branch.sql',
    '20261011120000_notif_10cb_instant_claim_excludes_digest.sql',
    '20261011140000_notif_10cb_cutover_compat.sql',
    '20261013100000_notif_10cb_pref_bridge_v2_to_v1.sql',
    // ── under test ──
    '20261015100000_notif_n3_tenant_aware_idempotency.sql',
  ]) {
    await c.query(MIG(f));
  }

  await c.query(`
    INSERT INTO auth.users (id) VALUES ('${U1}');
    INSERT INTO public.persons (id, user_id, email) VALUES ('${P1}','${U1}','p1@example.com');
    INSERT INTO public.academy_profiles (id) VALUES ('${A}'), ('${B}');
    INSERT INTO public.trainer_profiles (id) VALUES ('${T}');
  `);
}, 300_000);

afterAll(async () => { await c?.end(); await epg?.stop(); });

beforeEach(async () => {
  await c.query(`TRUNCATE public.notification_outbox CASCADE;`);
});

/** enqueue booking_confirmed_player for P1/subject b1 under the given tenant attribution. */
async function enqueue(tenant: { academy?: string; trainer?: string }, subject = 'b1') {
  const r = await c.query(
    `SELECT * FROM public.enqueue_notification(
       p_event_key => 'booking_confirmed_player',
       p_recipient_person_id => $1,
       p_idempotency_subject => $2,
       p_tenant_academy_profile_id => $3,
       p_tenant_trainer_id => $4)`,
    [P1, subject, tenant.academy ?? null, tenant.trainer ?? null],
  );
  return r.rows;
}

const outbox = async () =>
  (await c.query(
    `SELECT tenant_academy_profile_id, tenant_trainer_id, tenant_scope_key, idempotency_key, channel
       FROM public.notification_outbox ORDER BY created_at, id`)).rows;

describe('tenant-aware idempotency (N3 M1)', () => {
  it('A then B: the same event+subject+recipient under two academies is TWO rows', async () => {
    await enqueue({ academy: A });
    await enqueue({ academy: B });
    const rows = await outbox();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tenant_scope_key).sort()).toEqual([`a:${A}`, `a:${B}`].sort());
    // both rows share the tenant-blind key — the SCOPE column is what separates them
    expect(new Set(rows.map((r) => r.idempotency_key)).size).toBe(1);
  });

  it('B then A: insertion order does not decide which tenant owns the intent', async () => {
    await enqueue({ academy: B });
    await enqueue({ academy: A });
    const rows = await outbox();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tenant_scope_key).sort()).toEqual([`a:${A}`, `a:${B}`].sort());
  });

  it('the SAME tenant twice is still ONE row — idempotency within a scope is untouched', async () => {
    const first = await enqueue({ academy: A });
    const second = await enqueue({ academy: A });
    expect(first.length).toBeGreaterThan(0);
    expect(second).toHaveLength(0); // ON CONFLICT DO NOTHING, as before
    expect(await outbox()).toHaveLength(1);
  });

  it('canonical scope precedence: academy wins over trainer; trainer-only; global', async () => {
    await enqueue({ academy: A, trainer: T }, 's1');
    await enqueue({ trainer: T }, 's2');
    await enqueue({}, 's3');
    const rows = await outbox();
    const byKey = Object.fromEntries(rows.map((r) => [r.idempotency_key.split(':')[1], r.tenant_scope_key]));
    expect(byKey['s1']).toBe(`a:${A}`); // both supplied → academy is canonical
    expect(byKey['s2']).toBe(`t:${T}`);
    expect(byKey['s3']).toBe('global');
  });

  it('trainer-attributed and academy-attributed intents for the same send are independent too', async () => {
    await enqueue({ trainer: T });
    await enqueue({ academy: A });
    expect(await outbox()).toHaveLength(2);
  });

  it('the scope key is GENERATED — no writer can supply a forged one', async () => {
    await expect(
      c.query(`INSERT INTO public.notification_outbox
        (event_type, channel, idempotency_key, tenant_scope_key)
        VALUES ('booking_confirmed_player','email','x:y:z','a:forged')`),
    ).rejects.toThrow(/non-DEFAULT value into column/);
  });

  it('the unique identity is exactly (channel, idempotency_key, tenant_scope_key)', async () => {
    const def = await c.query(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'uq_notification_outbox_idem'`);
    expect(def.rows).toHaveLength(1);
    expect(def.rows[0].d).toBe('UNIQUE (channel, idempotency_key, tenant_scope_key)');
  });
});
