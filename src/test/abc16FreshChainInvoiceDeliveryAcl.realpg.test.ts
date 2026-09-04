// @vitest-environment node
//
// Pass B §1b ON A FRESH CHAIN — get_invoices_delivery_status's EXECUTE trio must come from the
// containment migration itself, never from a default privilege a fixture installed.
//
// THE DEFECT THIS PINS. The hosted project's default ACL grants EXECUTE on every new public
// function to anon, authenticated and service_role, and the ABC-16 fixture reproduces that
// (abc16Fixture.ts, STUB_SQL) so the containment's REVOKEs are proved against the real platform
// default. That fidelity has a blind side: a migration that GRANTS TOO LITTLE looks correct there,
// because the default supplies the rest. A fresh local stack — `supabase start`, `supabase db
// reset`, and therefore CI's "Migrations and types" workflow — adds no client-role grant to a new
// public function at all (measured 2026-09-04 on supabase/postgres 17.6.1.136 under CLI 2.107.0:
// a function `postgres` creates has a NULL proacl, i.e. PostgreSQL's own PUBLIC EXECUTE and
// nothing else). There, §1b's first revision re-created the function, revoked PUBLIC and anon,
// granted only authenticated, and its own install guard refused the whole file:
// "get_invoices_delivery_status must stay callable by service_role".
//
// So this suite applies the same pre-H0 chain, then WITHDRAWS the fixture's function default
// before H0, proves from the catalog that no default grants the client roles EXECUTE, and only
// then applies the containment. Every EXECUTE the trio then holds is one the file granted.
//
// Three databases on one embedded server, one per question:
//   fresh  — the shipped file applies on a chain with no function default, and the trio holds
//            as an executed fact (service_role runs the function; anon is refused);
//   mutant — the shipped file with `service_role` removed from the §1b GRANT is REFUSED by its
//            own guard here, so the guard is live and this is the environment that sees it;
//   masked — that same mutant applies cleanly under the fixture default, which is exactly why a
//            regression that leaned on the default could never have caught the defect.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPreH0, H0_MIGRATION, MIGRATION } from './abc16Fixture';

const { Client } = pg;
const PORT = 54417;

const FN = 'public.get_invoices_delivery_status(uuid[])';
/** The shipped §1b grant, as one exact line — the mutation below must find exactly this. */
const SHIPPED_GRANT = 'GRANT EXECUTE ON FUNCTION public.get_invoices_delivery_status(uuid[]) TO authenticated, service_role;';
const MUTANT_GRANT = 'GRANT EXECUTE ON FUNCTION public.get_invoices_delivery_status(uuid[]) TO authenticated;';
/** Withdraw the fixture's platform-shaped function default: what a fresh local stack never had. */
const WITHDRAW_FUNCTION_DEFAULT =
  'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated, service_role';

let epg: InstanceType<typeof EmbeddedPostgres> | undefined;
let admin: pg.Client;
const clients: pg.Client[] = [];

const connection = (database: string) => {
  const c = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/${database}` });
  clients.push(c);
  return c;
};

async function freshDatabase(name: string): Promise<pg.Client> {
  await admin.query(`CREATE DATABASE ${name}`);
  const c = connection(name);
  await c.connect();
  await applyPreH0(async (sql) => { await c.query(sql); });
  return c;
}

/** Every pg_default_acl row in `public` that hands a client role EXECUTE on new functions. */
async function clientFunctionDefaults(c: pg.Client): Promise<string[]> {
  const { rows } = await c.query<{ grantee: string; acl: string }>(`
    SELECT r.rolname AS grantee, d.defaclacl::text AS acl
      FROM pg_default_acl d
      JOIN pg_namespace n ON n.oid = d.defaclnamespace
      CROSS JOIN LATERAL aclexplode(d.defaclacl) a
      JOIN pg_roles r ON r.oid = a.grantee
     WHERE n.nspname = 'public' AND d.defaclobjtype = 'f'
       AND a.privilege_type = 'EXECUTE'
       AND r.rolname IN ('anon', 'authenticated', 'service_role')
     ORDER BY 1`);
  return rows.map((r) => r.grantee);
}

async function trio(c: pg.Client) {
  const { rows } = await c.query(`
    SELECT has_function_privilege('anon', $1, 'EXECUTE') AS anon,
           has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated,
           has_function_privilege('service_role', $1, 'EXECUTE') AS service_role,
           EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
                    WHERE p.oid = $1::regprocedure AND a.grantee = 0) AS public_execute,
           (SELECT p.proacl IS NULL FROM pg_proc p WHERE p.oid = $1::regprocedure) AS acl_is_null`,
    [FN]);
  return rows[0] as { anon: boolean; authenticated: boolean; service_role: boolean; public_execute: boolean; acl_is_null: boolean };
}

const h0Mutant = () => {
  const src = MIGRATION(H0_MIGRATION);
  if (src.split(SHIPPED_GRANT).length !== 2) {
    throw new Error(`the containment migration must carry exactly one \`${SHIPPED_GRANT}\` — re-pin this suite if §1b's grant was re-worded`);
  }
  return src.replace(SHIPPED_GRANT, () => MUTANT_GRANT);
};

let fresh: pg.Client;
let mutant: pg.Client;
let masked: pg.Client;
let mutantRefusal: unknown;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abc16-fresh-chain-'));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  admin = connection('postgres');
  await admin.connect();

  // ── fresh: the shipped file on a chain with NO function default ──
  fresh = await freshDatabase('abc16_fresh');
  expect(await clientFunctionDefaults(fresh)).toEqual(['anon', 'authenticated', 'service_role']);
  await fresh.query(WITHDRAW_FUNCTION_DEFAULT);
  expect(await clientFunctionDefaults(fresh)).toEqual([]);
  await fresh.query(MIGRATION(H0_MIGRATION));

  // ── mutant: the same environment, service_role dropped from the §1b grant ──
  mutant = await freshDatabase('abc16_mutant');
  await mutant.query(WITHDRAW_FUNCTION_DEFAULT);
  expect(await clientFunctionDefaults(mutant)).toEqual([]);
  mutantRefusal = await mutant.query(h0Mutant()).then(() => null, (e: unknown) => e);

  // ── masked: the mutant under the fixture's platform default ──
  masked = await freshDatabase('abc16_masked');
  await masked.query(h0Mutant());
}, 240_000);

afterAll(async () => {
  for (const c of clients) { try { await c.end(); } catch { /* ignore */ } }
  try { await epg?.stop(); } catch { /* ignore */ }
});

describe('Pass B §1b on a fresh chain — get_invoices_delivery_status', () => {
  it('a chain with no function default privilege leaves a new function to PostgreSQL\'s PUBLIC default only', async () => {
    // The environment the suite claims to model, demonstrated on a throwaway function rather
    // than asserted: nothing but PUBLIC reaches it, and revoking PUBLIC leaves every client
    // role without EXECUTE — exactly what the shipped REVOKE does to §1b's function.
    await fresh.query(`CREATE FUNCTION public.abc16_fresh_probe() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$`);
    try {
      const before = (await fresh.query(`SELECT proacl IS NULL AS null_acl FROM pg_proc WHERE oid = 'public.abc16_fresh_probe()'::regprocedure`)).rows[0];
      expect(before.null_acl).toBe(true);
      await fresh.query('REVOKE ALL ON FUNCTION public.abc16_fresh_probe() FROM PUBLIC');
      const after = (await fresh.query(`
        SELECT has_function_privilege('anon', 'public.abc16_fresh_probe()', 'EXECUTE') AS anon,
               has_function_privilege('authenticated', 'public.abc16_fresh_probe()', 'EXECUTE') AS authenticated,
               has_function_privilege('service_role', 'public.abc16_fresh_probe()', 'EXECUTE') AS service_role`)).rows[0];
      expect(after).toEqual({ anon: false, authenticated: false, service_role: false });
    } finally {
      await fresh.query('DROP FUNCTION public.abc16_fresh_probe()');
    }
  });

  it('the shipped containment installs there, and the trio is exactly anon=f / authenticated=t / service_role=t with no PUBLIC arm', async () => {
    expect(await trio(fresh)).toEqual({
      anon: false, authenticated: true, service_role: true, public_execute: false, acl_is_null: false,
    });
    // The ACL names both callers explicitly — the property the fresh chain depends on.
    const { rows } = await fresh.query(`
      SELECT r.rolname AS grantee
        FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a JOIN pg_roles r ON r.oid = a.grantee
       WHERE p.oid = $1::regprocedure AND a.privilege_type = 'EXECUTE' AND r.rolname <> 'postgres'
       ORDER BY 1`, [FN]);
    expect(rows.map((r) => r.grantee)).toEqual(['authenticated', 'service_role']);
  });

  it('service_role can actually execute it, and anon is refused with 42501', async () => {
    await fresh.query('SET ROLE service_role');
    try {
      const { rows } = await fresh.query(`SELECT count(*)::int AS n FROM public.get_invoices_delivery_status(ARRAY[]::uuid[])`);
      expect(rows[0].n).toBe(0);
    } finally {
      await fresh.query('RESET ROLE');
    }
    await fresh.query('SET ROLE anon');
    try {
      await expect(fresh.query(`SELECT count(*) FROM public.get_invoices_delivery_status(ARRAY[]::uuid[])`))
        .rejects.toMatchObject({ code: '42501' });
    } finally {
      await fresh.query('RESET ROLE');
    }
  });

  it('with service_role removed from the §1b grant, the file\'s own guard refuses the install on that chain', () => {
    expect(mutantRefusal).toBeInstanceOf(Error);
    expect((mutantRefusal as Error).message).toMatch(/Pass B §1b: get_invoices_delivery_status must stay callable by service_role/);
  });

  it('...and the refusal rolled the whole file back: nothing the containment creates is installed', async () => {
    // One simple-protocol query, one implicit transaction: the guard's exception undoes the
    // DROP + CREATE with everything else, so the chain is left as it was, not half-migrated.
    // The pre-H0 fixture chain never defines this function (20260615110080 is not part of it),
    // so "as it was" means ABSENT — a partial apply would have left §1b's definition behind.
    // Two more objects the containment alone creates bracket §1b in the file: the guest-bridge
    // guard trigger (installed well before it) and the settlement authority (well after it).
    const BRACKETS = `
      to_regprocedure($1) IS NULL AS delivery_status_absent,
      NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = 'trg_guard_guest_bridge_columns'
                     AND t.tgrelid = 'public.guest_players'::regclass) AS early_object_absent,
      to_regprocedure('public.settle_paid_bookings(uuid[],text,text,uuid,uuid,uuid,text)') IS NULL AS late_object_absent`;
    const { rows } = await mutant.query(`SELECT ${BRACKETS}`, [FN]);
    expect(rows[0]).toEqual({ delivery_status_absent: true, early_object_absent: true, late_object_absent: true });
    // ...whereas the shipped file installed all three on the fresh chain.
    const { rows: shipped } = await fresh.query(`SELECT ${BRACKETS}`, [FN]);
    expect(shipped[0]).toEqual({ delivery_status_absent: false, early_object_absent: false, late_object_absent: false });
  });

  it('the same mutant applies CLEANLY under the fixture\'s platform default — the mask this suite exists to remove', async () => {
    // Under the hosted-shaped default the trio still reads correct, with service_role's EXECUTE
    // supplied by pg_default_acl rather than by the file. That is not a defect of the fixture —
    // it is what the hosted project does — but it is why "callable by service_role" had to be
    // proved on a chain that supplies nothing.
    expect(await clientFunctionDefaults(masked)).toEqual(['anon', 'authenticated', 'service_role']);
    expect(await trio(masked)).toMatchObject({ anon: false, authenticated: true, service_role: true, public_execute: false });
  });
});
