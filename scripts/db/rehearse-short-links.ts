/**
 * PGlite rehearsal for the short-link primitive (20260825100000_short_links.sql).
 * Real Postgres in WASM; runs the ACTUAL migration against a synthetic schema and asserts:
 *   - get_or_create_short_link is IDEMPOTENT (same destination → same code, one row);
 *   - resolve_short_link round-trips (code → target_path + permanent);
 *   - the open-redirect guard rejects host-absolute and protocol-relative targets;
 *   - a code collision is re-rolled (insert-retry recovers, returns a fresh code);
 *   - inserting a registration eagerly mints its short link via the AFTER INSERT trigger,
 *     and that trigger is best-effort (a mint failure never blocks the insert).
 *
 * Run: npx tsx scripts/db/rehearse-short-links.ts
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const db = new PGlite();
let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `  → ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
};

const REG1 = '11111111-1111-1111-1111-111111111111';
const REG2 = '22222222-2222-2222-2222-222222222222';

// ── Synthetic schema + stubs (must exist BEFORE the migration runs) ──
await db.exec(`
CREATE ROLE anon;
CREATE ROLE authenticated;
-- Model Supabase: default privileges auto-grant EXECUTE on every NEW public function to anon +
-- authenticated. Without this the anon-mint hole is invisible in a bare Postgres (this is exactly
-- what let the original bug ship green). Must run BEFORE the migration creates its functions.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;

-- pgcrypto's gen_random_bytes isn't loaded in PGlite; the migration relies on the public shim
-- (20260506080530). Stub it with plain random bytes — good enough for mint/resolve/trigger.
CREATE FUNCTION public.gen_random_bytes(len integer) RETURNS bytea
  LANGUAGE plpgsql VOLATILE AS $$
  DECLARE b bytea := decode(repeat('00', len), 'hex'); i int;
  BEGIN
    FOR i IN 0..len-1 LOOP b := set_byte(b, i, (random()*255)::int); END LOOP;
    RETURN b;
  END $$;

-- Minimal registrations table so the migration can attach its trigger + run its backfill.
CREATE TABLE public.registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type text NOT NULL DEFAULT 'academy',
  status text NOT NULL DEFAULT 'draft'
);
`);

// ── Apply the ACTUAL migration ──
const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260825100000_short_links.sql'),
  'utf8',
);
await db.exec(migration);
// The security fix (revoke anon EXECUTE on the mint/read RPCs) is part of the deployed schema.
const revokeMigration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260825110000_short_links_revoke_anon.sql'),
  'utf8',
);
await db.exec(revokeMigration);

// ── 1. idempotency ──
const c1 = (await db.query<{ get_or_create_short_link: string }>(
  `SELECT public.get_or_create_short_link('/nl/register/${REG1}', 'registration', '${REG1}', '{}'::jsonb, true)`
)).rows[0].get_or_create_short_link;
const c2 = (await db.query<{ get_or_create_short_link: string }>(
  `SELECT public.get_or_create_short_link('/nl/register/${REG1}', 'registration', '${REG1}', '{}'::jsonb, true)`
)).rows[0].get_or_create_short_link;
const rows1 = (await db.query<{ n: number }>(
  `SELECT count(*)::int AS n FROM public.short_links WHERE target_type='registration' AND target_id='${REG1}'`
)).rows[0].n;
check('idempotent: same target → same code', c1 === c2, { c1, c2 });
check('idempotent: exactly one row for the target', rows1 === 1, { rows1 });
check('code is 7 chars base62', /^[0-9A-Za-z]{7}$/.test(c1), c1);

// ── 2. resolve round-trip ──
const resolved = (await db.query<{ target_path: string; permanent: boolean }>(
  `SELECT * FROM public.resolve_short_link('${c1}')`
)).rows[0];
check('resolve: returns target_path', resolved?.target_path === `/nl/register/${REG1}`, resolved);
check('resolve: permanent=true → 301', resolved?.permanent === true, resolved);
const missing = (await db.query(`SELECT * FROM public.resolve_short_link('nope___')`)).rows.length;
check('resolve: unknown code → no row', missing === 0, { missing });

// batch reverse lookup (target → code) used by the admin listing join
const codes = (await db.query<{ target_id: string; code: string }>(
  `SELECT * FROM public.get_short_codes('registration', ARRAY['${REG1}','${REG2}']::uuid[])`
)).rows;
check('get_short_codes: returns the minted code for a known target', codes.some((r) => r.target_id === REG1 && r.code === c1), codes);

// ── 3. open-redirect guard ──
for (const bad of ['//evil.com', 'https://evil.com', 'ftp://x', 'evil']) {
  let raised = false;
  try {
    await db.query(`SELECT public.get_or_create_short_link($1, 'x', NULL, '{}'::jsonb, true)`, [bad]);
  } catch { raised = true; }
  check(`open-redirect guard rejects ${JSON.stringify(bad)}`, raised);
}

// ── 3b. RPC execute grants: anon may RESOLVE but must NOT MINT (the Supabase default-privileges hole) ──
await db.exec(`SET ROLE authenticated`);
let authMint = false;
try {
  await db.query(`SELECT public.get_or_create_short_link('/nl/register/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'registration', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{}'::jsonb, true)`);
  authMint = true;
} catch { authMint = false; }
await db.exec(`RESET ROLE`);
check('grants: authenticated CAN mint', authMint);

await db.exec(`SET ROLE anon`);
let anonMint = true;
try {
  await db.query(`SELECT public.get_or_create_short_link('/nl/x', 'registration', NULL, '{}'::jsonb, true)`);
  anonMint = true;
} catch { anonMint = false; }
let anonResolve = false;
try {
  await db.query(`SELECT * FROM public.resolve_short_link('${c1}')`);
  anonResolve = true;
} catch { anonResolve = false; }
await db.exec(`RESET ROLE`);
check('grants: anon CANNOT mint (revoked)', !anonMint);
check('grants: anon CAN still resolve', anonResolve);

// ── 4. collision recovery (deterministic gen_short_code override) ──
// A SEQUENCE (not a table counter) is essential here: the failed first insert rolls back its
// subtransaction, and a table UPDATE would roll back with it — regenerating the same code forever.
// nextval() is non-transactional, so it survives the rollback and yields a fresh code on retry —
// exactly like the real gen_random_bytes producing fresh entropy each call.
await db.exec(`
CREATE SEQUENCE public._codeseq START 5;
CREATE OR REPLACE FUNCTION public.gen_short_code(_len int DEFAULT 7) RETURNS text
  LANGUAGE plpgsql VOLATILE AS $$
  BEGIN RETURN 'CODE' || lpad(nextval('public._codeseq')::text, 3, '0'); END $$;   -- CODE005, CODE006, …
-- Occupy CODE005 with an unrelated target so the next mint's first roll collides on the PK.
INSERT INTO public.short_links(code, target_path, target_type, target_id)
  VALUES ('CODE005', '/nl/occupied', 'other', NULL);
`);
const collided = (await db.query<{ get_or_create_short_link: string }>(
  `SELECT public.get_or_create_short_link('/nl/register/${REG2}', 'registration', '${REG2}', '{}'::jsonb, true)`
)).rows[0].get_or_create_short_link;
check('collision: first roll (CODE005) taken → re-rolls to CODE006', collided === 'CODE006', { collided });

// ── 5. eager mint trigger (best-effort) ──
// Restore a working random generator first so the trigger can mint.
await db.exec(`
CREATE OR REPLACE FUNCTION public.gen_short_code(_len int DEFAULT 7) RETURNS text
  LANGUAGE plpgsql VOLATILE AS $$
  DECLARE alphabet constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    out text := ''; b bytea := public.gen_random_bytes(_len); i int;
  BEGIN
    FOR i IN 0.._len-1 LOOP out := out || substr(alphabet, (get_byte(b,i) % 62) + 1, 1); END LOOP;
    RETURN out;
  END $$;
`);
const newReg = '33333333-3333-3333-3333-333333333333';
await db.query(`INSERT INTO public.registrations(id, owner_type, status) VALUES ($1, 'academy', 'open')`, [newReg]);
const minted = (await db.query<{ target_path: string }>(
  `SELECT target_path FROM public.short_links WHERE target_type='registration' AND target_id='${newReg}'`
)).rows[0];
check('trigger: inserting a registration mints its short link', minted?.target_path === `/nl/register/${newReg}`, minted);

// best-effort: even if the mint blows up, the registration insert must still succeed.
// Force a failure deep inside get_or_create by making code generation raise (same signature,
// so CREATE OR REPLACE is legal). The raise is NOT unique_violation, so it propagates out of
// get_or_create and must be caught by the trigger's EXCEPTION WHEN OTHERS.
await db.exec(`
CREATE OR REPLACE FUNCTION public.gen_short_code(_len int DEFAULT 7) RETURNS text
  LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$;
`);
let insertOk = false;
const bombReg = '44444444-4444-4444-4444-444444444444';
try {
  await db.query(`INSERT INTO public.registrations(id, owner_type, status) VALUES ($1, 'academy', 'open')`, [bombReg]);
  insertOk = true;
} catch { insertOk = false; }
check('trigger: best-effort — a mint failure does NOT block the registration insert', insertOk);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
