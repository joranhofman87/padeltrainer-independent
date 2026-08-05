// @vitest-environment node
// N2 S1 — the marketing-suppression + manage-capability migrations, executed FOR REAL.
//
// These three migrations are the data layer under every N2 surface: the address-keyed marketing
// opt-out the campaign/onboarding senders will consult at send time, the capability rows behind
// the signed footer links, and the declared footer policy the attach layers read. The properties
// pinned here are the ones a later edit is most likely to break silently:
//   * one capability PER SEND, identity (source_kind, source_id): a retry of the same send
//     returns the same row (so the rebuilt email is byte-identical under a fixed provider
//     idempotency key), a NEW send gets its own row, a same-source mint with different claims
//     RAISES, and two connections racing one send both receive the one row;
//   * key rotation is database-owned state: the version comes from the key-state row, an
//     already-printed capability is NEVER re-signed or revoked by a rotation, and a retired key
//     fails CLOSED (rejected_retired_key / status retired_key);
//   * capabilities authorize ONE monotonic action (marketing suppression for an address in a
//     scope), so a forwarded or replayed link can never contradict a later choice. That is why
//     EVERY marketing recipient gets one — registered or not, since suppression is about the
//     address — while optional SERVICE mail links to the authenticated settings page instead,
//     because a per-account preference is exactly what a forwardable link must not touch;
//   * the suppression reader RAISES on malformed scope — a sender wiring error defers, it never
//     clears;
//   * claims are immutable and no client role can touch the tables directly;
//   * the footer-policy migration seeds the LIVE catalog before constraining it (the ordering
//     that passes on an empty database and fails on production is pinned by seeding first here).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Client } = pg;
const PORT = 54397;
const MIG = (f: string) =>
  readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8');

let epg: InstanceType<typeof EmbeddedPostgres>;
let c: InstanceType<typeof Client>;
let c2: InstanceType<typeof Client>;   // the concurrent-mint second connection

const U1 = '11111111-1111-4111-8111-111111111111';
const ACADEMY = '22222222-2222-4222-8222-222222222222';
const TRAINER = '33333333-3333-4333-8333-333333333333';
const SEND_A = '44444444-4444-4444-8444-444444444444';
const SEND_B = '55555555-5555-4555-8555-555555555555';
/** dedicated send ids for FIXTURE capabilities, so a fixture mint never collides with a test's
 *  own send — identity is (source_kind, source_id), and a reused id is a claim collision. */
const SEND_FIXTURE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SEND_PROV = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SEND_PROV2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SEND_PROV3 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
/** Fixtures that write a token-sourced suppression must cite a REAL capability now — a
 *  stand-in uuid is exactly what the authority validation refuses. Minted per test in beforeEach. */
let CAP_FIXTURE = '';

const mintOn = async (client: InstanceType<typeof Client>, over: Record<string, unknown> = {}) => {
  const a = {
    kind: 'marketing_unsubscribe', scope_kind: 'academy', scope_id: ACADEMY,
    address: 'Person@Example.com',
    source_kind: 'campaign_recipient', source_id: SEND_A, ttl: '400 days',
    ...over,
  };
  const r = await client.query(
    `SELECT * FROM public.mint_notification_manage_capability($1,$2,$3,$4,$5,$6,$7::interval)`,
    [a.kind, a.scope_kind, a.scope_id, a.address, a.source_kind, a.source_id, a.ttl]);
  return r.rows[0] as { capability_id: string; key_version: number };
};
const mint = (over: Record<string, unknown> = {}) => mintOn(c, over);

/** 4-arg since 20261014150000: the SIGNED generation is bound in-database. Tests that are not
 *  about the binding pass the row's own version (looked up), which is what a legitimate token
 *  always carries. */
const apply = async (id: string, action: string, source = 'one_click', signedVersion?: number) => {
  const v = signedVersion ??
    (await c.query(`SELECT key_version FROM public.notification_manage_capabilities WHERE id = $1`, [id]))
      .rows[0]?.key_version ?? 1;
  return (await c.query(`SELECT public.apply_notification_manage_action($1,$2,$3,$4) AS r`, [id, action, source, v]))
    .rows[0].r as string;
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'n2caps-rp-'));
  epg = new EmbeddedPostgres({
    databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  c = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
  await c.connect();
  c2 = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
  await c2.connect();

  // Prod-shaped base the migrations reference (same device as the sibling realpg suites: hand
  // stubs for the PRE-EXISTING tables, real migration files for the code under test).
  await c.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    -- THE LOAD-BEARING FIXTURE. This project grants service_role ALL on every new table by
    -- default, which is precisely why each migration must revoke it EXPLICITLY. Without seeding
    -- that default here, the ACL assertions below would pass even with service_role dropped from
    -- the REVOKE — the test would be agreeing with a hole rather than proving it closed.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY);

    CREATE TABLE public.notification_event_types (
      key text PRIMARY KEY,
      category text NOT NULL DEFAULT 'booking',
      required_delivery boolean NOT NULL DEFAULT false,
      supports_email boolean NOT NULL DEFAULT true,
      default_whatsapp_frequency text NOT NULL DEFAULT 'off');

    CREATE TABLE public.notification_preferences_v2 (
      user_id uuid NOT NULL, event_type text NOT NULL,
      email_frequency text NOT NULL DEFAULT 'instant',
      whatsapp_frequency text NOT NULL DEFAULT 'off',
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, event_type));

    CREATE TABLE public.notification_contacts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      person_id uuid, user_id uuid, guest_player_id uuid,
      channel text NOT NULL DEFAULT 'email',
      destination_normalized text NOT NULL);

    CREATE TABLE public.persons (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE, email text);
    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY, name text);
    CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, full_name text);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, business_name text, user_id uuid);
    CREATE TABLE public.onboarding_email_templates (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    -- The onboarding queue with its PRODUCTION status CHECK (20260201120743), so the S3
    -- migration's constraint swap is exercised against the real prior shape.
    CREATE TABLE public.onboarding_email_queue (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      status text NOT NULL DEFAULT 'pending'
        CONSTRAINT onboarding_email_queue_status_check
        CHECK (status IN ('pending', 'sent', 'failed', 'cancelled', 'awaiting_confirmation'))
    );
  `);
  // The REAL redaction helper, extracted from the resolver migration rather than retyped — the
  // context RPC's "never the raw address" property is asserted against production's own code.
  const resolver = MIG('20260911100000_notification_resolver.sql');
  const redact = resolver.match(
    /CREATE OR REPLACE FUNCTION public\.notification_redact_destination[\s\S]*?\$\$;/)?.[0];
  if (!redact) throw new Error('notification_redact_destination not found in the resolver migration');
  await c.query(redact);

  // Suppression + capabilities under test — the REAL files.
  await c.query(MIG('20261014100000_notif_n2_marketing_suppression.sql'));
  await c.query(MIG('20261014110000_notif_n2_manage_capabilities.sql'));

  // THE PRODUCTION ORDER: the catalog is POPULATED (with real required/marketing rows and no
  // policy column) BEFORE the policy migration applies — so this suite fails if the migration
  // ever adds its constraint before its seeds again.
  await c.query(`
    INSERT INTO auth.users (id) VALUES ('${U1}');
    INSERT INTO public.persons (user_id, email) VALUES ('${U1}', 'person@example.com');
    INSERT INTO public.academy_profiles VALUES ('${ACADEMY}', 'Padel Academy Zuid');
    INSERT INTO public.trainer_profiles (id, business_name) VALUES ('${TRAINER}', 'Coach Co');
    INSERT INTO public.notification_event_types (key, category, required_delivery, default_whatsapp_frequency) VALUES
      ('open_slots_player', 'booking', false, 'off'),
      ('session_reminder_player', 'reminder', false, 'instant'),
      ('booking_confirmed_player', 'booking', true, 'off'),
      ('marketing_updates', 'marketing', false, 'off');
  `);
  await c.query(MIG('20261014120000_notif_n2_footer_policy.sql'));
  await c.query(MIG('20261014130000_notif_n2_s3_capability_source_reader.sql'));
  await c.query(MIG('20261014140000_notif_n2_s5_capability_sweep.sql'));
  await c.query(MIG('20261014150000_notif_n2_s5_apply_binds_generation.sql'));
}, 180_000);

afterAll(async () => {
  await c2?.end();
  await c?.end();
  await epg?.stop();
});

beforeEach(async () => {
  await c.query(`
    DELETE FROM public.email_marketing_suppression;
    DELETE FROM public.notification_manage_capabilities;
    DELETE FROM public.notification_preferences_v2;
    DELETE FROM public.notification_contacts;
    UPDATE public.persons SET email = 'person@example.com' WHERE user_id = '${U1}';
  `);
  // The key state is MONOTONIC by trigger (a floor may be raised, never lowered — and the row may
  // never be deleted), so resetting it between scenarios means recreating it with the guard
  // disabled. That the harness has to do this IS the guard working.
  await c.query(`
    ALTER TABLE public.notification_manage_key_state DISABLE TRIGGER trg_notif_manage_key_state_guard;
    DELETE FROM public.notification_manage_key_state;
    INSERT INTO public.notification_manage_key_state (id) VALUES (true);
    ALTER TABLE public.notification_manage_key_state ENABLE TRIGGER trg_notif_manage_key_state_guard;
  `);
  // A real academy-scoped capability for 'person@example.com', so suppression fixtures can cite an
  // authority that actually exists.
  CAP_FIXTURE = (await mint({ source_id: SEND_FIXTURE })).capability_id;
});

describe('email_marketing_suppression', () => {
  it('is normalized IN the database: a non-normalized direct insert is an error', async () => {
    await expect(c.query(
      `INSERT INTO public.email_marketing_suppression (address_normalized, scope_kind, scope_id, source)
       VALUES ('Person@Example.com', 'platform', NULL, 'manual')`)).rejects.toThrow(/check/i);
  });

  it('record_marketing_suppression normalizes, is idempotent, and reports first-vs-repeat', async () => {
    const first = (await c.query(
      `SELECT public.record_marketing_suppression('  Person@Example.COM ', 'academy', $1, 'one_click', $2) AS r`,
      [ACADEMY, CAP_FIXTURE])).rows[0].r;
    const again = (await c.query(
      `SELECT public.record_marketing_suppression('person@example.com', 'academy', $1, 'manage_page', $2) AS r`,
      [ACADEMY, CAP_FIXTURE])).rows[0].r;
    expect(first).toBe(true);
    expect(again).toBe(false);
    const rows = await c.query(`SELECT address_normalized, source FROM public.email_marketing_suppression`);
    expect(rows.rows).toEqual([{ address_normalized: 'person@example.com', source: 'one_click' }]);
  });

  it('platform-scope uniqueness really is unique (plain UNIQUE dedupes nothing over NULL)', async () => {
    await c.query(`SELECT public.record_marketing_suppression('a@b.nl', 'platform', NULL, 'manual', NULL, '${U1}')`);
    await c.query(`SELECT public.record_marketing_suppression('a@b.nl', 'platform', NULL, 'manual', NULL, '${U1}')`);
    const n = await c.query(
      `SELECT count(*)::int AS n FROM public.email_marketing_suppression WHERE scope_id IS NULL`);
    expect(n.rows[0].n).toBe(1);
  });

  it('scope semantics: platform covers every scope; a tenant row covers only its tenant', async () => {
    await c.query(`SELECT public.record_marketing_suppression('t@x.nl', 'academy', $1, 'manual', NULL, '${U1}')`, [ACADEMY]);
    const q = async (scopeKind: string, scopeId: string | null) =>
      (await c.query(`SELECT public.is_marketing_suppressed('T@x.nl', $1, $2) AS s`,
        [scopeKind, scopeId])).rows[0].s;
    expect(await q('academy', ACADEMY)).toBe(true);
    expect(await q('academy', TRAINER)).toBe(false);   // a different academy id
    expect(await q('trainer', TRAINER)).toBe(false);
    expect(await q('platform', null)).toBe(false);

    await c.query(`SELECT public.record_marketing_suppression('t@x.nl', 'platform', NULL, 'manual', NULL, '${U1}')`);
    expect(await q('trainer', TRAINER)).toBe(true);    // platform arm covers every scope
    expect(await q('platform', null)).toBe(true);
  });

  it('the READER fails closed: malformed scope RAISES instead of answering false', async () => {
    // an academy sender that loses its scope id must DEFER, never gain marketing clearance
    await expect(c.query(
      `SELECT public.is_marketing_suppressed('a@b.nl', 'academy', NULL)`)).rejects.toThrow(/disagree/);
    await expect(c.query(
      `SELECT public.is_marketing_suppressed('a@b.nl', 'tenant', $1)`, [ACADEMY])).rejects.toThrow(/unknown scope_kind/);
    await expect(c.query(
      `SELECT public.is_marketing_suppressed('not-an-address', 'platform', NULL)`)).rejects.toThrow(/not an email/);
  });

  it('scope coherence is validated by the writer too, not trusted', async () => {
    await expect(c.query(
      `SELECT public.record_marketing_suppression('a@b.nl', 'academy', NULL, 'manual', NULL, '${U1}')`))
      .rejects.toThrow(/disagree/);
    await expect(c.query(
      `SELECT public.record_marketing_suppression('a@b.nl', 'platform', $1, 'manual', NULL, '${U1}')`, [ACADEMY]))
      .rejects.toThrow(/disagree/);
  });
});

describe('mint_notification_manage_capability', () => {
  it('the same SEND returns the SAME capability id (deterministic tokens for a retry)', async () => {
    const a = await mint();
    const b = await mint();
    expect(b.capability_id).toBe(a.capability_id);
  });

  it('TWO CONNECTIONS racing the same grant converge on ONE capability id', async () => {
    // Without the advisory lock this is a SELECT-then-INSERT race: both see no live grant, both
    // insert, and two different token byte strings exist for one frozen provider request.
    const addr = 'race@example.com';
    // BOTH racers must receive the capability — "a retry returns the same row" is the contract,
    // so a loser getting 23505 instead of its link would be a real defect, not a tolerable one.
    const [a, b] = await Promise.all([
      mintOn(c, { address: addr }),
      mintOn(c2, { address: addr }),
    ]);
    expect(a.capability_id).toBe(b.capability_id);
    const n = (await c.query(
      `SELECT count(*)::int AS n FROM public.notification_manage_capabilities WHERE address_normalized = $1`,
      [addr])).rows[0].n;
    expect(n).toBe(1);
  });

  it('a REVOKED capability stays the send\'s capability — a retry is not re-signed around it', async () => {
    // Per-send identity means a spent/revoked send does not get a second, live link minted for
    // it: the row IS the send. (A NEW send is what gets a new capability — pinned below.)
    const a = await mint();
    await c.query(`UPDATE public.notification_manage_capabilities SET revoked_at = now() WHERE id = $1`,
      [a.capability_id]);
    const retry = await mint();
    expect(retry.capability_id).toBe(a.capability_id);
    expect(await apply(a.capability_id, 'marketing_unsubscribe')).toBe('rejected_revoked');
    // ...while a different send mints its own, live capability
    const other = await mint({ source_id: SEND_B });
    expect(other.capability_id).not.toBe(a.capability_id);
    expect(await apply(other.capability_id, 'marketing_unsubscribe')).toBe('applied');
  });

  it('the key VERSION comes from database-owned state, never from the caller', async () => {
    const a = await mint();
    expect(a.key_version).toBe(1);
    await c.query(`UPDATE public.notification_manage_key_state SET current_version = 2`);
    const b = await mint({ source_id: SEND_B });
    expect(b.key_version).toBe(2);
    // ...and the ROTATION DOES NOT TOUCH the already-printed link: rewriting a signed row is how
    // a retry's body changes underneath a fixed provider idempotency key.
    const first = (await c.query(
      `SELECT key_version, revoked_at FROM public.notification_manage_capabilities WHERE id = $1`,
      [a.capability_id])).rows[0];
    expect(first).toEqual({ key_version: 1, revoked_at: null });
  });

  it('a RETIRED key fails closed: the old link is refused, and its retry cannot be re-signed', async () => {
    const old = await mint();
    await c.query(`UPDATE public.notification_manage_key_state
                     SET current_version = 2, min_mintable_version = 2`);
    // the printed link is a dead end...
    expect(await apply(old.capability_id, 'marketing_unsubscribe')).toBe('rejected_retired_key');
    const ctx = (await c.query(
      `SELECT * FROM public.get_notification_manage_context($1)`, [old.capability_id])).rows[0];
    expect(ctx.status).toBe('retired_key');
    expect(ctx.destination_redacted).toBeNull();
    // ...and a RETRY of that same send is REFUSED outright rather than handing back a row whose
    // links are dead (re-signing it would change the body under a fixed idempotency key). The
    // send fails loudly; see the dedicated retry test above.
    await expect(mint()).rejects.toThrow(/RETIRED generation/);
  });

  it('capabilities are PER SEND: the same source reuses, a new send mints fresh', async () => {
    const base = { source_kind: 'outbox', ttl: '400 days' };
    const a1 = await mint({ ...base, source_id: SEND_A });
    const a2 = await mint({ ...base, source_id: SEND_A });   // retry of the SAME send
    expect(a2.capability_id).toBe(a1.capability_id);
    const b = await mint({ ...base, source_id: SEND_B });    // a NEW email
    expect(b.capability_id).not.toBe(a1.capability_id);
    // ...and a NULL send id is refused rather than collapsing every send into one grant
    await expect(mint({ ...base, source_id: null })).rejects.toThrow(/source_id is required/);
  });

  it('a same-source mint with DIFFERENT claims RAISES rather than re-pointing a printed link', async () => {
    await mint();
    await expect(mint({ address: 'someone-else@example.com' }))
      .rejects.toThrow(/different claims/);
    await expect(mint({ scope_kind: 'trainer', scope_id: TRAINER }))
      .rejects.toThrow(/different claims/);
  });

  it('validates EVERY input before reuse — an invalid request never succeeds via an existing row', async () => {
    await mint();   // a live grant exists
    await expect(mint({ ttl: '0 days' })).rejects.toThrow(/ttl out of bounds/);
    await expect(mint({ ttl: '30 days' })).rejects.toThrow(/13-26 months/);   // the marketing band
    await expect(mint({ ttl: '900 days' })).rejects.toThrow(/13-26 months/);
    await expect(mint({ scope_kind: 'academy', scope_id: null })).rejects.toThrow(/disagree/);
    await expect(mint({ source_kind: 'nowhere' })).rejects.toThrow(/unknown source_kind/);
    await expect(mint({ kind: 'account_event_optout' })).rejects.toThrow(/unknown kind/);
    await expect(mint({ kind: 'manage_context' })).rejects.toThrow(/unknown kind/);
  });

});

describe('apply_notification_manage_action', () => {
  it('refuses a SIGNED generation that is not the row\'s own — the binding is in-database', async () => {
    const cap = await mint({ source_id: SEND_A });
    expect(await apply(cap.capability_id, 'marketing_unsubscribe', 'one_click', cap.key_version + 7))
      .toBe('rejected_generation_mismatch');
    // and NOTHING was suppressed by the refused call
    const n = await c.query(`SELECT count(*)::int AS n FROM public.email_marketing_suppression`);
    expect(n.rows[0].n).toBe(0);
  });

  it('the unbound 3-arg form is GONE — a stale caller fails 42883, it cannot apply unbound', async () => {
    const cap = await mint({ source_id: SEND_A });
    await expect(c.query(
      `SELECT public.apply_notification_manage_action($1,'marketing_unsubscribe','one_click')`,
      [cap.capability_id])).rejects.toMatchObject({ code: '42883' });
  });

  it('a NULL signed generation is a caller bug, refused before the row is even read', async () => {
    // Direct call — the test helper's ?? would silently substitute the row's real version.
    const cap = await mint({ source_id: SEND_A });
    const r = await c.query(
      `SELECT public.apply_notification_manage_action($1,'marketing_unsubscribe','one_click',NULL::int) AS r`,
      [cap.capability_id]);
    expect(r.rows[0].r).toBe('rejected_unbound_caller');
  });

  it('marketing capability applies suppression for ITS scope + address; replay is already_applied', async () => {
    const cap = await mint();
    expect(await apply(cap.capability_id, 'marketing_unsubscribe')).toBe('applied');
    expect(await apply(cap.capability_id, 'marketing_unsubscribe')).toBe('already_applied');
    const row = (await c.query(`SELECT * FROM public.email_marketing_suppression`)).rows[0];
    expect(row.address_normalized).toBe('person@example.com');
    expect(row.scope_kind).toBe('academy');
    expect(row.scope_id).toBe(ACADEMY);
    expect(row.capability_id).toBe(cap.capability_id);
  });

  it('missing / revoked / expired capabilities are rejected uniformly, and reject BEFORE acting', async () => {
    expect(await apply('99999999-9999-4999-8999-999999999999', 'marketing_unsubscribe'))
      .toBe('rejected_missing');
    const cap = await mint();
    await c.query(`UPDATE public.notification_manage_capabilities SET revoked_at = now() WHERE id = $1`,
      [cap.capability_id]);
    expect(await apply(cap.capability_id, 'marketing_unsubscribe')).toBe('rejected_revoked');
    const expired = (await c.query(
      `INSERT INTO public.notification_manage_capabilities
         (kind, scope_kind, scope_id, address_normalized, destination_fingerprint,
          source_kind, source_id, key_version, expires_at)
       VALUES ('marketing_unsubscribe', 'trainer', $1, 'person@example.com', md5('person@example.com'),
               'campaign_recipient', $2, 1, now() - interval '1 hour')
       RETURNING id`, [TRAINER, SEND_B])).rows[0].id;
    expect(await apply(expired, 'marketing_unsubscribe')).toBe('rejected_expired');
    const n = (await c.query(`SELECT count(*)::int AS n FROM public.email_marketing_suppression`)).rows[0].n;
    expect(n).toBe(0);
  });

});

describe('key state is the retirement authority, and it fails closed', () => {
  it('MINT BLOCKS behind an in-flight rotation — the lock, proven by two sessions', async () => {
    // THE RACE THIS CLOSES: mint used to read current_version with a plain SELECT. Under READ
    // COMMITTED it could read generation 1, an owner could commit a rotation retiring generation
    // 1, and mint would then stamp a capability with a generation that was ALREADY DEAD — a link
    // printed into an email that can never work, with no signal anywhere.
    //
    // DISCRIMINATING BY CONSTRUCTION: session B holds an UNCOMMITTED rotation, so it holds the
    // row's FOR NO KEY UPDATE lock (the rotation touches no key column). `FOR SHARE` conflicts
    // with that, so session A must BLOCK and time out. Delete that clause and A sails through and
    // mints under the doomed generation — this test fails.
    let code: string | null = null;
    let minted = -1;
    // The blocking session is released in FINALLY, not after the assertions: a failing expect
    // would otherwise leave c2 holding the row lock and wedge every later test in this file —
    // turning one honest failure into a hung suite that says nothing about why.
    await c2.query('BEGIN');
    try {
      await c2.query(`UPDATE public.notification_manage_key_state
                        SET current_version = 2, min_mintable_version = 2`);
      try {
        await c.query(`SET lock_timeout = '700ms'`);
        await mint({ source_id: SEND_B });
      } catch (e) { code = (e as { code?: string }).code ?? 'error'; }
      finally { await c.query(`RESET lock_timeout`); }
      minted = (await c.query(
        `SELECT count(*)::int AS n FROM public.notification_manage_capabilities WHERE source_id = $1`,
        [SEND_B])).rows[0].n;
    } finally {
      await c2.query('ROLLBACK').catch(() => {});
    }
    expect(code).toBe('55P03');                       // lock_not_available — it waited, as it must
    expect(minted).toBe(0);                           // and nothing was stamped under the old key
  });

  it('...and once the rotation COMMITS, the next mint uses the NEW generation', async () => {
    await c2.query(`UPDATE public.notification_manage_key_state
                      SET current_version = 2, min_mintable_version = 2`);
    const fresh = await mint({ source_id: SEND_B });
    expect(fresh.key_version).toBe(2);
  });

  it('a RETRY of a send signed by a retired generation FAILS LOUDLY, never silently', async () => {
    // The one case the lock cannot cover: the row already exists, minted legitimately under
    // generation 1, and the operator retires generation 1 while that send is still retryable.
    // Handing the row back would attach a dead link; re-signing it would change the body under a
    // fixed provider idempotency key. Both are worse than a send that fails TERMINALLY with an
    // alert, which puts the decision in front of the human who retired the key.
    const first = await mint();
    expect(first.key_version).toBe(1);
    await c.query(`UPDATE public.notification_manage_key_state
                     SET current_version = 2, min_mintable_version = 2`);
    // The CODE is the contract, not the prose: a worker classifies on SQLSTATE, and without
    // 'NMRET' it reads this as a transient RPC failure and poison-retries a send that can never
    // succeed. Asserting only the message would leave `USING ERRCODE` free to be deleted.
    let err: { code?: string; message?: string } | null = null;
    try { await mint(); } catch (e) { err = e as { code?: string; message?: string }; }
    expect(err?.code).toBe('NMRET');
    expect(err?.message).toMatch(/RETIRED generation 1 \(floor is 2\)/);
  });

  it('the floor is MONOTONIC and the row is permanent — even for a privileged caller', async () => {
    await c.query(`UPDATE public.notification_manage_key_state
                     SET current_version = 3, min_mintable_version = 2`);
    await expect(c.query(
      `UPDATE public.notification_manage_key_state SET min_mintable_version = 1`))
      .rejects.toThrow(/monotonic/);
    await expect(c.query(
      `UPDATE public.notification_manage_key_state SET current_version = 1`))
      .rejects.toThrow(/monotonic/);
    await expect(c.query(`DELETE FROM public.notification_manage_key_state`))
      .rejects.toThrow(/never removed/);
  });

  it('a MISSING key state retires everything — absence is never read as version 1', async () => {
    const cap = await mint();
    await c.query(`
      ALTER TABLE public.notification_manage_key_state DISABLE TRIGGER trg_notif_manage_key_state_guard;
      DELETE FROM public.notification_manage_key_state;
      ALTER TABLE public.notification_manage_key_state ENABLE TRIGGER trg_notif_manage_key_state_guard;`);
    expect(await apply(cap.capability_id, 'marketing_unsubscribe')).toBe('rejected_retired_key');
    const ctx = (await c.query(
      `SELECT status FROM public.get_notification_manage_context($1)`, [cap.capability_id])).rows[0];
    expect(ctx.status).toBe('retired_key');
    await expect(mint({ source_id: SEND_B })).rejects.toThrow(/signing-key state is missing/);
  });

  it('service_role cannot lower or remove the retirement floor', async () => {
    const as = async (sql: string) => {
      await c2.query(`SET ROLE service_role`);
      try { await c2.query(sql); return null; }
      catch (e) { return (e as { code?: string }).code ?? 'error'; }
      finally { await c2.query(`RESET ROLE`); }
    };
    expect(await as(`UPDATE public.notification_manage_key_state SET min_mintable_version = 1`)).toBe('42501');
    expect(await as(`DELETE FROM public.notification_manage_key_state`)).toBe('42501');
    expect(await as(`TRUNCATE public.notification_manage_key_state`)).toBe('42501');
    expect(await as(`SELECT * FROM public.notification_manage_key_state`)).toBeNull();
  });
});


describe('suppression provenance is coherent, not merely conventional', () => {
  // An audit column that can disagree with itself answers nothing. A token-authorized suppression
  // must name the capability and no human; an operator's must name the operator and no capability.
  // Every valid row must cite an authority that EXISTS and matches this address + scope, so the
  // fixture mints one rather than inventing a uuid.
  let CAP_ID = '';
  const ACTOR = U1;                                  // a real account, per the new validation
  beforeEach(async () => {
    CAP_ID = (await mint({
      address: 'prov@example.com', scope_kind: 'platform', scope_id: null, source_id: SEND_PROV,
    })).capability_id;
  });
  const rec = async (source: string, capId: string | null, actor: string | null) => {
    try {
      await c.query(
        `SELECT public.record_marketing_suppression('prov@example.com', 'platform', NULL, $1, $2, $3)`,
        [source, capId, actor]);
      return null;
    } catch (e) { return (e as { message: string }).message; }
  };

  it('accepts exactly the coherent combinations', async () => {
    expect(await rec('one_click', CAP_ID, null)).toBeNull();
    await c.query(`DELETE FROM public.email_marketing_suppression`);
    expect(await rec('manage_page', CAP_ID, null)).toBeNull();
    await c.query(`DELETE FROM public.email_marketing_suppression`);
    expect(await rec('manual', null, ACTOR)).toBeNull();
  });

  it('refuses every incoherent one, by name', async () => {
    // token sources: capability required, human forbidden
    expect(await rec('one_click', null, null)).toMatch(/authorized by a capability/);
    expect(await rec('one_click', null, ACTOR)).toMatch(/authorized by a capability/);
    expect(await rec('one_click', CAP_ID, ACTOR)).toMatch(/no human actor/);
    expect(await rec('manage_page', null, ACTOR)).toMatch(/authorized by a capability/);
    // manual: human required, capability forbidden
    expect(await rec('manual', null, null)).toMatch(/names the operator/);
    expect(await rec('manual', CAP_ID, null)).toMatch(/names the operator/);
    expect(await rec('manual', CAP_ID, ACTOR)).toMatch(/carries no capability/);
    // and an unknown or NULL source never reaches the table (SQL NOT IN yields NULL for NULL,
    // so the null arm is explicit — otherwise it died on the column constraint instead)
    expect(await rec('somehow', CAP_ID, null)).toMatch(/unknown source/);
    expect(await rec(null as unknown as string, CAP_ID, null)).toMatch(/unknown source/);
    const n = (await c.query(`SELECT count(*)::int AS n FROM public.email_marketing_suppression`)).rows[0].n;
    expect(n).toBe(0);
  });

  it('the TABLE refuses them too — the rule survives a caller that bypasses the RPC', async () => {
    const direct = async (source: string, capId: string | null, actor: string | null) => {
      try {
        await c.query(
          `INSERT INTO public.email_marketing_suppression
             (address_normalized, scope_kind, scope_id, source, capability_id, created_by)
           VALUES ('direct@example.com', 'platform', NULL, $1, $2, $3)`, [source, capId, actor]);
        return null;
      } catch (e) { return (e as { message: string }).message; }
    };
    expect(await direct('one_click', null, null)).toMatch(/provenance_coherent/);
    expect(await direct('manual', CAP_ID, ACTOR)).toMatch(/provenance_coherent/);
    expect(await direct('manage_page', CAP_ID, ACTOR)).toMatch(/provenance_coherent/);
    expect(await direct('one_click', CAP_ID, null)).toBeNull();   // the coherent one still lands
  });

  it('the named AUTHORITY must be real, and must match this address and scope', async () => {
    // Shape coherence only says which KIND of authority acted; it does not say one did.
    const ghost = '66666666-6666-4666-8666-666666666666';
    expect(await rec('one_click', ghost, null)).toMatch(/does not exist, or is not for this address and scope/);
    // a REAL capability, but minted for a different address
    const other = (await mint({ address: 'elsewhere@example.com', scope_kind: 'platform',
      scope_id: null, source_id: SEND_PROV2 })).capability_id;
    expect(await rec('one_click', other, null)).toMatch(/not for this address and scope/);
    // ...a real capability for the SAME address but a different SCOPE is refused too — that pins
    // the scope predicates, which an address-only check would leave dead
    const otherScope = (await mint({ address: 'prov@example.com', scope_kind: 'academy',
      scope_id: ACADEMY, source_id: SEND_PROV3 })).capability_id;
    expect(await rec('one_click', otherScope, null)).toMatch(/not for this address and scope/);
    // ...and a manual actor must be an actual account
    expect(await rec('manual', null, '66666666-6666-4666-8666-666666666666'))
      .toMatch(/is not an account/);
  });

  it('a DEAD capability cannot be cited — the recorder enforces the same lifecycle apply() does', async () => {
    // The recorder is reachable on its own, so without these checks a caller could attribute a
    // suppression to a capability the token itself could never have used.
    await c.query(`UPDATE public.notification_manage_capabilities SET revoked_at = now() WHERE id = $1`,
      [CAP_ID]);
    expect(await rec('one_click', CAP_ID, null)).toMatch(/is not live/);

    const expired = (await c.query(
      `INSERT INTO public.notification_manage_capabilities
         (kind, scope_kind, scope_id, address_normalized, destination_fingerprint,
          source_kind, source_id, key_version, expires_at)
       VALUES ('marketing_unsubscribe','platform',NULL,'prov@example.com',md5('prov@example.com'),
               'campaign_recipient', gen_random_uuid(), 1, now() - interval '1 hour')
       RETURNING id`)).rows[0].id;
    expect(await rec('one_click', expired, null)).toMatch(/is not live/);

    // ...and a capability whose GENERATION was retired after it was minted
    const live = (await mint({ address: 'prov@example.com', scope_kind: 'platform',
      scope_id: null, source_id: SEND_PROV2 })).capability_id;
    await c.query(`UPDATE public.notification_manage_key_state
                     SET current_version = 2, min_mintable_version = 2`);
    expect(await rec('one_click', live, null)).toMatch(/is not live/);
  });

  it('a concurrent REVOCATION blocks the recorder — the liveness check holds until INSERT', async () => {
    // The lifecycle check was previously an unlocked read: under READ COMMITTED a revoke could
    // commit between it and the insert, attributing a suppression to a capability that was already
    // revoked when it landed. FOR SHARE on the capability conflicts with the FOR NO KEY UPDATE a
    // revoke takes, so the recorder must WAIT — and then refuse.
    let code: string | null = null;
    let inserted = -1;
    await c2.query('BEGIN');
    try {
      await c2.query(`UPDATE public.notification_manage_capabilities SET revoked_at = now() WHERE id = $1`,
        [CAP_ID]);
      try {
        await c.query(`SET lock_timeout = '700ms'`);
        await c.query(
          `SELECT public.record_marketing_suppression('prov@example.com','platform',NULL,'one_click',$1)`,
          [CAP_ID]);
      } catch (e) { code = (e as { code?: string }).code ?? 'error'; }
      finally { await c.query(`RESET lock_timeout`); }
      inserted = (await c.query(
        `SELECT count(*)::int AS n FROM public.email_marketing_suppression`)).rows[0].n;
    } finally {
      // released in FINALLY: a failing expect must not leave c2 holding the row lock and wedge
      // every later test in this file.
      await c2.query('ROLLBACK').catch(() => {});
    }
    expect(code).toBe('55P03');          // it waited on the revoke rather than reading past it
    expect(inserted).toBe(0);            // and nothing was attributed to the doomed capability
  });

  it('a real one-click through apply() lands a coherent audit row', async () => {
    const cap = await mint();
    expect(await apply(cap.capability_id, 'marketing_unsubscribe', 'one_click')).toBe('applied');
    const row = (await c.query(
      `SELECT source, capability_id, created_by FROM public.email_marketing_suppression`)).rows[0];
    expect(row).toEqual({ source: 'one_click', capability_id: cap.capability_id, created_by: null });
  });
});

describe('get_manage_capability_for_source (S3 cutover reader)', () => {
  const read = async (kind: string, id: string) =>
    (await c.query(`SELECT * FROM public.get_manage_capability_for_source($1,$2)`, [kind, id])).rows;

  it('mint then read returns the SAME capability and version — the cutover marker', async () => {
    const minted = await mint({ source_id: SEND_A });
    const rows = await read('campaign_recipient', SEND_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].capability_id).toBe(minted.capability_id);
    expect(rows[0].key_version).toBe(minted.key_version);
    expect(rows[0].revoked).toBe(false);
    expect(rows[0].expired).toBe(false);
  });

  it('matches on BOTH kind and id — the same uuid under another kind reads as absent', async () => {
    // A reader matching only source_id would pass every other case here (uuids never collide),
    // while claiming a different sender's send carries a footer it does not.
    await mint({ source_id: SEND_A });
    expect(await read('onboarding_queue', SEND_A)).toHaveLength(0);
    expect(await read('campaign_recipient', SEND_A)).toHaveLength(1);
  });

  it('absent source → zero rows, and NOTHING is created — reading must not become minting', async () => {
    expect(await read('campaign_recipient', SEND_B)).toHaveLength(0);
    const after = await c.query(
      `SELECT count(*)::int AS n FROM public.notification_manage_capabilities WHERE source_id = $1`,
      [SEND_B]);
    expect(after.rows[0].n).toBe(0);
  });

  it('a revoked capability reads revoked=true — the sender must then BLOCK, not strip the footer', async () => {
    const minted = await mint({ source_id: SEND_A });
    await c.query(`UPDATE public.notification_manage_capabilities SET revoked_at = now() WHERE id = $1`,
      [minted.capability_id]);
    const rows = await read('campaign_recipient', SEND_A);
    expect(rows[0].revoked).toBe(true);
  });

  it('an expired capability reads expired=true', async () => {
    const minted = await mint({ source_id: SEND_A });
    // Expiry cannot be minted in the past (TTL floor is 395 days) and the guard trigger freezes
    // claims — manufacture the fixture the same way the key-state reset does: guard off, edit,
    // guard on. That the harness must do this IS the immutability working.
    await c.query(`ALTER TABLE public.notification_manage_capabilities DISABLE TRIGGER trg_notif_manage_cap_guard_immutable`);
    await c.query(`UPDATE public.notification_manage_capabilities SET expires_at = now() - interval '1 day' WHERE id = $1`,
      [minted.capability_id]);
    await c.query(`ALTER TABLE public.notification_manage_capabilities ENABLE TRIGGER trg_notif_manage_cap_guard_immutable`);
    const rows = await read('campaign_recipient', SEND_A);
    expect(rows[0].expired).toBe(true);
  });

  it('malformed input RAISES — never an empty result that reads as "legacy row, send footer-less"', async () => {
    await expect(c.query(`SELECT * FROM public.get_manage_capability_for_source(NULL, $1)`, [SEND_A]))
      .rejects.toThrow(/source_kind is required/);
    await expect(c.query(`SELECT * FROM public.get_manage_capability_for_source('campaign_recipient', NULL)`))
      .rejects.toThrow(/source_id is required/);
  });

  it('service_role may call it; authenticated and anon may not', async () => {
    const as = async (role: string, sql: string) => {
      await c2.query(`SET ROLE ${role}`);
      try { await c2.query(sql); return null; }
      catch (e) { return (e as { code?: string }).code ?? 'error'; }
      finally { await c2.query(`RESET ROLE`); }
    };
    const call = `SELECT * FROM public.get_manage_capability_for_source('campaign_recipient','${SEND_FIXTURE}')`;
    expect(await as('authenticated', call)).toBe('42501');
    expect(await as('anon', call)).toBe('42501');
    expect(await as('service_role', call)).toBeNull();
  });
});

describe("onboarding queue 'suppressed' status (S3)", () => {
  it("accepts 'suppressed' after the migration, and still refuses junk", async () => {
    await c.query(`INSERT INTO public.onboarding_email_queue (status) VALUES ('suppressed')`);
    await expect(c.query(`INSERT INTO public.onboarding_email_queue (status) VALUES ('vanished')`))
      .rejects.toThrow(/onboarding_email_queue_status_check/);
    await c.query(`DELETE FROM public.onboarding_email_queue`);
  });
});

describe('sweep_notification_manage_capabilities (S5 retention)', () => {
  const ageTo = async (capId: string, expiresAt: string) => {
    // Expiry cannot be minted in the past; manufacture age the sanctioned way (guard off/on).
    await c.query(`ALTER TABLE public.notification_manage_capabilities DISABLE TRIGGER trg_notif_manage_cap_guard_immutable`);
    await c.query(`UPDATE public.notification_manage_capabilities SET expires_at = ${expiresAt} WHERE id = $1`, [capId]);
    await c.query(`ALTER TABLE public.notification_manage_capabilities ENABLE TRIGGER trg_notif_manage_cap_guard_immutable`);
  };
  const count = async () =>
    (await c.query(`SELECT count(*)::int AS n FROM public.notification_manage_capabilities`)).rows[0].n as number;

  it('deletes ONLY rows more than 30 days past expiry — the retention floor', async () => {
    const doomed = await mint({ source_id: SEND_A });
    const recent = await mint({ source_id: SEND_B });
    await ageTo(doomed.capability_id, `now() - interval '31 days'`);
    await ageTo(recent.capability_id, `now() - interval '29 days'`); // expired, but inside the floor
    const before = await count();
    const swept = (await c.query(`SELECT public.sweep_notification_manage_capabilities(100) AS n`)).rows[0].n;
    expect(swept).toBe(1);
    expect(await count()).toBe(before - 1);
    const left = await c.query(`SELECT source_id FROM public.notification_manage_capabilities WHERE source_id IN ($1,$2)`, [SEND_A, SEND_B]);
    expect(left.rows.map((r) => r.source_id)).toEqual([SEND_B]);
  });

  it('a REVOKED row inside the floor survives — revocation is audit state, not a deletion trigger', async () => {
    const cap = await mint({ source_id: SEND_A });
    await c.query(`UPDATE public.notification_manage_capabilities SET revoked_at = now() WHERE id = $1`, [cap.capability_id]);
    const swept = (await c.query(`SELECT public.sweep_notification_manage_capabilities(100) AS n`)).rows[0].n;
    expect(swept).toBe(0);
    const ctx = await c.query(`SELECT status FROM public.get_notification_manage_context($1)`, [cap.capability_id]);
    expect(ctx.rows[0].status).toBe('revoked'); // still answers truthfully, not 'missing'
  });

  it('sweeping a capability leaves the suppression it produced — the audit outlives the credential', async () => {
    const cap = await mint({ source_id: SEND_A });
    await c.query(`SELECT public.record_marketing_suppression('person@example.com','academy',$1,'one_click',$2,NULL)`,
      [ACADEMY, cap.capability_id]);
    await ageTo(cap.capability_id, `now() - interval '40 days'`);
    expect((await c.query(`SELECT public.sweep_notification_manage_capabilities(100) AS n`)).rows[0].n).toBe(1);
    const supp = await c.query(
      `SELECT capability_id FROM public.email_marketing_suppression WHERE capability_id = $1`, [cap.capability_id]);
    expect(supp.rows).toHaveLength(1);
    expect((await c.query(`SELECT public.is_marketing_suppressed('person@example.com','academy',$1) AS s`, [ACADEMY])).rows[0].s).toBe(true);
  });

  it('is BOUNDED by the limit, and refuses a nonsense limit', async () => {
    const a = await mint({ source_id: SEND_A });
    const b = await mint({ source_id: SEND_B });
    await ageTo(a.capability_id, `now() - interval '40 days'`);
    await ageTo(b.capability_id, `now() - interval '50 days'`);
    expect((await c.query(`SELECT public.sweep_notification_manage_capabilities(1) AS n`)).rows[0].n).toBe(1);
    expect((await c.query(`SELECT public.sweep_notification_manage_capabilities(1) AS n`)).rows[0].n).toBe(1);
    expect((await c.query(`SELECT public.sweep_notification_manage_capabilities(1) AS n`)).rows[0].n).toBe(0);
    await expect(c.query(`SELECT public.sweep_notification_manage_capabilities(0)`)).rejects.toThrow(/limit/);
    await expect(c.query(`SELECT public.sweep_notification_manage_capabilities(NULL)`)).rejects.toThrow(/limit/);
  });

  it('service_role only', async () => {
    const as = async (role: string) => {
      await c2.query(`SET ROLE ${role}`);
      try { await c2.query(`SELECT public.sweep_notification_manage_capabilities(1)`); return null; }
      catch (e) { return (e as { code?: string }).code ?? 'error'; }
      finally { await c2.query(`RESET ROLE`); }
    };
    expect(await as('authenticated')).toBe('42501');
    expect(await as('anon')).toBe('42501');
    expect(await as('service_role')).toBeNull();
  });
});

describe('immutability + ACLs', () => {
  it('claims are immutable — even a privileged direct UPDATE is refused by the guard trigger', async () => {
    const cap = await mint();
    await expect(c.query(
      `UPDATE public.notification_manage_capabilities SET address_normalized = 'other@example.com'
        WHERE id = $1`, [cap.capability_id])).rejects.toThrow(/immutable/);
    // ...while the two lifecycle columns stay writable (that is what revocation IS)
    await c.query(`UPDATE public.notification_manage_capabilities SET revoked_at = now() WHERE id = $1`,
      [cap.capability_id]);
  });

  it('no client role touches the tables directly; service_role acts only through the RPCs', async () => {
    const as = async (role: string, sql: string, params: unknown[] = []) => {
      await c2.query(`SET ROLE ${role}`);
      try { await c2.query(sql, params); return null; }
      catch (e) { return (e as { code?: string }).code ?? 'error'; }
      finally { await c2.query(`RESET ROLE`); }
    };
    // authenticated: nothing at all
    expect(await as('authenticated',
      `SELECT * FROM public.notification_manage_capabilities`)).toBe('42501');
    expect(await as('authenticated',
      `SELECT * FROM public.email_marketing_suppression`)).toBe('42501');
    // The signature is spelled out per the REAL arity: a stale call would fail 42883
    // (undefined function) and quietly "pass" a permission test it never reached.
    expect(await as('authenticated',
      `SELECT public.mint_notification_manage_capability('marketing_unsubscribe','platform',NULL,'a@b.nl','campaign_recipient',gen_random_uuid(),'400 days'::interval)`))
      .toBe('42501');
    expect(await as('authenticated',
      `SELECT * FROM public.notification_manage_key_state`)).toBe('42501');
    // service_role: the RPCs work, direct writes to the capability table do not
    expect(await as('service_role',
      `SELECT public.record_marketing_suppression('svc@b.nl','platform',NULL,'manual',NULL,'${U1}')`)).toBeNull();
    // ...but suppression is MONOTONIC, so the service key must not be able to erase or rewrite it
    expect(await as('service_role', `DELETE FROM public.email_marketing_suppression`)).toBe('42501');
    expect(await as('service_role',
      `UPDATE public.email_marketing_suppression SET source = 'manual'`)).toBe('42501');
    expect(await as('service_role', `TRUNCATE public.email_marketing_suppression`)).toBe('42501');
    expect(await as('service_role',
      `INSERT INTO public.email_marketing_suppression
         (address_normalized, scope_kind, source, created_by)
       VALUES ('x@y.nl','platform','manual','${U1}')`)).toBe('42501');
    expect(await as('service_role', `SELECT * FROM public.email_marketing_suppression`)).toBeNull();
    expect(await as('service_role',
      `UPDATE public.notification_manage_capabilities SET revoked_at = now()`)).toBe('42501');
    expect(await as('service_role',
      `INSERT INTO public.notification_manage_capabilities
         (kind, scope_kind, address_normalized, destination_fingerprint, source_kind, source_id, key_version, expires_at)
       VALUES ('manage_context','platform','a@b.nl','x','outbox', gen_random_uuid(), 1, now())`)).toBe('42501');
  });
});

describe('get_notification_manage_context', () => {
  it('returns a REDACTED destination and the scope display name — never the raw address', async () => {
    const cap = await mint();
    const ctx = (await c.query(
      `SELECT * FROM public.get_notification_manage_context($1)`, [cap.capability_id])).rows[0];
    expect(ctx.status).toBe('live');
    expect(ctx.scope_display_name).toBe('Padel Academy Zuid');
    expect(ctx.destination_redacted).not.toContain('person@example.com');
    expect(ctx.destination_redacted).toMatch(/\*/);
  });

  it('non-live capabilities disclose their STATUS and nothing else', async () => {
    const missing = (await c.query(
      `SELECT * FROM public.get_notification_manage_context('99999999-9999-4999-8999-999999999999')`)).rows[0];
    expect(missing.status).toBe('missing');
    expect(missing.destination_redacted).toBeNull();

    const cap = await mint();
    await c.query(`UPDATE public.notification_manage_capabilities SET revoked_at = now() WHERE id = $1`,
      [cap.capability_id]);
    const revoked = (await c.query(
      `SELECT * FROM public.get_notification_manage_context($1)`, [cap.capability_id])).rows[0];
    expect(revoked.status).toBe('revoked');
    expect(revoked.kind).toBeNull();
    expect(revoked.scope_display_name).toBeNull();
    expect(revoked.destination_redacted).toBeNull();

    const expiredId = (await c.query(
      `INSERT INTO public.notification_manage_capabilities
         (kind, scope_kind, scope_id, address_normalized, destination_fingerprint,
          source_kind, source_id, key_version, expires_at)
       VALUES ('marketing_unsubscribe', 'trainer', $1, 'person@example.com', md5('person@example.com'),
               'campaign_recipient', $2, 1, now() - interval '1 hour')
       RETURNING id`, [TRAINER, SEND_B])).rows[0].id;
    const expired = (await c.query(
      `SELECT * FROM public.get_notification_manage_context($1)`, [expiredId])).rows[0];
    expect(expired.status).toBe('expired');
    expect(expired.destination_redacted).toBeNull();
  });
});

describe('email_footer_policy (seeded on a POPULATED catalog, the production order)', () => {
  it('required events are none, marketing is marketing_unsubscribe, everything else manage_prefs', async () => {
    const rows = (await c.query(
      `SELECT key, email_footer_policy FROM public.notification_event_types ORDER BY key`)).rows;
    expect(Object.fromEntries(rows.map((r: { key: string; email_footer_policy: string }) => [r.key, r.email_footer_policy])))
      .toEqual({
        booking_confirmed_player: 'none',
        marketing_updates: 'marketing_unsubscribe',
        open_slots_player: 'manage_prefs',
        session_reminder_player: 'manage_prefs',
      });
  });

  it('a required event cannot carry a mutating footer policy (constraint, not convention)', async () => {
    await expect(c.query(
      `UPDATE public.notification_event_types SET email_footer_policy = 'manage_prefs'
        WHERE key = 'booking_confirmed_player'`)).rejects.toThrow(/coherent/i);
  });

  it('only a MARKETING event may declare marketing_unsubscribe (the reciprocal arm)', async () => {
    // Otherwise a service email would offer an action that suppresses unrelated marketing while
    // doing nothing about the mail the recipient is actually holding.
    await expect(c.query(
      `UPDATE public.notification_event_types SET email_footer_policy = 'marketing_unsubscribe'
        WHERE key = 'open_slots_player'`)).rejects.toThrow(/implies_marketing/i);
  });

  it('an optional MARKETING event cannot carry a weaker policy than marketing_unsubscribe', async () => {
    await expect(c.query(
      `UPDATE public.notification_event_types SET email_footer_policy = 'manage_prefs'
        WHERE key = 'marketing_updates'`)).rejects.toThrow(/coherent/i);
    await expect(c.query(
      `INSERT INTO public.notification_event_types (key, category, required_delivery) VALUES
         ('future_marketing_blast', 'marketing', false)`)).rejects.toThrow(/coherent/i);
  });

  it('every OPTIONAL email-capable event must carry a MUTATING footer policy', async () => {
    await expect(c.query(
      `UPDATE public.notification_event_types SET email_footer_policy = 'none'
        WHERE key = 'open_slots_player'`)).rejects.toThrow(/has_footer/i);
    // ...and a required→optional reclassification is LOUD unless it declares the footer too
    await expect(c.query(
      `UPDATE public.notification_event_types SET required_delivery = false
        WHERE key = 'booking_confirmed_player'`)).rejects.toThrow(/has_footer/i);
    await c.query(
      `UPDATE public.notification_event_types SET required_delivery = false, email_footer_policy = 'manage_prefs'
        WHERE key = 'booking_confirmed_player'`);
    await c.query(
      `UPDATE public.notification_event_types SET required_delivery = true, email_footer_policy = 'none'
        WHERE key = 'booking_confirmed_player'`);
  });

  it('MARKETING IS NEVER REQUIRED — the previously legal atomic transition is refused', async () => {
    // All three earlier arms were satisfied by category='marketing' + required + 'none':
    // mandatory marketing with no unsubscribe. One statement, so no arm can be blamed on ordering.
    await expect(c.query(
      `UPDATE public.notification_event_types
          SET category = 'marketing', required_delivery = true, email_footer_policy = 'none'
        WHERE key = 'open_slots_player'`)).rejects.toThrow(/never_required/i);
    await expect(c.query(
      `INSERT INTO public.notification_event_types
         (key, category, required_delivery, email_footer_policy)
       VALUES ('mandatory_marketing', 'marketing', true, 'none')`)).rejects.toThrow(/never_required/i);
  });

  it('onboarding templates default to the SUPPRESSIBLE class; optional_service does not exist yet', async () => {
    const cls = (await c.query(
      `INSERT INTO public.onboarding_email_templates DEFAULT VALUES RETURNING delivery_class`)).rows[0];
    expect(cls.delivery_class).toBe('marketing');
    await expect(c.query(
      `UPDATE public.onboarding_email_templates SET delivery_class = 'optional_service'`)).rejects.toThrow(/check/i);
    await c.query(`UPDATE public.onboarding_email_templates SET delivery_class = 'required_service'`);
  });
});
