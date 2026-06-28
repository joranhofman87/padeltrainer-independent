// E1 — cross-tenant isolation: an academy manager must not be able to read ANOTHER
// academy's data through the scoped read-RPCs that front every cross-academy read in
// the app (get_players_overview, get_academy_invoices, get_academy_invoice_summary).
// Each RPC's FIRST statement is `IF NOT is_academy_manager(auth.uid(), <scope>) THEN
// RAISE 'not authorized for academy' USING ERRCODE='42501'`, evaluated BEFORE any data
// table is read — so this runs the REAL RPCs + the REAL is_academy_manager against
// PGlite and proves the deny path with only academy_managers seeded (check_function_bodies
// = off lets the RPCs create without their full data schema; the deny path never reaches it).
//
// Scope: this covers the RPC read paths the app actually uses for cross-academy data.
// Behavioural verification of the raw-table RLS backstop (a crafted direct
// `from('invoices').eq('academy_profile_id', other)`) needs the full cumulative policy
// set and is exercised by `supabase db reset` (CI) — it can't be faithfully replayed in
// PGlite because those policies are spread across dozens of churning migrations.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? (pass++, console.log('PASS', m)) : (fail++, console.error('FAIL', m, JSON.stringify(x ?? ''))); };

const ACAD_A = '40000000-0000-0000-0000-00000000000a';
const ACAD_B = '40000000-0000-0000-0000-00000000000b';
const MGR_A = '41000000-0000-0000-0000-00000000000a'; // auth user that manages academy A
const OUTSIDER = '41000000-0000-0000-0000-0000000000ff'; // manages no academy

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('rehearse.uid', true), '')::uuid $$;

  -- The REAL authorization table + function under test (verbatim from migration
  -- 20260128121147 — a plain membership EXISTS on academy_managers).
  CREATE TABLE public.academy_managers (user_id uuid, academy_profile_id uuid);
  CREATE FUNCTION public.is_academy_manager(_user_id uuid, _academy_profile_id uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.academy_managers
      WHERE user_id = _user_id AND academy_profile_id = _academy_profile_id
    )
  $$;

  -- MGR_A manages ONLY academy A.
  INSERT INTO public.academy_managers (user_id, academy_profile_id) VALUES ('${MGR_A}', '${ACAD_A}');
`);

// Create the REAL gated read-RPCs without standing up their full data schema. The gate
// short-circuits before any data read, so the deny path is faithful.
await db.exec(`SET check_function_bodies = off;`);
await db.exec(readFileSync('supabase/migrations/20260611160001_get_players_overview.sql', 'utf8'));
await db.exec(readFileSync('supabase/migrations/20260614160000_paginated_invoice_rpcs.sql', 'utf8'));

// Sanity: the REAL authz function denies cross-academy and grants own-academy.
ok((await db.query(`SELECT public.is_academy_manager('${MGR_A}','${ACAD_A}') AS r`)).rows[0].r === true,
  'is_academy_manager(MGR_A, ACADEMY_A) = true (manages own academy)');
ok((await db.query(`SELECT public.is_academy_manager('${MGR_A}','${ACAD_B}') AS r`)).rows[0].r === false,
  'is_academy_manager(MGR_A, ACADEMY_B) = false (not a manager of B)');

// Strict: the refusal must be the gate's own 42501 (insufficient_privilege), not
// some incidental error — otherwise the test could pass for the wrong reason.
const denies = async (label, sql) => {
  let denied = false, code = null;
  try { await db.query(sql); } catch (e) { denied = true; code = e?.code ?? null; }
  ok(denied && code === '42501', label, { denied, code });
};

// ---- as MGR_A (manager of A only) ----
await db.exec(`SET rehearse.uid = '${MGR_A}';`);

// Positive control: MGR_A PASSES the gate for their OWN academy — proving the gate
// discriminates by academy, not a blanket deny. The call then errors on the absent
// data tables (42P01, deny-path-only schema), which is NOT the 42501 auth refusal.
const passesGate = async (label, sql) => {
  let code = 'ok';
  try { await db.query(sql); } catch (e) { code = e?.code ?? 'unknown'; }
  ok(code !== '42501', label, { code });
};
await passesGate(
  'MGR_A PASSES the gate for their OWN academy A (get_players_overview scope=A -> not 42501)',
  `SELECT * FROM public.get_players_overview('academy','${ACAD_A}')`,
);

await denies(
  "MGR_A cannot read academy B's PLAYERS (get_players_overview scope=B -> 42501)",
  `SELECT * FROM public.get_players_overview('academy','${ACAD_B}')`,
);
await denies(
  "MGR_A cannot read academy B's INVOICES (get_academy_invoices academy=B -> 42501)",
  `SELECT * FROM public.get_academy_invoices('${ACAD_B}')`,
);
await denies(
  "MGR_A cannot read academy B's INVOICE SUMMARY (get_academy_invoice_summary academy=B -> 42501)",
  `SELECT * FROM public.get_academy_invoice_summary('${ACAD_B}')`,
);

// ---- as an OUTSIDER (manages no academy) ----
await db.exec(`SET rehearse.uid = '${OUTSIDER}';`);
await denies(
  "an OUTSIDER cannot read academy A's players (get_players_overview scope=A -> 42501)",
  `SELECT * FROM public.get_players_overview('academy','${ACAD_A}')`,
);
await denies(
  "an OUTSIDER cannot read academy A's invoices (get_academy_invoices academy=A -> 42501)",
  `SELECT * FROM public.get_academy_invoices('${ACAD_A}')`,
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
