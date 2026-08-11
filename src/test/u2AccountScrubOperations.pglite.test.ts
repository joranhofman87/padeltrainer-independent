// @vitest-environment node
/**
 * U2 Slice B1 — the inert `account_scrub_operations` ledger.
 *
 * The suite applies the LEGACY account-deletion audit migration first, writes representative legacy
 * and business rows, snapshots them, and only then applies B1. A green run therefore proves the new
 * table is additive and that nothing existing was rewritten — which testing B1 alone on an empty
 * database could not.
 *
 * Two describe blocks exist because two permanent-wedge defects were REPRODUCED in the draft this
 * replaces, and both were caused by trusting a caller's clock. They are pinned here so the fix
 * cannot regress silently; each names its exact cause.
 *
 * PGLITE CLOCK RESOLUTION, learned the hard way here. `clock_timestamp()` advances roughly once per
 * millisecond under PGlite, not per statement — eight consecutive reads returned three distinct
 * values. Any assertion whose meaning depends on two clock readings DIFFERING is a coin flip. Where
 * a test needs a distinguishable timestamp it uses an explicit offset rather than a second bare
 * `clock_timestamp()`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const LEGACY_AUDIT = 'supabase/migrations/20261107100000_account_deletion_audit.sql';
const B1 = 'supabase/migrations/20261203100000_u2_account_scrub_operations.sql';

const LEGACY_STARTED = '10000000-0000-4000-8000-000000000001';
const LEGACY_COMPLETED = '10000000-0000-4000-8000-000000000002';
const LEGACY_FAILED = '10000000-0000-4000-8000-000000000003';

let db: PGlite;
let legacyBefore = '';
let legacySchemaBefore = '';
let businessBefore = '';

const legacyProjection = `
  SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id)::text AS snapshot
  FROM public.account_deletion_audit a
`;

/** Columns, constraints and triggers of the legacy table — the owner required it stay untouched. */
const legacySchemaProjection = `
  SELECT jsonb_build_object(
    'columns', (SELECT jsonb_agg(jsonb_build_object('c', attname, 't', atttypid::regtype::text, 'nn', attnotnull)
                                 ORDER BY attname)
                  FROM pg_attribute
                 WHERE attrelid = 'public.account_deletion_audit'::regclass
                   AND attnum > 0 AND NOT attisdropped),
    'constraints', (SELECT jsonb_agg(jsonb_build_object('n', conname, 'd', pg_get_constraintdef(oid)) ORDER BY conname)
                      FROM pg_constraint WHERE conrelid = 'public.account_deletion_audit'::regclass),
    'triggers', (SELECT jsonb_agg(jsonb_build_object('n', tgname, 'd', pg_get_triggerdef(oid)) ORDER BY tgname)
                   FROM pg_trigger WHERE tgrelid = 'public.account_deletion_audit'::regclass AND NOT tgisinternal),
    'guard_body', (SELECT prosrc FROM pg_proc WHERE proname = 'account_deletion_audit_guard'),
    'indexes', (SELECT jsonb_agg(indexdef ORDER BY indexname)
                  FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'account_deletion_audit')
  )::text AS snapshot
`;

const businessProjection = `
  SELECT jsonb_build_object(
    'persons', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.persons p),
    'memberships', (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM public.academy_player_memberships m),
    'bookings', (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM public.bookings b),
    'invoices', (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM public.invoices i)
  )::text AS snapshot
`;

async function snapshot(sql: string): Promise<string> {
  const { rows } = await db.query<{ snapshot: string }>(sql);
  return rows[0].snapshot;
}

let seq = 0;
const uuid = (prefix: string, n: number) =>
  `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Start an operation and return every id it needs. Each call is independent of every other. */
async function newOperation(overrides: { subjectUser?: string; actorUser?: string } = {}) {
  seq += 1;
  const id = uuid('9', seq);
  const command = uuid('8', seq);
  const subjectUser = overrides.subjectUser ?? uuid('7', seq);
  const actorUser = overrides.actorUser ?? subjectUser;
  const person = uuid('6', seq);
  await db.query(
    `INSERT INTO public.account_scrub_operations
       (id, command_id, subject_user_id, actor_user_id, self_service)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $3::uuid = $4::uuid)`,
    [id, command, subjectUser, actorUser],
  );
  return { id, command, subjectUser, actorUser, person, lease: uuid('5', seq) };
}

const scrub = (id: string, person: string) =>
  db.exec(`UPDATE public.account_scrub_operations
              SET state = 'database_scrubbed', subject_person_id = '${person}' WHERE id = '${id}'`);

const claim = (id: string, lease: string) =>
  db.exec(`UPDATE public.account_scrub_operations
              SET state = 'external_cleanup_in_progress', lease_token = '${lease}' WHERE id = '${id}'`);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA auth;
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    CREATE FUNCTION public.has_role(uuid, text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;

    -- A NEW TABLE IN SUPABASE'S public SCHEMA IS NOT BORN PRIVATE, and the ACL assertions in this
    -- file are worthless unless the harness says so. Read off pg_default_acl on the real local
    -- stack (grantor postgres, objtype r): service_role receives arwdDxtm — every privilege — and
    -- anon/authenticated receive Dxtm, which includes TRUNCATE. Bare Postgres grants none of that,
    -- so without these two statements the migration's REVOKE is a no-op here and the tests below
    -- pass over a guard nothing exercised. Verified: with the REVOKE deleted and these lines
    -- present, all three roles come back with privileges; with them absent, deleting the REVOKE
    -- changes nothing at all.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT TRUNCATE, REFERENCES, TRIGGER ON TABLES TO anon, authenticated;

    -- PII-bearing and financially meaningful sentinel rows. B1 has no reason to touch any of them.
    CREATE TABLE public.persons (id uuid PRIMARY KEY, full_name text, email text);
    CREATE TABLE public.academy_player_memberships (
      id uuid PRIMARY KEY, person_id uuid NOT NULL, academy_profile_id uuid NOT NULL,
      created_at timestamptz NOT NULL);
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY, person_id uuid, status text NOT NULL, amount numeric NOT NULL);
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY, person_id uuid, status text NOT NULL, total_amount numeric NOT NULL);

    -- The B1 migration redefines backup_export_tables(); a stand-in with the pre-B1 body proves the
    -- redefinition is what adds the new table rather than the table appearing from nowhere.
    CREATE FUNCTION public.backup_export_tables() RETURNS TABLE (relname text)
      LANGUAGE sql IMMUTABLE AS $$ SELECT * FROM (VALUES ('persons'), ('profiles')) AS t(relname) $$;
  `);
  await db.exec(readFileSync(LEGACY_AUDIT, 'utf8'));
  await db.exec(`
    INSERT INTO public.account_deletion_audit
      (id, subject_user_id, actor_user_id, self_service, subject_email, subject_name, ip_address, user_agent)
    VALUES
      ('${LEGACY_STARTED}', '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', true,
       'kept@example.test', 'Kept Legacy Name', '192.0.2.1', 'legacy-agent'),
      ('${LEGACY_COMPLETED}', '20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', true,
       'complete@example.test', 'Completed Legacy Name', '192.0.2.2', 'legacy-agent'),
      ('${LEGACY_FAILED}', '20000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000099', false,
       'failed@example.test', 'Failed Legacy Name', '192.0.2.3', 'legacy-agent');
    UPDATE public.account_deletion_audit SET status = 'completed' WHERE id = '${LEGACY_COMPLETED}';
    UPDATE public.account_deletion_audit
       SET status = 'failed', failure_reason = 'historical reason retained exactly'
     WHERE id = '${LEGACY_FAILED}';

    INSERT INTO public.persons VALUES
      ('30000000-0000-4000-8000-000000000001', 'Heavy User Player', 'player@example.test');
    INSERT INTO public.academy_player_memberships VALUES
      ('31000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001',
       '32000000-0000-4000-8000-000000000001', '2026-01-01T00:00:00Z');
    INSERT INTO public.bookings VALUES
      ('33000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'confirmed', 87.50);
    INSERT INTO public.invoices VALUES
      ('34000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'paid', 87.50);
  `);

  legacyBefore = await snapshot(legacyProjection);
  legacySchemaBefore = await snapshot(legacySchemaProjection);
  businessBefore = await snapshot(businessProjection);
  await db.exec(readFileSync(B1, 'utf8'));
});

afterAll(async () => { await db?.close(); });

describe('B1 is additive: nothing that exists is changed', () => {
  it('leaves every legacy audit row and value byte-identical', async () => {
    expect(await snapshot(legacyProjection)).toBe(legacyBefore);
  });

  it('leaves the legacy audit SCHEMA — columns, constraints, trigger and guard body — untouched', async () => {
    expect(await snapshot(legacySchemaProjection)).toBe(legacySchemaBefore);
  });

  it('does not rewrite Player, membership, booking or invoice data', async () => {
    expect(await snapshot(businessProjection)).toBe(businessBefore);
  });

  it('keeps the legacy started -> completed|failed caller contract working exactly as before', async () => {
    const complete = '10000000-0000-4000-8000-000000000011';
    const fail = '10000000-0000-4000-8000-000000000012';
    await db.exec(`
      INSERT INTO public.account_deletion_audit
        (id, subject_user_id, actor_user_id, self_service, subject_email)
      VALUES
        ('${complete}', '20000000-0000-4000-8000-000000000011', '20000000-0000-4000-8000-000000000011', true, 'legacy@example.test'),
        ('${fail}', '20000000-0000-4000-8000-000000000012', '20000000-0000-4000-8000-000000000012', true, 'legacy@example.test');
      UPDATE public.account_deletion_audit SET status = 'completed' WHERE id = '${complete}';
      UPDATE public.account_deletion_audit SET status = 'failed', failure_reason = 'legacy failure' WHERE id = '${fail}';
    `);
    const { rows } = await db.query<{ id: string; status: string; finished: boolean }>(`
      SELECT id, status, finished_at IS NOT NULL AS finished
      FROM public.account_deletion_audit WHERE id IN ($1, $2) ORDER BY id
    `, [complete, fail]);
    expect(rows).toEqual([
      { id: complete, status: 'completed', finished: true },
      { id: fail, status: 'failed', finished: true },
    ]);
  });

  it('creates no operation: applying B1 is inert', async () => {
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.account_scrub_operations`);
    expect(rows[0].n).toBe(0);
  });
});

describe('the ledger is direct-identifier-minimized (which is not the same as anonymous)', () => {
  it('has no column that could hold an email, name, phone, IP, user agent or raw error', async () => {
    const { rows } = await db.query<{ attname: string }>(`
      SELECT attname FROM pg_attribute
       WHERE attrelid = 'public.account_scrub_operations'::regclass
         AND attnum > 0 AND NOT attisdropped
       ORDER BY attname
    `);
    // Named exhaustively rather than pattern-matched: a future column has to be added here on
    // purpose, which is the review moment this assertion exists to force.
    expect(rows.map((r) => r.attname)).toEqual([
      'actor_user_id', 'auth_deleted_at', 'command_id', 'database_scrubbed_at',
      'external_attempt_count', 'finished_at', 'id', 'last_attempt_at', 'last_error_code',
      'lease_expires_at', 'lease_token', 'next_attempt_at', 'public_assets_deleted_at',
      'self_service', 'started_at', 'state', 'subject_person_id', 'subject_user_id',
    ]);
  });

  it('accepts only controlled error codes, never free text', async () => {
    const op = await newOperation();
    await expect(db.exec(`
      UPDATE public.account_scrub_operations
         SET state = 'failed', last_error_code = 'user@example.test: the provider said no'
       WHERE id = '${op.id}'
    `)).rejects.toThrow();
  });

  it('declares itself pseudonymous personal data, so nobody reads the UUIDs as anonymous', async () => {
    // Minimizing direct identifiers reduces blast radius; it does not take the table out of scope.
    // The rows stay linkable to a person, and the comment is where an operator or a later reviewer
    // finds that out — so it is asserted rather than left to whoever edits it next.
    const { rows } = await db.query<{ comment: string }>(
      `SELECT obj_description('public.account_scrub_operations'::regclass, 'pg_class') AS comment`);
    expect(rows[0].comment).toMatch(/pseudonymous personal data/i);
    expect(rows[0].comment).toMatch(/not anonymous data/i);
  });
});

describe('identity and immutability', () => {
  it('requires a unique command UUID and allows one live operation per account', async () => {
    const first = await newOperation();
    await expect(db.query(
      `INSERT INTO public.account_scrub_operations
         (id, command_id, subject_user_id, actor_user_id, self_service)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $3::uuid, true)`,
      [uuid('9', 900), first.command, uuid('7', 900)],
    )).rejects.toThrow(/command_id|unique/i);

    await expect(db.query(
      `INSERT INTO public.account_scrub_operations
         (id, command_id, subject_user_id, actor_user_id, self_service)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $3::uuid, true)`,
      [uuid('9', 901), uuid('8', 901), first.subjectUser],
    )).rejects.toThrow(/one_active_subject|unique/i);
  });

  it('lets a genuinely new operation start once the previous one finished', async () => {
    const op = await newOperation();
    await db.exec(`UPDATE public.account_scrub_operations
                      SET state = 'failed', last_error_code = 'unsupported_account' WHERE id = '${op.id}'`);
    await expect(db.query(
      `INSERT INTO public.account_scrub_operations
         (id, command_id, subject_user_id, actor_user_id, self_service)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $3::uuid, true)`,
      [uuid('9', 910), uuid('8', 910), op.subjectUser],
    )).resolves.toBeDefined();
  });

  it('requires the actor binding to agree with the self-service classification', async () => {
    await expect(db.query(
      `INSERT INTO public.account_scrub_operations
         (id, command_id, subject_user_id, actor_user_id, self_service)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, true)`,
      [uuid('9', 920), uuid('8', 920), uuid('7', 920), uuid('7', 921)],
    )).rejects.toThrow(/self_service/i);
  });

  it('makes command, subject, actor and start immutable', async () => {
    const op = await newOperation();
    for (const mutation of [
      `command_id = '${uuid('8', 990)}'`,
      `subject_user_id = '${uuid('7', 990)}'`,
      `actor_user_id = '${uuid('7', 991)}'`,
      `started_at = clock_timestamp() - interval '1 day'`,
    ]) {
      await expect(db.exec(`UPDATE public.account_scrub_operations SET ${mutation} WHERE id = '${op.id}'`))
        .rejects.toThrow(/immutable/i);
    }
  });

  it('binds the retained person exactly once, at the scrub, and never again', async () => {
    const op = await newOperation();
    // it cannot be pre-bound: only the transaction that retains the person may name it
    await expect(db.exec(`UPDATE public.account_scrub_operations
                             SET subject_person_id = '${op.person}' WHERE id = '${op.id}'`))
      .rejects.toThrow(/immutable/i);
    await expect(db.exec(`UPDATE public.account_scrub_operations
                             SET state = 'database_scrubbed' WHERE id = '${op.id}'`))
      .rejects.toThrow(/canonical person|violates check/i);
    await scrub(op.id, op.person);
    await expect(db.exec(`UPDATE public.account_scrub_operations
                             SET subject_person_id = '${uuid('6', 995)}' WHERE id = '${op.id}'`))
      .rejects.toThrow(/immutable/i);
  });

  it('refuses to insert an operation that is already past the start', async () => {
    await expect(db.query(
      `INSERT INTO public.account_scrub_operations
         (id, command_id, subject_user_id, actor_user_id, self_service, state, subject_person_id, database_scrubbed_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $3::uuid, true, 'database_scrubbed', $4::uuid, clock_timestamp())`,
      [uuid('9', 930), uuid('8', 930), uuid('7', 930), uuid('6', 930)],
    )).rejects.toThrow(/must begin at started/i);
  });

  it('refuses deleting or truncating erasure evidence', async () => {
    const op = await newOperation();
    await expect(db.exec(`DELETE FROM public.account_scrub_operations WHERE id = '${op.id}'`))
      .rejects.toThrow(/append-only/i);
    await expect(db.exec('TRUNCATE public.account_scrub_operations'))
      .rejects.toThrow(/append-only/i);
  });

  it('keeps the shape checks effective even if a privileged session disables triggers', async () => {
    await db.exec('ALTER TABLE public.account_scrub_operations DISABLE TRIGGER USER');
    try {
      await expect(db.query(
        `INSERT INTO public.account_scrub_operations
           (id, command_id, subject_user_id, actor_user_id, self_service, state, finished_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $3::uuid, true, 'completed', clock_timestamp())`,
        [uuid('9', 940), uuid('8', 940), uuid('7', 940)],
      )).rejects.toThrow(/state_shape/i);
    } finally {
      await db.exec('ALTER TABLE public.account_scrub_operations ENABLE TRIGGER USER');
    }
  });
});

describe('the database owns every timestamp', () => {
  it('discards a caller-supplied started_at and stamps its own', async () => {
    const id = uuid('9', 950);
    await db.query(
      `INSERT INTO public.account_scrub_operations
         (id, command_id, subject_user_id, actor_user_id, self_service, started_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $3::uuid, true, clock_timestamp() + interval '1 hour')`,
      [id, uuid('8', 950), uuid('7', 950)],
    );
    const { rows } = await db.query<{ in_future: boolean }>(
      `SELECT started_at > clock_timestamp() AS in_future FROM public.account_scrub_operations WHERE id = $1`, [id]);
    expect(rows[0].in_future).toBe(false);
  });

  it('discards a caller-supplied external outcome time and stamps its own', async () => {
    const op = await newOperation();
    await scrub(op.id, op.person);
    await claim(op.id, op.lease);
    await db.exec(`UPDATE public.account_scrub_operations
                      SET auth_deleted_at = clock_timestamp() + interval '1 hour' WHERE id = '${op.id}'`);
    const { rows } = await db.query<{ in_future: boolean }>(
      `SELECT auth_deleted_at > clock_timestamp() AS in_future
         FROM public.account_scrub_operations WHERE id = $1`, [op.id]);
    expect(rows[0].in_future).toBe(false);
  });

  it('never lets a recorded external outcome be rewritten', async () => {
    const op = await newOperation();
    await scrub(op.id, op.person);
    await claim(op.id, op.lease);
    await db.exec(`UPDATE public.account_scrub_operations SET auth_deleted_at = clock_timestamp() WHERE id = '${op.id}'`);

    // A DIFFERENT value is a rewrite, and is named as one. The offset matters: PGlite's
    // clock_timestamp() advances about once a millisecond, so a bare second `clock_timestamp()`
    // lands on the stored value often enough to make this test flap between the two refusals below.
    for (const value of [`clock_timestamp() + interval '1 second'`,
                         `auth_deleted_at - interval '1 second'`,
                         `NULL`]) {
      await expect(db.exec(`UPDATE public.account_scrub_operations
                               SET auth_deleted_at = ${value} WHERE id = '${op.id}'`))
        .rejects.toThrow(/recorded once/i);
    }
  });

  it('treats re-sending the identical outcome as no progress rather than as a rewrite', async () => {
    // The honest semantics of the pair of guards above, pinned so neither drifts: a retry that
    // re-sends the value already stored has changed nothing, so it is refused for advancing nothing
    // — not as an attempted rewrite. Either way it is refused, which is what the caller needs.
    const op = await newOperation();
    await scrub(op.id, op.person);
    await claim(op.id, op.lease);
    await db.exec(`UPDATE public.account_scrub_operations SET auth_deleted_at = clock_timestamp() WHERE id = '${op.id}'`);
    await expect(db.exec(`UPDATE public.account_scrub_operations
                             SET auth_deleted_at = auth_deleted_at WHERE id = '${op.id}'`))
      .rejects.toThrow(/must record an external outcome/i);
  });

  it('sets its own bounded backoff on release, always in the future', async () => {
    const op = await newOperation();
    await scrub(op.id, op.person);
    await claim(op.id, op.lease);
    await db.exec(`UPDATE public.account_scrub_operations
                      SET state = 'database_scrubbed', last_error_code = 'auth_retryable',
                          next_attempt_at = clock_timestamp() - interval '1 day'
                    WHERE id = '${op.id}'`);
    const { rows } = await db.query<{ in_future: boolean; within_cap: boolean }>(`
      SELECT next_attempt_at > clock_timestamp() AS in_future,
             next_attempt_at <= clock_timestamp() + interval '6 hours' AS within_cap
        FROM public.account_scrub_operations WHERE id = $1`, [op.id]);
    // the caller asked for "yesterday" — a hot spin — and got the protocol's schedule instead
    expect(rows[0]).toEqual({ in_future: true, within_cap: true });

    await expect(db.exec(`UPDATE public.account_scrub_operations
                             SET state = 'external_cleanup_in_progress', lease_token = '${uuid('5', 960)}'
                           WHERE id = '${op.id}'`))
      .rejects.toThrow(/backing off/i);
  });

  it('sets its own lease window and refuses an in-place extension', async () => {
    const op = await newOperation();
    await scrub(op.id, op.person);
    await db.exec(`UPDATE public.account_scrub_operations
                      SET state = 'external_cleanup_in_progress', lease_token = '${op.lease}',
                          lease_expires_at = clock_timestamp() + interval '10 years'
                    WHERE id = '${op.id}'`);
    const { rows } = await db.query<{ bounded: boolean }>(`
      SELECT lease_expires_at <= clock_timestamp() + interval '5 minutes' AS bounded
        FROM public.account_scrub_operations WHERE id = $1`, [op.id]);
    expect(rows[0].bounded).toBe(true);

    await expect(db.exec(`UPDATE public.account_scrub_operations
                             SET lease_expires_at = lease_expires_at + interval '1 hour' WHERE id = '${op.id}'`))
      .rejects.toThrow(/cannot be extended|record an external outcome/i);
  });
});

describe('permanent-wedge regressions (both reproduced in the draft this replaces)', () => {
  /**
   * WEDGE 1 — a caller-supplied future `started_at`.
   *
   * In the draft, `started_at` was whatever the caller sent and was immutable thereafter, while both
   * exits from `started` were gated on a CHECK comparing the trigger's wall-clock stamp against it:
   * `database_scrubbed_at >= started_at` and `finished_at >= started_at`. A row started an hour in
   * the future therefore satisfied NEITHER exit, could not be corrected, and could not be deleted
   * (append-only) — and the one-active-operation index then blocked that account from EVER being
   * erased. The fix is that the trigger stamps `started_at` itself, so no caller clock can place a
   * row outside the window its own exits need.
   */
  it('an operation whose caller claimed a future start can still finish', async () => {
    const id = uuid('9', 970);
    const person = uuid('6', 970);
    await db.query(
      `INSERT INTO public.account_scrub_operations
         (id, command_id, subject_user_id, actor_user_id, self_service, started_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $3::uuid, true, clock_timestamp() + interval '1 hour')`,
      [id, uuid('8', 970), uuid('7', 970)],
    );
    await scrub(id, person);
    const { rows } = await db.query<{ state: string; scrubbed: boolean }>(`
      SELECT state, database_scrubbed_at IS NOT NULL AS scrubbed
        FROM public.account_scrub_operations WHERE id = $1`, [id]);
    expect(rows[0]).toEqual({ state: 'database_scrubbed', scrubbed: true });
  });

  it('...and its sibling can still refuse terminally rather than sticking at started', async () => {
    const id = uuid('9', 971);
    await db.query(
      `INSERT INTO public.account_scrub_operations
         (id, command_id, subject_user_id, actor_user_id, self_service, started_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $3::uuid, true, clock_timestamp() + interval '1 hour')`,
      [id, uuid('8', 971), uuid('7', 971)],
    );
    await db.exec(`UPDATE public.account_scrub_operations
                      SET state = 'failed', last_error_code = 'database_terminal' WHERE id = '${id}'`);
    const { rows } = await db.query<{ state: string; finished: boolean }>(`
      SELECT state, finished_at IS NOT NULL AS finished
        FROM public.account_scrub_operations WHERE id = $1`, [id]);
    expect(rows[0]).toEqual({ state: 'failed', finished: true });
  });

  /**
   * WEDGE 2 — a worker clock running ahead of Postgres.
   *
   * `delete-user-data.ts` already stamps its work with `new Date()`, so this is the shape the real
   * caller would have taken. In the draft, `auth_deleted_at` and `public_assets_deleted_at` were
   * caller-supplied, write-once and unbounded above, while completion required
   * `finished_at >= auth_deleted_at` with `finished_at` forced to the DATABASE's wall clock. A worker
   * an hour ahead therefore wrote a marker the row could not satisfy, could not correct it (write
   * once), and could not shed it by releasing and retrying (release preserves the markers) — so the
   * erasure was unfinishable for an hour, during which the one-active-operation index also blocked
   * any replacement. The fix is that the trigger stamps the markers, so a worker's clock never
   * enters the row at all.
   */
  it('a worker an hour ahead of the database can still complete its erasure immediately', async () => {
    const op = await newOperation();
    await scrub(op.id, op.person);
    await claim(op.id, op.lease);
    // exactly what a skewed worker would send
    await db.exec(`UPDATE public.account_scrub_operations
                      SET auth_deleted_at = clock_timestamp() + interval '1 hour' WHERE id = '${op.id}'`);
    await db.exec(`UPDATE public.account_scrub_operations
                      SET public_assets_deleted_at = clock_timestamp() + interval '1 hour' WHERE id = '${op.id}'`);
    await db.exec(`UPDATE public.account_scrub_operations SET state = 'completed' WHERE id = '${op.id}'`);
    const { rows } = await db.query<{ state: string; finished: boolean; markers_sane: boolean }>(`
      SELECT state,
             finished_at IS NOT NULL AS finished,
             (auth_deleted_at <= finished_at AND public_assets_deleted_at <= finished_at) AS markers_sane
        FROM public.account_scrub_operations WHERE id = $1`, [op.id]);
    expect(rows[0]).toEqual({ state: 'completed', finished: true, markers_sane: true });
  });

  it('every live state has an exit, so no account can be stranded un-erasable', async () => {
    // started -> failed, started -> database_scrubbed and the whole external path are covered above.
    // This pins the last one: an abandoned lease is always reclaimable, so a crashed worker cannot
    // park an erasure for ever.
    const op = await newOperation();
    await scrub(op.id, op.person);
    await db.exec(`UPDATE public.account_scrub_operations
                      SET state = 'external_cleanup_in_progress', lease_token = '${op.lease}'
                    WHERE id = '${op.id}'`);
    // simulate the lease elapsing without waiting five real minutes
    await db.exec(`ALTER TABLE public.account_scrub_operations DISABLE TRIGGER USER`);
    await db.exec(`UPDATE public.account_scrub_operations
                      SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = '${op.id}'`);
    await db.exec(`ALTER TABLE public.account_scrub_operations ENABLE TRIGGER USER`);

    await expect(db.exec(`UPDATE public.account_scrub_operations
                             SET auth_deleted_at = clock_timestamp() WHERE id = '${op.id}'`))
      .rejects.toThrow(/expired/i);
    await db.exec(`UPDATE public.account_scrub_operations
                      SET state = 'external_cleanup_in_progress', lease_token = '${uuid('5', 980)}'
                    WHERE id = '${op.id}'`);
    const { rows } = await db.query<{ attempts: number; token: string }>(`
      SELECT external_attempt_count AS attempts, lease_token AS token
        FROM public.account_scrub_operations WHERE id = $1`, [op.id]);
    expect(rows[0]).toEqual({ attempts: 2, token: uuid('5', 980) });
  });
});

describe('the transition graph', () => {
  it('walks scrub -> claim -> external progress -> completion', async () => {
    const op = await newOperation();
    await scrub(op.id, op.person);
    await claim(op.id, op.lease);
    await db.exec(`UPDATE public.account_scrub_operations SET auth_deleted_at = clock_timestamp() WHERE id = '${op.id}'`);
    await expect(db.exec(`UPDATE public.account_scrub_operations SET state = 'completed' WHERE id = '${op.id}'`))
      .rejects.toThrow(/every external outcome/i);
    await db.exec(`UPDATE public.account_scrub_operations
                      SET state = 'completed', public_assets_deleted_at = clock_timestamp() WHERE id = '${op.id}'`);

    const { rows } = await db.query<Record<string, unknown>>(`
      SELECT state, external_attempt_count AS attempts,
             database_scrubbed_at IS NOT NULL AS scrubbed,
             auth_deleted_at IS NOT NULL AS auth_deleted,
             public_assets_deleted_at IS NOT NULL AS assets_deleted,
             finished_at IS NOT NULL AS finished,
             lease_token, lease_expires_at
        FROM public.account_scrub_operations WHERE id = $1`, [op.id]);
    expect(rows[0]).toEqual({
      state: 'completed', attempts: 1, scrubbed: true, auth_deleted: true,
      assets_deleted: true, finished: true, lease_token: null, lease_expires_at: null,
    });
  });

  it('keeps post-scrub failure retryable — it can never become terminal', async () => {
    const op = await newOperation();
    await scrub(op.id, op.person);
    await claim(op.id, op.lease);
    for (const code of ['database_terminal', 'unsupported_account', 'auth_retryable']) {
      await expect(db.exec(`UPDATE public.account_scrub_operations
                               SET state = 'failed', last_error_code = '${code}' WHERE id = '${op.id}'`))
        .rejects.toThrow(/invalid transition/i);
    }
    await db.exec(`UPDATE public.account_scrub_operations
                      SET state = 'database_scrubbed', last_error_code = 'auth_retryable' WHERE id = '${op.id}'`);
    const { rows } = await db.query<{ state: string; code: string }>(`
      SELECT state, last_error_code AS code FROM public.account_scrub_operations WHERE id = $1`, [op.id]);
    expect(rows[0]).toEqual({ state: 'database_scrubbed', code: 'auth_retryable' });
  });

  it('refuses a release whose reason contradicts what already succeeded', async () => {
    const op = await newOperation();
    await scrub(op.id, op.person);
    await claim(op.id, op.lease);
    await db.exec(`UPDATE public.account_scrub_operations SET auth_deleted_at = clock_timestamp() WHERE id = '${op.id}'`);
    // Auth deletion demonstrably succeeded, so "retry the Auth deletion" cannot be the reason.
    await expect(db.exec(`UPDATE public.account_scrub_operations
                             SET state = 'database_scrubbed', last_error_code = 'auth_retryable' WHERE id = '${op.id}'`))
      .rejects.toThrow(/state_shape|violates check/i);
    await db.exec(`UPDATE public.account_scrub_operations
                      SET state = 'database_scrubbed', last_error_code = 'asset_retryable' WHERE id = '${op.id}'`);
  });

  it('refuses skipped, reversed and terminal-state transitions', async () => {
    const op = await newOperation();
    await expect(db.exec(`UPDATE public.account_scrub_operations SET state = 'completed' WHERE id = '${op.id}'`))
      .rejects.toThrow(/invalid transition|violates check/i);
    await expect(db.exec(`UPDATE public.account_scrub_operations
                             SET state = 'external_cleanup_in_progress', lease_token = '${op.lease}'
                           WHERE id = '${op.id}'`))
      .rejects.toThrow(/invalid transition|violates check/i);

    await scrub(op.id, op.person);
    await expect(db.exec(`UPDATE public.account_scrub_operations SET state = 'started' WHERE id = '${op.id}'`))
      .rejects.toThrow(/invalid transition|violates check/i);

    await claim(op.id, op.lease);
    await db.exec(`UPDATE public.account_scrub_operations
                      SET state = 'completed', auth_deleted_at = clock_timestamp(),
                          public_assets_deleted_at = clock_timestamp() WHERE id = '${op.id}'`);
    await expect(db.exec(`UPDATE public.account_scrub_operations
                             SET state = 'database_scrubbed', last_error_code = 'auth_retryable'
                           WHERE id = '${op.id}'`))
      .rejects.toThrow(/invalid transition/i);
  });

  it('fences a stale lease holder out of every write', async () => {
    const op = await newOperation();
    await scrub(op.id, op.person);
    await claim(op.id, op.lease);
    const stale = op.lease;
    await db.exec(`ALTER TABLE public.account_scrub_operations DISABLE TRIGGER USER`);
    await db.exec(`UPDATE public.account_scrub_operations
                      SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = '${op.id}'`);
    await db.exec(`ALTER TABLE public.account_scrub_operations ENABLE TRIGGER USER`);
    const fresh = uuid('5', 985);
    await db.exec(`UPDATE public.account_scrub_operations
                      SET state = 'external_cleanup_in_progress', lease_token = '${fresh}' WHERE id = '${op.id}'`);

    // the RPC layer's own predicate — the fence a worker's UPDATE must carry
    const { rows } = await db.query<{ id: string }>(
      `UPDATE public.account_scrub_operations SET auth_deleted_at = clock_timestamp()
        WHERE id = $1::uuid AND lease_token = $2::uuid RETURNING id`, [op.id, stale]);
    expect(rows).toHaveLength(0);
  });
});

describe('operational surface', () => {
  it('ships the active-subject and reconciliation indexes', async () => {
    const { rows } = await db.query<{ indexname: string; indexdef: string }>(`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'account_scrub_operations'
         AND indexname LIKE 'account_scrub_operations_%'
       ORDER BY indexname
    `);
    const defs = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    expect(Object.keys(defs).sort()).toEqual([
      // constraint-backed: the primary key the backup keyset-walks, and the idempotency key
      'account_scrub_operations_command_id_key',
      'account_scrub_operations_pkey',
      // the operational three
      'account_scrub_operations_expired_lease',
      'account_scrub_operations_one_active_subject',
      'account_scrub_operations_ready_external',
    ].sort());
    expect(defs.account_scrub_operations_command_id_key).toContain('UNIQUE');
    expect(defs.account_scrub_operations_one_active_subject).toContain('UNIQUE');
    expect(defs.account_scrub_operations_one_active_subject)
      .toContain("WHERE (state <> ALL (ARRAY['completed'::text, 'failed'::text]))");
    expect(defs.account_scrub_operations_ready_external)
      .toContain('COALESCE(next_attempt_at, database_scrubbed_at)');
    expect(defs.account_scrub_operations_ready_external)
      .toContain("WHERE (state = 'database_scrubbed'::text)");
    expect(defs.account_scrub_operations_expired_lease)
      .toContain("WHERE (state = 'external_cleanup_in_progress'::text)");
  });

  it('grants NO client role any direct privilege — service_role included', async () => {
    // The B1 access boundary. service_role is revoked with everyone else because the guard trigger
    // validates the SHAPE of a transition, not the caller's entitlement to make it: a broad
    // INSERT/UPDATE grant would let any holder of the service key write any transition on any row,
    // and an UPDATE that forgot its lease-token predicate would look perfectly valid on the way past.
    const roles = ['anon', 'authenticated', 'service_role'];
    const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES'];
    const { rows } = await db.query<{ role: string; privilege: string; granted: boolean }>(`
      SELECT r.role, p.privilege,
             has_table_privilege(r.role, 'public.account_scrub_operations', p.privilege) AS granted
        FROM unnest($1::text[]) AS r(role), unnest($2::text[]) AS p(privilege)
       ORDER BY r.role, p.privilege
    `, [roles, privileges]);
    expect(rows.filter((x) => x.granted)).toEqual([]);
    // and the matrix was actually populated, so an empty result cannot pass by asking nothing
    expect(rows).toHaveLength(roles.length * privileges.length);
  });

  it('keeps RLS on with zero policies, so a future grant still lands on deny-all', async () => {
    const { rows } = await db.query<{ rls: boolean; policies: number }>(`
      SELECT c.relrowsecurity AS rls,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'account_scrub_operations'
    `);
    // The admin SELECT policy an earlier draft carried is deliberately gone: `authenticated` has no
    // SELECT privilege, so it could never fire, and an ACL a reviewer counts but the database never
    // consults is worse than none.
    expect(rows[0]).toEqual({ rls: true, policies: 0 });
  });

  it('exposes exactly one definer function naming the table, and it only returns the name', async () => {
    // B1 ships no access RPC on purpose, so with every direct privilege revoked the only way in
    // would be a SECURITY DEFINER function. Exactly one names the table: backup_export_tables(),
    // whose body is a VALUES list of table NAMES — it returns the string and never reads a row.
    // (backup_export_table() does read it, but by dynamic format() on its argument, so it names no
    // table in its definition and is governed by that allow-list rather than by this assertion.)
    // The day a real scrub RPC appears it shows up here as a failing expectation, which is the
    // review moment this exists to force.
    const { rows } = await db.query<{ proname: string }>(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosecdef
         AND pg_get_functiondef(p.oid) LIKE '%account_scrub_operations%'
       ORDER BY 1
    `);
    expect(rows.map((r) => r.proname)).toEqual(['backup_export_tables']);
  });

  it('joins the backup allow-list, and the legacy PII-bearing audit table does not', async () => {
    // What this buys: the erasure record is non-rederivable, so exporting it keeps the evidence a
    // FUTURE restore-replay protocol will need. It is not that protocol and does not stand in for
    // one — nothing reads this ledger on restore today, so a restore still reinstates erased
    // accounts. The assertion is about coverage, and the claim stops there.
    const { rows } = await db.query<{ relname: string }>(
      `SELECT relname FROM public.backup_export_tables() ORDER BY 1`);
    const allowed = rows.map((r) => r.relname);
    expect(allowed).toContain('account_scrub_operations');
    expect(allowed).not.toContain('account_deletion_audit');
  });

  it('satisfies the backup keyset precondition: a single uuid `id` primary key', async () => {
    const { rows } = await db.query<{ pk: string; pk_type: string }>(`
      SELECT (SELECT string_agg(a.attname, ',' ORDER BY x.ord)
                FROM pg_index i
                JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS x(attnum, ord) ON true
                JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = x.attnum
               WHERE i.indrelid = c.oid AND i.indisprimary) AS pk,
             (SELECT format_type(a.atttypid, NULL) FROM pg_attribute a
               WHERE a.attrelid = c.oid AND a.attname = 'id' AND NOT a.attisdropped) AS pk_type
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'account_scrub_operations'
    `);
    expect(rows[0]).toEqual({ pk: 'id', pk_type: 'uuid' });
  });
});
