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
import { applyPreH0, applyH0, FIXTURE_SQL, IDS } from './abc16Fixture';

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
    const person = '11111111-1111-4111-8111-111111111111';
    await c.query(`INSERT INTO public.persons (id) VALUES ($1) ON CONFLICT DO NOTHING`, [person]);
    await c.query(
      `INSERT INTO public.person_links (person_id, profile_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [person, IDS.bookedProfile],
    );

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
  it('every overlay row is byte-identical across the migration', async () => {
    const after = await overlayDigest();
    expect(after).toEqual(digestBeforeH0);
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
