// @vitest-environment node
//
// ABC-16 H0 — the PRIVILEGE half, on a real multi-connection PostgreSQL server.
//
// This suite exists for the properties PGlite cannot be trusted to demonstrate. The H0
// containment is half policy and half GRANT, and a policy cannot withhold a privilege while a
// grant cannot enforce a row predicate — so the proof has to read the server's OWN catalog
// (`aclexplode(relacl)`, `has_table_privilege`, `pg_proc.proacl`) and has to execute real
// statements under `SET ROLE authenticated`.
//
// It also proves the one thing a comment cannot: that withdrawing EXECUTE from the person-stamp
// functions does NOT stop their triggers firing. PostgreSQL checks EXECUTE on a trigger
// function at CREATE TRIGGER time rather than on each fire; that is load-bearing for H0, so it
// is demonstrated rather than asserted in prose.
//
// The privilege universe is derived FROM THE SERVER, never hard-coded. A hard-coded list
// (SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER) silently stops being exhaustive on
// PostgreSQL 17, which adds MAINTAIN — a guard that goes quietly incomplete is worse than none.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPreH0, applyH0, FIXTURE_SQL, H0_MIGRATION, IDS, MIGRATION } from './abc16Fixture';

const { Client } = pg;
const PORT = 54391;

let epg: InstanceType<typeof EmbeddedPostgres> | undefined;
let c: pg.Client;

const OVERLAYS = ['academy_player_metadata', 'academy_player_locations'] as const;

/** Every privilege type THIS server defines for a relation — asked, not assumed. */
let SERVER_TABLE_PRIVILEGES: string[] = [];

/** Digest of every overlay row, used to prove H0 changed no data. */
async function overlayDigest(): Promise<Record<string, { rows: number; digest: string }>> {
  const out: Record<string, { rows: number; digest: string }> = {};
  for (const t of OVERLAYS) {
    const { rows } = await c.query(
      `SELECT count(*)::int AS n,
              COALESCE(md5(string_agg(d.digest, '' ORDER BY d.digest)), '') AS digest
       FROM (SELECT md5(x::text) AS digest FROM public.${t} x) d`,
    );
    out[t] = { rows: rows[0].n, digest: rows[0].digest };
  }
  return out;
}

/** Run a statement as the `authenticated` role with the attacker's auth.uid(). */
async function asAuthenticated(sql: string, params: unknown[] = []): Promise<pg.QueryResult> {
  await c.query(`SELECT set_config('abc16.uid', $1, false)`, [IDS.attackerUser]);
  await c.query('SET ROLE authenticated');
  try {
    return await c.query(sql, params);
  } finally {
    await c.query('RESET ROLE');
  }
}

const expectRefused = async (sql: string, params: unknown[] = []) => {
  await expect(asAuthenticated(sql, params)).rejects.toThrow();
};

let digestBeforeH0: Record<string, { rows: number; digest: string }>;
let digestAfterH0: Record<string, { rows: number; digest: string }>;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abc16-rp-'));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  c = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
  await c.connect();

  const exec = async (sql: string) => { await c.query(sql); };
  await applyPreH0(exec);
  await c.query(FIXTURE_SQL);

  const { rows: privRows } = await c.query(
    `SELECT DISTINCT privilege_type FROM information_schema.table_privileges
      WHERE table_schema = 'public' LIMIT 0`,
  );
  void privRows;
  // The authoritative universe: what aclexplode can actually emit on this server, taken from
  // the ACL of a table the platform granted ALL on.
  const { rows: universe } = await c.query(
    `SELECT DISTINCT a.privilege_type
       FROM pg_class cl CROSS JOIN LATERAL aclexplode(cl.relacl) a
      WHERE cl.oid = 'public.academy_player_metadata'::regclass
      ORDER BY 1`,
  );
  SERVER_TABLE_PRIVILEGES = universe.map((r) => r.privilege_type);

  // ── PRE-H0: prove the attack path is genuinely open, so the post-H0 assertions mean something.
  const beforeInsert = await asAuthenticated(
    `INSERT INTO public.academy_player_metadata (academy_profile_id, profile_id, notes)
     VALUES ($1, $2, 'minted-before-h0') RETURNING id`,
    [IDS.attackerAcademy, IDS.bookedProfile],
  );
  expect(beforeInsert.rows).toHaveLength(1);

  digestBeforeH0 = await overlayDigest();

  await applyH0(exec);

  // Taken here, not in the test body: later cases insert and delete overlay rows, and a
  // delete+insert changes ctid, so a digest read at assertion time would drift for reasons that
  // have nothing to do with the migration.
  digestAfterH0 = await overlayDigest();
}, 240_000);

afterAll(async () => {
  try { await c?.end(); } catch { /* ignore */ }
  try { await epg?.stop(); } catch { /* ignore */ }
});

describe('ABC-16 H0 · the client privilege matrix', () => {
  it('the server defines more than one privilege type (the universe is real, not empty)', () => {
    expect(SERVER_TABLE_PRIVILEGES.length).toBeGreaterThan(1);
    expect(SERVER_TABLE_PRIVILEGES).toContain('SELECT');
  });

  it.each(OVERLAYS)('%s — across PUBLIC/anon/authenticated/service_role the ACL holds exactly {SELECT}', async (table) => {
    const { rows } = await c.query(
      `SELECT COALESCE(array_agg(DISTINCT a.privilege_type ORDER BY a.privilege_type), ARRAY[]::text[]) AS privs
         FROM pg_class cl
         CROSS JOIN LATERAL aclexplode(cl.relacl) a
         LEFT JOIN pg_roles r ON r.oid = a.grantee
        WHERE cl.oid = ('public.' || $1)::regclass
          AND (a.grantee = 0 OR r.rolname IN ('anon', 'authenticated', 'service_role'))`,
      [table],
    );
    expect(rows[0].privs).toEqual(['SELECT']);
  });

  it.each(OVERLAYS)('%s — service_role holds NO direct privilege', async (table) => {
    // Corrected from the first draft of this containment, which kept the grant on the
    // assumption that the scoped backup needed it. It does not: both overlays are in
    // backup_export_tables (20261118100000:54-55) but are read through backup_export_table,
    // which is SECURITY DEFINER and holds EXECUTE. A standing privilege with no caller is a
    // standing risk — the same reasoning ABC-14 applied elsewhere.
    for (const priv of SERVER_TABLE_PRIVILEGES) {
      const { rows } = await c.query(
        `SELECT has_table_privilege('service_role', $1, $2) AS granted`, [`public.${table}`, priv],
      );
      expect({ table, priv, granted: rows[0].granted }).toEqual({ table, priv, granted: false });
    }
  });

  it.each(OVERLAYS)('%s — authenticated has NO effective privilege beyond SELECT, across the whole server-derived universe', async (table) => {
    for (const priv of SERVER_TABLE_PRIVILEGES) {
      const { rows } = await c.query(
        `SELECT has_table_privilege('authenticated', $1, $2) AS granted`,
        [`public.${table}`, priv],
      );
      expect({ table, priv, granted: rows[0].granted }).toEqual({ table, priv, granted: priv === 'SELECT' });
    }
  });

  it.each(OVERLAYS)('%s — no non-SELECT policy survives', async (table) => {
    const { rows } = await c.query(
      `SELECT policyname, cmd FROM pg_policies WHERE schemaname='public' AND tablename=$1 AND cmd <> 'SELECT'`,
      [table],
    );
    expect(rows).toEqual([]);
  });
});

describe('ABC-16 H0 · direct writes are refused', () => {
  it('academy-owned INSERT is refused', async () => {
    await expectRefused(
      `INSERT INTO public.academy_player_metadata (academy_profile_id, profile_id) VALUES ($1, $2)`,
      [IDS.attackerAcademy, IDS.bookedProfile],
    );
  });

  it('trainer-owned INSERT is refused too — both arms close together', async () => {
    await expectRefused(
      `INSERT INTO public.academy_player_metadata (trainer_profile_id, guest_player_id) VALUES ($1, $2)`,
      [IDS.attackerTrainer, IDS.guestTargetedByForgedMetadata],
    );
  });

  it('UPDATE of an existing forged row is refused', async () => {
    await expectRefused(
      `UPDATE public.academy_player_metadata SET notes = 'tampered' WHERE academy_profile_id = $1`,
      [IDS.attackerAcademy],
    );
  });

  it('SUBJECT-REFERENCE tampering is refused (re-pointing a row at another person)', async () => {
    await expectRefused(
      `UPDATE public.academy_player_metadata SET profile_id = $1 WHERE academy_profile_id = $2`,
      [IDS.nascentProfile, IDS.attackerAcademy],
    );
  });

  it('DELETE is refused', async () => {
    await expectRefused(
      `DELETE FROM public.academy_player_metadata WHERE academy_profile_id = $1`,
      [IDS.attackerAcademy],
    );
  });

  it('locations INSERT is refused — and NOT merely because of the wrong FK', async () => {
    // The fixture gives the attacker academy a profiles-side row, so this statement would
    // satisfy the (wrong-target) foreign key. It fails on the withdrawn privilege instead,
    // which is the property under test.
    const { rows } = await c.query(`SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = $1) AS ok`, [IDS.attackerAcademy]);
    expect(rows[0].ok).toBe(true);

    await expect(
      asAuthenticated(
        `INSERT INTO public.academy_player_locations (academy_profile_id, profile_id, location_id, dismissed)
         VALUES ($1, $2, $3, false)`,
        [IDS.attackerAcademy, IDS.bookedProfile, IDS.attackerLocation],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('locations UPDATE and DELETE are refused', async () => {
    await expectRefused(`UPDATE public.academy_player_locations SET dismissed = true`);
    await expectRefused(`DELETE FROM public.academy_player_locations`);
  });

  it('TRUNCATE is refused on both overlays', async () => {
    await expectRefused(`TRUNCATE public.academy_player_metadata`);
    await expectRefused(`TRUNCATE public.academy_player_locations`);
  });
});

describe('ABC-16 H0 · the RPC and the stamp functions are not client-callable', () => {
  it('set_player_location cannot be executed by a client role', async () => {
    const { rows } = await c.query(
      `SELECT has_function_privilege('authenticated', 'public.set_player_location(uuid,uuid,uuid,uuid,boolean)', 'EXECUTE') AS a,
              has_function_privilege('anon',          'public.set_player_location(uuid,uuid,uuid,uuid,boolean)', 'EXECUTE') AS b`,
    );
    expect(rows[0]).toEqual({ a: false, b: false });

    await expectRefused(
      `SELECT public.set_player_location($1, $2, NULL, $3, false)`,
      [IDS.attackerAcademy, IDS.bookedProfile, IDS.attackerLocation],
    );
  });

  it('neither stamp function can be called directly by a client', async () => {
    const { rows } = await c.query(
      `SELECT has_function_privilege('authenticated', 'public.stamp_person_id_academy_player_metadata()', 'EXECUTE') AS m,
              has_function_privilege('authenticated', 'public.stamp_person_id_academy_player_locations()', 'EXECUTE') AS l`,
    );
    expect(rows[0]).toEqual({ m: false, l: false });
  });

  it('but the stamp TRIGGERS still fire for a trusted internal writer', async () => {
    // PostgreSQL checks EXECUTE on a trigger function at CREATE TRIGGER time, not per fire.
    // If that were not so, H0 would have silently disabled person stamping — so prove it.
    // mint_person_for_profile already gave this profile its OWN person (id = profile id). That
    // is the ABC-18 shape: separate structural persons, never a cross-source collapse.
    const { rows: linked } = await c.query(
      `SELECT person_id FROM public.person_links WHERE profile_id = $1`, [IDS.bookedProfile]);
    const person = linked[0].person_id;
    expect(person).toBe(IDS.bookedProfile);

    const { rows } = await c.query(
      `INSERT INTO public.academy_player_metadata (academy_profile_id, profile_id, notes)
       VALUES ($1, $2, 'internal') RETURNING person_id`,
      [IDS.victimAcademy, IDS.bookedProfile],
    );
    expect(rows[0].person_id).toBe(person);

    // leave the table as we found it — this suite asserts on row counts elsewhere
    await c.query(`DELETE FROM public.academy_player_metadata WHERE academy_profile_id = $1`, [IDS.victimAcademy]);
  });
});

describe('ABC-16 H0 · data preservation and continued readability', () => {
  it('every overlay row is byte-identical across the migration', () => {
    expect(digestAfterH0).toEqual(digestBeforeH0);
  });

  it('the row minted BEFORE H0 still exists — nothing was cleaned up', async () => {
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM public.academy_player_metadata WHERE notes = 'minted-before-h0'`,
    );
    expect(rows[0].n).toBe(1);
  });

  it('a client can still READ both overlays', async () => {
    const meta = await asAuthenticated(`SELECT id, notes FROM public.academy_player_metadata`);
    expect(meta.rows.length).toBeGreaterThan(0);
    const loc = await asAuthenticated(`SELECT id FROM public.academy_player_locations`);
    expect(loc.rows.length).toBeGreaterThan(0);
  });

  it('the scoped backup still reaches both overlays through its SECURITY DEFINER function', async () => {
    // The thing service_role's table grant was supposedly protecting. Proving the definer
    // route works is what makes revoking the grant safe rather than merely tidy.
    const { rows } = await c.query(
      `SELECT p.prosecdef,
              has_function_privilege('service_role', 'public.backup_export_table(text)', 'EXECUTE') AS can_exec
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'backup_export_table'`,
    );
    // The backup migration is not part of this fixture's chain, so tolerate its absence —
    // but if it IS present it must be SECURITY DEFINER with EXECUTE for service_role.
    if (rows.length > 0) {
      expect(rows[0].prosecdef).toBe(true);
      expect(rows[0].can_exec).toBe(true);
    }
  });
});

describe('ABC-17/18 · bookings are distrusted, and the bridge is frozen', () => {
  it('the partial booking guard is WITHDRAWN, not silently retained', async () => {
    // Keeping an UPDATE-only guard would have implied bookings were trustworthy. They are not:
    // it could not cover the trainer dual-key INSERT and could never vouch for historical or
    // privileged-writer rows. Overclaiming a partial guard is worse than not having one.
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM pg_trigger
        WHERE tgname = 'trg_guard_booking_subject_immutable' AND NOT tgisinternal`,
    );
    expect(rows[0].n).toBe(0);
    const { rows: fn } = await c.query(
      `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
        WHERE ns.nspname='public' AND p.proname='guard_booking_subject_immutable'`,
    );
    expect(fn[0].n).toBe(0);
  });

  it('the staff visibility helpers no longer read a booking or a bridge column', async () => {
    const { rows } = await c.query(
      `SELECT p.proname, p.prosrc ~ 'bookings|linked_profile_id|twin_of_profile_id|person_links' AS taints
         FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
        WHERE ns.nspname='public' AND p.proname IN ('is_player_of_trainer','is_player_of_academy')
        ORDER BY 1`,
    );
    expect(rows.map((r) => r.taints)).toEqual([false, false]);
  });

  it('the bridge minting RPC is callable by no untrusted role', async () => {
    const { rows } = await c.query(
      `SELECT has_function_privilege('authenticated','public.link_guest_data_to_profile(uuid)','EXECUTE') AS a,
              has_function_privilege('anon','public.link_guest_data_to_profile(uuid)','EXECUTE') AS b,
              has_function_privilege('service_role','public.link_guest_data_to_profile(uuid)','EXECUTE') AS c`,
    );
    expect(rows[0]).toEqual({ a: false, b: false, c: false });
  });

  it('bridge columns cannot be authored on INSERT or UPDATE by a client', async () => {
    await expect(asAuthenticated(
      `INSERT INTO public.guest_players (id, full_name, academy_profile_id, twin_of_profile_id)
       VALUES (gen_random_uuid(), 'Claimed', $1, $2)`,
      [IDS.attackerAcademy, IDS.nascentProfile],
    )).rejects.toThrow(/already linked/i);

    await expect(asAuthenticated(
      `UPDATE public.guest_players SET linked_profile_id = $1 WHERE id = $2`,
      [IDS.nascentProfile, IDS.guestOwnedByAttackerAcademy],
    )).rejects.toThrow(/cannot be set or changed/i);
  });

  it('service_role is blocked from authoring the bridge too', async () => {
    await c.query('SET ROLE service_role');
    try {
      await expect(c.query(
        `UPDATE public.guest_players SET twin_of_profile_id = $1 WHERE id = $2`,
        [IDS.nascentProfile, IDS.guestOwnedByAttackerAcademy],
      )).rejects.toThrow(/cannot be set or changed/i);
    } finally {
      await c.query('RESET ROLE');
    }
  });

  it('the twin claim/discovery RPCs are revoked at their REAL signatures', async () => {
    const { rows } = await c.query(
      `SELECT has_function_privilege('authenticated','public.claim_guest_twin_for_academy(uuid,uuid,uuid)','EXECUTE') AS claim_auth,
              has_function_privilege('service_role','public.claim_guest_twin_for_academy(uuid,uuid,uuid)','EXECUTE') AS claim_svc,
              has_function_privilege('authenticated','public.find_guest_twin_for_academy(uuid,uuid)','EXECUTE') AS find_auth`,
    );
    expect(rows[0]).toEqual({ claim_auth: false, claim_svc: false, find_auth: false });
  });

  it('the wrong overload does not exist — the discriminating check for the aborted-migration defect', async () => {
    // An earlier draft revoked claim_guest_twin_for_academy(uuid,uuid). On the real chain the
    // name matched and the wrong-signature REVOKE aborted the migration. Proving the 2-uuid
    // overload is absent while the 3-uuid one is present is exactly what that draft got wrong.
    const { rows } = await c.query(
      `SELECT to_regprocedure('public.claim_guest_twin_for_academy(uuid,uuid)')   AS two_arg,
              to_regprocedure('public.claim_guest_twin_for_academy(uuid,uuid,uuid)') AS three_arg`,
    );
    expect(rows[0].two_arg).toBeNull();
    expect(rows[0].three_arg).not.toBeNull();
  });

  // The identity primitives, checked with has_function_privilege (EFFECTIVE privilege, so it
  // accounts for the platform's default grants and any role inheritance) rather than by reading
  // proacl. The fixture reproduces Supabase's `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON
  // FUNCTIONS TO anon, authenticated, service_role`, without which every one of these would
  // report "not callable" for the wrong reason.
  it.each([
    ['public.collapse_guest_person_into(uuid,uuid,uuid)'],
    ['public.merge_guest_players(text,uuid,uuid,uuid,jsonb)'],
    ['public.link_guest_data_to_profile(uuid)'],
    ['public.claim_guest_twin_for_academy(uuid,uuid,uuid)'],
    ['public.find_guest_twin_for_academy(uuid,uuid)'],
  ])('%s is executable by NO external role', async (fn) => {
    const { rows } = await c.query(
      `SELECT has_function_privilege('anon', $1, 'EXECUTE')          AS anon,
              has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', $1, 'EXECUTE')  AS service_role`,
      [fn],
    );
    expect({ fn, ...rows[0] }).toEqual({ fn, anon: false, authenticated: false, service_role: false });
  });

  it('the fixture really does grant EXECUTE by default — otherwise the checks above are vacuous', async () => {
    // A control: a function this containment does NOT revoke must still be callable by the
    // client roles. If this fails, the default-grant reproduction is broken and every
    // "not callable" assertion above proves nothing.
    const { rows } = await c.query(
      `SELECT has_function_privilege('service_role','public.guest_belongs_to_user_academy(uuid,uuid)','EXECUTE') AS svc`,
    );
    expect(rows[0].svc).toBe(true);
  });

  it('the owner-context auto-link triggers are retired', async () => {
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM pg_trigger
        WHERE NOT tgisinternal
          AND tgname IN ('trg_link_guest_data_on_guest_player_change','trg_link_guest_invoices_on_signup')`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('the trainer booked-guest policy is gone', async () => {
    const { rows } = await c.query(
      `SELECT policyname FROM pg_policies
        WHERE schemaname='public' AND tablename='guest_players'
          AND policyname = 'Trainers can view guests booked into their slots'`,
    );
    expect(rows).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// ABC-26 · the retired supplementary-priority filter, and the narrowed member window.
//
// The claim being proved is "no runtime role can obtain an admission list, and the member window
// no longer honours a stored one". Three independent kinds of evidence, because each alone can be
// green while the object is still reachable:
//
//   ACL       aclexplode(proacl) — the EXPLICIT grants, the only view that shows GRANT OPTION and
//             the only one that distinguishes PUBLIC (grantee 0) from a named role.
//   EFFECTIVE has_function_privilege — what the server will actually answer at call time, which
//             follows role INHERITANCE and therefore catches a grant that leaves no proacl entry.
//   REAL      SET ROLE + an actual call. The only evidence that the catalog and the executor
//             agree, and the only one that survives a mistaken belief about either.
//
// Every negative is paired with a POSITIVE CONTROL, because a suite where nothing can be called
// proves nothing about a change that removed one specific capability.
// ════════════════════════════════════════════════════════════════════════════════════════════

const RETIRED_FILTER = 'public.filter_academy_priority_ids(uuid,uuid[],uuid[])';
const RETIRED_FILTER_IDENT = 'uuid, uuid[], uuid[]';

/** Exact shipped ABC-26 install assertion, without re-emitting any migration object. */
function abc26AssertionSql(): string {
  const sql = MIGRATION(H0_MIGRATION);
  const startMarker = 'DO $chk26$';
  const endMarker = 'END $chk26$;';
  const start = sql.indexOf(startMarker);
  const end = sql.indexOf(endMarker);
  if (start < 0 || end < 0 || end < start
      || sql.indexOf(startMarker, start + startMarker.length) >= 0
      || sql.indexOf(endMarker, end + endMarker.length) >= 0) {
    throw new Error('Expected exactly one ordered DO $chk26$ ... END $chk26$; assertion block');
  }
  return sql.slice(start, end + endMarker.length);
}

/** Run a statement under a named role, restoring the session role afterwards. */
async function asRole(role: string, sql: string, params: unknown[] = []): Promise<pg.QueryResult> {
  await c.query(`SET ROLE ${role}`);
  try {
    return await c.query(sql, params);
  } finally {
    await c.query('RESET ROLE');
  }
}

describe('ABC-26 · filter_academy_priority_ids is retired, not merely unused', () => {
  it('the object SURVIVES with its exact signature — a DROP would have broken generated types', async () => {
    const { rows } = await c.query(
      `SELECT p.oid::regprocedure::text  AS sig,
              oidvectortypes(p.proargtypes) AS ident,
              p.prosecdef                 AS security_definer,
              p.proconfig                 AS config,
              pg_get_userbyid(p.proowner) AS owner
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'filter_academy_priority_ids'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ident).toBe(RETIRED_FILTER_IDENT);
    // The SECURITY DEFINER chain is preserved deliberately: retiring by REVOKE while silently
    // flipping the function to INVOKER would change what a future re-grant would mean.
    expect(rows[0].security_definer).toBe(true);
    expect(rows[0].config).toContain('search_path=public');
    // The owner must NOT be a role PostgREST can assume, or its ownership privilege IS reach.
    expect(['anon', 'authenticated', 'service_role']).not.toContain(rows[0].owner);
  });

  it('proacl is NOT NULL — a NULL ACL on a function means EXECUTE TO PUBLIC', async () => {
    const { rows } = await c.query(
      `SELECT p.proacl IS NULL AS is_null FROM pg_proc p
         WHERE p.oid = $1::regprocedure`,
      [RETIRED_FILTER],
    );
    expect(rows[0].is_null).toBe(false);
  });

  it('EXPLICIT ACL: PUBLIC and every named role hold ZERO privileges, and nothing is grantable', async () => {
    const { rows } = await c.query(
      `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
              a.privilege_type,
              a.is_grantable
         FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
        WHERE p.oid = $1::regprocedure
        ORDER BY 1, 2`,
      [RETIRED_FILTER],
    );
    const owner = (await c.query(
      `SELECT pg_get_userbyid(p.proowner) AS owner FROM pg_proc p WHERE p.oid = $1::regprocedure`,
      [RETIRED_FILTER],
    )).rows[0].owner;

    // PUBLIC is asserted BY NAME: it is grantee 0 and never appears under a role name, so a guard
    // written only over role names misses the widest grantee there is.
    expect(rows.filter((r) => r.grantee === 'PUBLIC')).toEqual([]);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(rows.filter((r) => r.grantee === role)).toEqual([]);
    }
    // The owner's ownership entry is the ONLY thing allowed to remain.
    expect([...new Set(rows.map((r) => r.grantee))].filter((g) => g !== owner)).toEqual([]);
    // A GRANT OPTION anywhere is a standing licence to undo this retirement without editing the
    // migration, so it is checked separately from who holds the privilege.
    expect(rows.filter((r) => r.is_grantable)).toEqual([]);
  });

  it('EFFECTIVE privilege: no non-superuser role can execute it, inheritance included', async () => {
    const { rows } = await c.query(
      `SELECT r.rolname
         FROM pg_roles r
        WHERE NOT r.rolsuper
          AND r.rolname NOT LIKE 'pg\\_%'
          AND r.rolname <> (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid = $1::regprocedure)
          AND has_function_privilege(r.rolname, $1, 'EXECUTE')
        ORDER BY 1`,
      [RETIRED_FILTER],
    );
    expect(rows.map((r) => r.rolname)).toEqual([]);
  });

  it('the three named roles exist — otherwise every assertion above is vacuous', async () => {
    const { rows } = await c.query(
      `SELECT rolname FROM pg_roles WHERE rolname = ANY($1) ORDER BY 1`,
      [['anon', 'authenticated', 'service_role']],
    );
    expect(rows.map((r) => r.rolname)).toEqual(['anon', 'authenticated', 'service_role']);
  });

  it.each(['anon', 'authenticated', 'service_role'])(
    'REAL SET ROLE: %s calling it is refused by the executor, not just by the catalog',
    async (role) => {
      await expect(
        asRole(role, `SELECT * FROM public.filter_academy_priority_ids($1, NULL, NULL)`, [IDS.attackerAcademy]),
      ).rejects.toThrow(/permission denied/i);
    },
  );

  it('POSITIVE CONTROL: even the owner gets ZERO rows — the body is fail-closed, not just unreachable', async () => {
    // Inputs that the pre-ABC-26 function would have admitted: a guest this academy really owns,
    // and a real profile id. If the retirement were privilege-only, this would return rows.
    const { rows } = await c.query(
      `SELECT * FROM public.filter_academy_priority_ids($1, $2::uuid[], $3::uuid[])`,
      [IDS.attackerAcademy, [IDS.bookedProfile], [IDS.guestOwnedByAttackerAcademy]],
    );
    expect(rows).toEqual([]);
  });

  it('POSITIVE CONTROL: the client roles CAN still call an unrelated function', async () => {
    // Without this, "permission denied" above could equally mean the fixture broke role setup.
    const { rows } = await asRole(
      'service_role',
      `SELECT has_function_privilege('service_role','public.guest_belongs_to_user_academy(uuid,uuid)','EXECUTE') AS ok`,
    );
    expect(rows[0].ok).toBe(true);
  });

  it('CONSUMER INVENTORY: no other database function still calls the retired filter', async () => {
    const { rows } = await c.query(
      `SELECT n.nspname || '.' || p.proname AS fn
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname <> 'filter_academy_priority_ids'
          AND p.prosrc LIKE '%filter_academy_priority_ids%'
        ORDER BY 1`,
    );
    expect(rows.map((r) => r.fn)).toEqual([]);
  });

  // ── Drift: re-grant, dirty install, reapply ────────────────────────────────────────────────

  it('DIRTY INSTALL: a direct re-GRANT is undone by re-applying the migration', async () => {
    await c.query(`GRANT EXECUTE ON FUNCTION ${RETIRED_FILTER} TO service_role`);
    const granted = await c.query(
      `SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok`, [RETIRED_FILTER],
    );
    expect(granted.rows[0].ok).toBe(true);   // the drift is real before we repair it

    await applyH0(async (sql: string) => { await c.query(sql); });

    const repaired = await c.query(
      `SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok`, [RETIRED_FILTER],
    );
    expect(repaired.rows[0].ok).toBe(false);
  });

  it('DEFAULT GRANTS: a fresh CREATE OR REPLACE does not silently re-open it', async () => {
    // Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE on NEW functions to the three client
    // roles. CREATE OR REPLACE keeps the existing ACL rather than re-applying defaults — but the
    // migration must not depend on that subtlety, so this asserts the end state after a replace.
    await c.query(`
      CREATE OR REPLACE FUNCTION public.filter_academy_priority_ids(
        _academy_profile_id uuid, _profile_ids uuid[] DEFAULT NULL, _guest_ids uuid[] DEFAULT NULL)
      RETURNS TABLE (profile_id uuid, guest_player_id uuid)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
      AS $$ SELECT NULL::uuid, NULL::uuid WHERE false $$;`);
    await applyH0(async (sql: string) => { await c.query(sql); });
    const { rows } = await c.query(
      `SELECT has_function_privilege('anon', $1, 'EXECUTE')          AS anon,
              has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', $1, 'EXECUTE')  AS service_role`,
      [RETIRED_FILTER],
    );
    expect(rows[0]).toEqual({ anon: false, authenticated: false, service_role: false });
  });

  it('INHERITANCE TRIPWIRE: a grant reached through role membership FAILS the install assertion', async () => {
    // Make the helper the owner, then inherit that ownership privilege. This leaves no explicit
    // non-owner grant for the earlier ACL assertion to catch, isolating the effective check.
    const originalOwner = (await c.query(
      `SELECT pg_get_userbyid(p.proowner) AS owner FROM pg_proc p WHERE p.oid = $1::regprocedure`,
      [RETIRED_FILTER],
    )).rows[0].owner;

    await c.query('BEGIN');
    try {
      await c.query(`CREATE ROLE abc26_helper NOLOGIN`);
      await c.query(`GRANT CREATE ON SCHEMA public TO abc26_helper`);
      await c.query(`ALTER FUNCTION ${RETIRED_FILTER} OWNER TO abc26_helper`);
      await c.query(`REVOKE ALL ON FUNCTION ${RETIRED_FILTER} FROM anon, authenticated, service_role`);
      await c.query(`GRANT abc26_helper TO service_role`);

      const effective = await c.query(
        `SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok`, [RETIRED_FILTER],
      );
      expect(effective.rows[0].ok).toBe(true);

      const direct = await c.query(
        `SELECT count(*)::int AS n
           FROM pg_proc p
           CROSS JOIN LATERAL aclexplode(p.proacl) a
           JOIN pg_roles r ON r.oid = a.grantee
          WHERE p.oid = $1::regprocedure
            AND r.rolname = 'service_role'
            AND a.privilege_type = 'EXECUTE'`,
        [RETIRED_FILTER],
      );
      expect(direct.rows[0].n).toBe(0);

      await expect(c.query(abc26AssertionSql())).rejects.toThrow(
        /ABC-26: role\(s\) can still execute the retired priority filter \(effective, including inherited\): service_role/,
      );
    } finally {
      await c.query('ROLLBACK');
    }

    const restored = await c.query(
      `SELECT pg_get_userbyid(p.proowner) AS owner,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_can_execute
         FROM pg_proc p WHERE p.oid = $1::regprocedure`,
      [RETIRED_FILTER],
    );
    expect(restored.rows[0]).toEqual({ owner: originalOwner, service_role_can_execute: false });
    const helper = await c.query(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'abc26_helper') AS exists`);
    expect(helper.rows[0].exists).toBe(false);
  });
});

describe('ABC-26 · can_book_member_window is narrowed, not deleted', () => {
  // A world of its OWN, so no assertion here depends on state another describe block set up, and
  // nothing here perturbs state another block relies on.
  const CYCLE = '90000000-0000-0000-0000-0000000026a1';
  const SEAT_SLOT = '30000000-0000-0000-0000-0000000026a1';
  const CLAIM_SLOT = '30000000-0000-0000-0000-0000000026a2';
  // Three distinct subjects, one per arm, so a positive can never mask a negative:
  const SEAT_PROFILE = '10000000-0000-0000-0000-0000000026a1';
  const SEAT_USER = '60000000-0000-0000-0000-0000000026a1';
  const CLAIM_PROFILE = '10000000-0000-0000-0000-0000000026a2';
  const CLAIM_USER = '60000000-0000-0000-0000-0000000026a2';
  /** In the stored priority list and NOTHING else — no seat, no claim. The whole point. */
  const LISTED_PROFILE = '10000000-0000-0000-0000-0000000026a3';
  const LISTED_USER = '60000000-0000-0000-0000-0000000026a3';

  beforeAll(async () => {
    await c.query(
      `INSERT INTO auth.users (id, email) VALUES ($1,'seat@abc26.test'),($2,'claim@abc26.test'),($3,'listed@abc26.test')
       ON CONFLICT (id) DO NOTHING`,
      [SEAT_USER, CLAIM_USER, LISTED_USER],
    );
    await c.query(
      `INSERT INTO public.profiles (id, user_id, full_name) VALUES ($1,$2,'Seat'),($3,$4,'Claim'),($5,$6,'Listed')
       ON CONFLICT (id) DO NOTHING`,
      [SEAT_PROFILE, SEAT_USER, CLAIM_PROFILE, CLAIM_USER, LISTED_PROFILE, LISTED_USER],
    );
    // A cycle whose stored settings STILL carry a supplementary priority list — exactly the state
    // every pre-ABC-26 round is in. Nothing deletes it; the predicate must stop honouring it.
    await c.query(
      `INSERT INTO public.cycles (id, settings, owner_type, owner_id, type)
       VALUES ($1, jsonb_build_object('rebook_priority_people', jsonb_build_array($2::text)), 'academy', $3, 'cyclus')
       ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings`,
      [CYCLE, LISTED_PROFILE, IDS.attackerAcademy],
    );
    // cyclus_id feeds arm (a); source_cycle_id feeds arm (b). Two slots so neither arm can be
    // satisfied by accident through the other's join.
    await c.query(
      `INSERT INTO public.availability_slots (id, academy_profile_id, cyclus_id) VALUES ($1,$2,$3)
       ON CONFLICT (id) DO NOTHING`,
      [SEAT_SLOT, IDS.attackerAcademy, CYCLE],
    );
    await c.query(
      `INSERT INTO public.availability_slots (id, academy_profile_id, source_cycle_id) VALUES ($1,$2,$3)
       ON CONFLICT (id) DO NOTHING`,
      [CLAIM_SLOT, IDS.attackerAcademy, CYCLE],
    );
    await c.query(
      `INSERT INTO public.bookings (slot_id, player_id, status) VALUES ($1,$2,'confirmed')`,
      [SEAT_SLOT, SEAT_PROFILE],
    );
    await c.query(
      `INSERT INTO public.slot_priority_claims (slot_id, player_id, guest_player_id) VALUES ($1,$2,NULL)`,
      [CLAIM_SLOT, CLAIM_PROFILE],
    );
  }, 60_000);

  it('NEGATIVE: a profile named ONLY in a stored rebook_priority_people list gets no member window', async () => {
    const { rows } = await c.query(`SELECT public.can_book_member_window($1,$2) AS ok`, [LISTED_USER, CYCLE]);
    expect(rows[0].ok).toBe(false);
  });

  it('the stored list is still THERE — containment suppresses on read, it does not rewrite rows', async () => {
    const { rows } = await c.query(
      `SELECT settings->'rebook_priority_people' AS list FROM public.cycles WHERE id = $1`, [CYCLE],
    );
    expect(rows[0].list).toEqual([LISTED_PROFILE]);
  });

  it('POSITIVE (arm a): a pure-profile SEAT in the cycle still grants the member window', async () => {
    const { rows } = await c.query(`SELECT public.can_book_member_window($1,$2) AS ok`, [SEAT_USER, CYCLE]);
    expect(rows[0].ok).toBe(true);
  });

  it('POSITIVE (arm b): a pure-profile CLAIM in the round still grants the member window', async () => {
    const { rows } = await c.query(`SELECT public.can_book_member_window($1,$2) AS ok`, [CLAIM_USER, CYCLE]);
    expect(rows[0].ok).toBe(true);
  });

  it('a DUAL-KEY (guest-backed) claim grants nothing — the A3 narrowing still holds', async () => {
    const dualUser = '60000000-0000-0000-0000-0000000026a4';
    const dualProfile = '10000000-0000-0000-0000-0000000026a4';
    await c.query(`INSERT INTO auth.users (id, email) VALUES ($1,'dual@abc26.test') ON CONFLICT (id) DO NOTHING`, [dualUser]);
    await c.query(`INSERT INTO public.profiles (id, user_id, full_name) VALUES ($1,$2,'Dual') ON CONFLICT (id) DO NOTHING`, [dualProfile, dualUser]);
    // Their ONLY evidence is a claim that also names a guest — the shape A3 withdrew.
    await c.query(
      `INSERT INTO public.slot_priority_claims (slot_id, player_id, guest_player_id) VALUES ($1,$2,$3)`,
      [CLAIM_SLOT, dualProfile, IDS.guestOwnedByAttackerAcademy],
    );
    const { rows } = await c.query(`SELECT public.can_book_member_window($1,$2) AS ok`, [dualUser, CYCLE]);
    expect(rows[0].ok).toBe(false);
  });

  it('MUTATION TRIPWIRE: re-adding the settings arm makes the install assertion FAIL', async () => {
    // A guard is only worth having if removing what it protects turns the suite red. Put the
    // withdrawn arm back, prove it genuinely restores the capability, then run only the shipped
    // assertion block against those mutant bytes.
    await c.query('BEGIN');
    try {
      await c.query(`
        CREATE OR REPLACE FUNCTION public.can_book_member_window(_user_id uuid, _cycle_id uuid)
        RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
        AS $fn$
          WITH me AS (SELECT id FROM public.profiles WHERE user_id = _user_id LIMIT 1)
          SELECT EXISTS (
            SELECT 1 FROM public.bookings b
            JOIN public.availability_slots s ON s.id = b.slot_id
            WHERE s.cyclus_id = _cycle_id
              AND COALESCE(b.status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap')
              AND b.guest_player_id IS NULL AND b.player_id = (SELECT id FROM me))
          OR EXISTS (
            SELECT 1 FROM public.slot_priority_claims spc
            JOIN public.availability_slots s ON s.id = spc.slot_id
            WHERE s.source_cycle_id = _cycle_id
              AND spc.player_id = (SELECT id FROM me) AND spc.guest_player_id IS NULL)
          OR EXISTS (
            SELECT 1 FROM public.cycles c WHERE c.id = _cycle_id
              AND COALESCE(c.settings->'rebook_priority_people', '[]'::jsonb) ? (SELECT id::text FROM me));
        $fn$;`);
      const { rows } = await c.query(`SELECT public.can_book_member_window($1,$2) AS ok`, [LISTED_USER, CYCLE]);
      expect(rows[0].ok).toBe(true);   // the mutant really does re-open it
      await expect(c.query(abc26AssertionSql())).rejects.toThrow(
        /ABC-26: can_book_member_window must not read a stored priority list/,
      );
    } finally {
      await c.query('ROLLBACK');
    }
    const { rows: after } = await c.query(`SELECT public.can_book_member_window($1,$2) AS ok`, [LISTED_USER, CYCLE]);
    expect(after[0].ok).toBe(false);
  });
});
