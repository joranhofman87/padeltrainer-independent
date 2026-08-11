// @vitest-environment node
//
// ABC-16 — guardrail for the read-only overlay inventory.
//
// The inventory is the evidence an owner will use to decide what happens to overlay rows that
// have no independent basis. That makes four properties load-bearing, and each is asserted
// against the REAL engine rather than described in its header:
//
//   READ-ONLY      the transaction refuses writes, and the source tables are byte-identical
//                  before and after the read set;
//   PII-MINIMIZED  no direct identifier is SELECTed anywhere — proved by grepping the engine
//                  source for the column names, because "we redact it later" is not a property
//                  a reviewer can check;
//   DETERMINISTIC  two runs over unchanged data produce the same content hash, and the engine
//                  contains no now()/current_date;
//   REFUSES UNSAFE INVOCATION  production hosts and missing acknowledgements are rejected.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pgliteSessionSource } from '../../scripts/db/u1a-pglite-session.mjs';
import {
  runAbc16Inventory,
  buildQueries,
  assertInvocationAllowed,
  toStdoutSummary,
  writeArtifactSecurely,
  DISPOSITION_PRECEDENCE,
  INVENTORY_VERSION,
} from '../../scripts/db/abc16-metadata-authority-inventory.mjs';
import { applyPreH0, applyH0, FIXTURE_SQL, IDS } from './abc16Fixture';

const AS_OF = '2026-08-11T00:00:00Z';
const ENGINE_SRC = readFileSync(
  join(process.cwd(), 'scripts', 'db', 'abc16-metadata-authority-inventory.mjs'), 'utf8',
);
/** The engine with comments removed — for assertions about CODE rather than prose. */
const ENGINE_CODE = ENGINE_SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

let db: PGlite;
let first: Awaited<ReturnType<typeof runAbc16Inventory>>;

beforeAll(async () => {
  db = new PGlite();
  const exec = (sql: string) => db.exec(sql);
  await applyPreH0(exec);
  await db.exec(FIXTURE_SQL);

  // The inventory describes the world H0 leaves behind, so run it against the post-H0 state.
  await applyH0(exec);

  // Extra rows so more than one disposition is exercised.
  //
  // The ORPHAN is created on the OWNER side, not the subject side, because that is the only
  // orphan the schema actually permits: `academy_player_metadata.profile_id` and
  // `.guest_player_id` carry foreign keys, while `academy_profile_id` carries NONE — which is
  // itself part of why a minted row could name anything.
  await db.exec(`
    INSERT INTO public.academy_player_metadata (academy_profile_id, profile_id, notes)
    VALUES ('88888888-8888-4888-8888-888888888888', '${IDS.bookedProfile}', 'orphan-owner');

    -- V4 (a registered player who actually booked a slot run by one of the academy's ACTIVE
    -- trainers) needs that trainer relation to exist, or the evidence class is unreachable and
    -- the "recognises independent evidence" assertion would pass for the wrong reason.
    INSERT INTO public.academy_trainers (academy_profile_id, trainer_profile_id, status)
    VALUES ('${IDS.attackerAcademy}', '${IDS.attackerTrainer}', 'active');

    INSERT INTO public.academy_player_metadata (academy_profile_id, profile_id, notes)
    VALUES ('${IDS.attackerAcademy}', '${IDS.bookedProfile}', 'booking-observed');

    -- TRUSTED academy evidence, for contrast: an overlay row about a guest the academy
    -- actually OWNS (guest_players.academy_profile_id). That column cannot be repointed at
    -- someone else's guest — the write policies check the EXISTING row — so unlike a booking
    -- it survives as evidence.
    --
    -- The person link is created FIRST so the stamp trigger stamps the row on insert. Without
    -- it the row would land in missing_person_stamp, which sits ahead of the evidence
    -- classes in the precedence, and this fixture would prove nothing about evidence.
    INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id, notes)
    VALUES ('${IDS.victimAcademy}', '${IDS.guestOwnedByVictimAcademy}', 'owned-guest');

    -- A location row whose academy_profile_id names a profiles row that is NOT an academy:
    -- the shipped wrong-target FK. The shared fixture's location row points at an id present in
    -- BOTH tables (so it is well-targeted); this one exercises the defect itself.
    INSERT INTO public.academy_player_locations (academy_profile_id, profile_id, location_id, dismissed)
    VALUES ('${IDS.bookedProfile}', '${IDS.nascentProfile}', '${IDS.attackerLocation}', false);
  `);

  first = await runAbc16Inventory(pgliteSessionSource(db), { asOf: AS_OF });
}, 120_000);

describe('ABC-16 inventory · read-only', () => {
  it('reports itself mutation-free, with matching before/after fingerprints', () => {
    expect(first.mutation_free).toBe(true);
    expect(first.source_fingerprint_after).toEqual(first.source_fingerprint_before);
  });

  it('the engine issues no write statement of any kind', () => {
    const body = ENGINE_SRC.replace(/^\s*\/\/.*$/gm, '');
    expect(body).not.toMatch(/\b(INSERT INTO|UPDATE\s+public\.|DELETE FROM|TRUNCATE|ALTER TABLE|DROP )/i);
  });

  it('the transaction really is REPEATABLE READ / READ ONLY, not merely requested', async () => {
    // The engine asserts this itself; prove the assertion is not vacuous by showing the same
    // session refuses a write inside that mode.
    await db.exec('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await expect(
      db.query(`INSERT INTO public.academy_player_metadata (academy_profile_id, profile_id) VALUES ($1, $2)`,
        [IDS.attackerAcademy, IDS.nascentProfile]),
    ).rejects.toThrow(/read-only transaction/i);
    await db.exec('ROLLBACK');
  });
});

describe('ABC-16 inventory · PII minimization', () => {
  const FORBIDDEN_COLUMNS = [
    'full_name', 'first_name', 'last_name', 'email', 'phone', 'birth_date', 'notes',
    'billing_business_name', 'billing_address', 'billing_btw_number', 'billing_email',
    'remove_reason', 'tag_ids',
  ];

  it.each(FORBIDDEN_COLUMNS)('never selects %s', (column) => {
    const queries = buildQueries(AS_OF);
    const allSql = Object.values(queries).map((q) => (q as { sql: string }).sql).join('\n');
    expect(allSql).not.toMatch(new RegExp(`\\b${column}\\b`));
  });

  it('the row-level report carries only ids, booleans and codes', () => {
    const sample = first.report.rows[0] as Record<string, unknown>;
    expect(sample).toBeDefined();
    for (const [key, value] of Object.entries(sample)) {
      const ok = value === null
        || typeof value === 'boolean'
        || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value))
        || ['source_table', 'owner_kind', 'subject_kind', 'disposition'].includes(key);
      expect({ key, value, ok }).toMatchObject({ ok: true });
    }
  });

  it('the stdout summary withholds row-level ids entirely', () => {
    const summary = toStdoutSummary(first) as Record<string, unknown>;
    expect(summary).not.toHaveProperty('report');
    expect(JSON.stringify(summary)).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    // …while still carrying the numbers a decision needs
    expect(summary.total_rows).toBe(first.total_rows);
    expect(summary.disposition_counts).toEqual(first.disposition_counts);
  });
});

describe('ABC-16 inventory · determinism', () => {
  it('two runs over unchanged data are byte-identical', async () => {
    const second = await runAbc16Inventory(pgliteSessionSource(db), { asOf: AS_OF });
    expect(second.content_hash).toBe(first.content_hash);
  });

  it('the engine contains no wall-clock source', () => {
    // Comments are stripped first: the header explains that the engine uses a fixed `asOf`
    // "instead of now()/current_date", and grepping the prose would fail on the very sentence
    // that documents the property.
    expect(ENGINE_CODE).not.toMatch(/\bnow\(\)/i);
    expect(ENGINE_CODE).not.toMatch(/current_date|current_timestamp/i);
  });

  it('a relative asOf is refused — it would smuggle wall-clock back in', async () => {
    await expect(runAbc16Inventory(pgliteSessionSource(db), { asOf: 'now' }))
      .rejects.toMatchObject({ code: 'INVALID_AS_OF' });
  });

  it('a bare callback is refused as a session source', async () => {
    const bare = (() => {}) as unknown as { connect(): Promise<unknown> };
    (bare as unknown as { connect: unknown }).connect = () => Promise.resolve({});
    await expect(runAbc16Inventory(bare, { asOf: AS_OF }))
      .rejects.toMatchObject({ code: 'INVALID_SESSION_SOURCE' });
  });

  it('the version is stamped, so hashes are never compared across shapes', () => {
    expect(first.inventory_version).toBe(INVENTORY_VERSION);
  });
});

describe('ABC-16 inventory · classification', () => {
  it('dispositions partition the row universe', () => {
    const summed = Object.values(first.disposition_counts).reduce((a: number, b) => a + (b as number), 0);
    expect(summed).toBe(first.total_rows);
    expect(first.total_rows).toBe(first.report.rows.length);
  });

  it('every reported disposition is a declared one', () => {
    for (const key of Object.keys(first.disposition_counts)) {
      expect(DISPOSITION_PRECEDENCE).toContain(key);
    }
  });

  it('finds the forged metadata-only rows — the whole point of the exercise', () => {
    expect(first.disposition_counts.metadata_only).toBeGreaterThan(0);
  });

  it('separates an orphan reference from a metadata-only relationship', () => {
    expect(first.disposition_counts.orphan_reference).toBeGreaterThan(0);
  });

  it('recognises independent academy evidence rather than lumping it in', () => {
    expect(first.disposition_counts.independently_academy_evidenced).toBeGreaterThan(0);
  });

  it('ABC-17: a booking is an OBSERVATION, never independent evidence', () => {
    // The 'evidenced' fixture row is supported only by a booking on a slot run by an active
    // academy trainer. Before the audit that counted as `independently_academy_evidenced`;
    // since the subject of that booking was reassignable by the academy itself, it is now
    // reported as its own class so an owner can tell it apart from a row with nothing at all.
    expect(first.disposition_counts.booking_observation_only).toBeGreaterThan(0);
  });

  it('reports the shipped wrong-target academy FK on the locations row', () => {
    // academy_player_locations.academy_profile_id references profiles(id) while authorization
    // resolves academies through academy_profiles(id); the fixture's location row names an id
    // that exists in profiles but is not an academy_profiles row.
    expect(first.disposition_counts.wrong_target_academy_fk).toBeGreaterThan(0);
  });
});

describe('ABC-16 inventory · refuses unsafe invocation', () => {
  it('requires the explicit local acknowledgement', () => {
    expect(() => assertInvocationAllowed({ connectionString: 'postgres://localhost:5432/db', ack: '' }))
      .toThrow(/ABC16_INVENTORY_ACK/);
  });

  it('requires its OWN connection variable, never an ambient one', () => {
    expect(() => assertInvocationAllowed({ connectionString: '', ack: 'local-read-only' }))
      .toThrow(/ABC16_INVENTORY_DATABASE_URL/);
  });

  // The guard is an ALLOW-list. A deny-list of known production hostnames cannot express
  // "local": anything it failed to anticipate — a self-hosted database, a bare IP, an SSH
  // tunnel — was accepted. Each case below would have PASSED the earlier deny-list.
  it.each([
    'postgres://u:p@db.abcdefghijklmnop.supabase.co:5432/postgres',
    'postgres://u:p@aws-0-eu-central-1.pooler.supabase.com:6543/postgres',
    'postgres://u:p@10.0.0.7:5432/postgres',
    'postgres://u:p@db.internal.example.com:5432/postgres',
    'postgres://u:p@192.168.1.50:5432/postgres',
    'postgres://u:p@127.0.0.1.evil.example.com:5432/postgres',
  ])('refuses the remote host %s', (url) => {
    expect(() => assertInvocationAllowed({ connectionString: url, ack: 'local-read-only' }))
      .toThrow(/REMOTE_REFUSED|local-only/);
  });

  it.each(['127.0.0.1', 'localhost', '::1'])('allows the loopback host %s once acknowledged', (host) => {
    const url = host === '::1' ? 'postgres://u:p@[::1]:5432/postgres' : `postgres://u:p@${host}:5432/postgres`;
    expect(() => assertInvocationAllowed({ connectionString: url, ack: 'local-read-only' })).not.toThrow();
  });

  it('there is no flag that disables the guard', () => {
    // A guard with an escape hatch is not a guard. assertInvocationAllowed takes no override.
    expect(ENGINE_CODE).not.toMatch(/--allow-production|SKIP_GUARD|ALLOW_PROD|allowRemote/i);
  });
});

describe('ABC-16 inventory · the artifact cannot be clobbered or redirected', () => {
  let dir: string;
  beforeAll(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    dir = mkdtempSync(join(tmpdir(), 'abc16-artifact-'));
  });

  it('writes 0600 and refuses to overwrite an existing file', async () => {
    const { statSync } = await import('node:fs');
    const target = join(dir, 'report.json');

    writeArtifactSecurely(target, '{"a":1}\n');
    expect(statSync(target).mode & 0o777).toBe(0o600);

    // A second run must not destroy the first run's evidence.
    const err = (() => { try { writeArtifactSecurely(target, '{"a":2}\n'); return null; } catch (e) { return e; } })();
    expect(err).toMatchObject({ code: 'ARTIFACT_UNSAFE' });
  });

  it('refuses to write through a symlink, and does not create its target', async () => {
    const { symlinkSync, existsSync } = await import('node:fs');
    const elsewhere = join(dir, 'elsewhere.json');
    const link = join(dir, 'link.json');
    symlinkSync(elsewhere, link);

    const err = (() => { try { writeArtifactSecurely(link, '{"leak":true}\n'); return null; } catch (e) { return e; } })();
    expect(err).toMatchObject({ code: 'ARTIFACT_UNSAFE' });
    expect(existsSync(elsewhere)).toBe(false);
  });
});
