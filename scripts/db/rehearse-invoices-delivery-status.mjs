// Rehearsal for get_invoices_delivery_status's linked_email return + the
// caller-visibility gate (migration 110080). Proves: the resolved recipient
// email (profile -> guest -> null) is returned per invoice, and that a caller
// only ever sees rows (and therefore emails) for invoices they manage/own —
// no cross-tenant PII leak. Runs on PGlite with a stubbed delivery-status fn.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? (pass++, console.log('PASS', m)) : (fail++, console.error('FAIL', m, JSON.stringify(x ?? ''))); };

const T1 = '40000000-0000-0000-0000-000000000001', U1 = '40000000-0000-0000-0000-0000000000a1';
const T2 = '40000000-0000-0000-0000-000000000002', U2 = '40000000-0000-0000-0000-0000000000a2';
const AC1 = '40000000-0000-0000-0000-0000000000c1', UM = '40000000-0000-0000-0000-0000000000d1';
const P1 = '41000000-0000-0000-0000-000000000001', G1 = '42000000-0000-0000-0000-000000000001';
const id = (n) => `43000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('rehearse.uid', true), '')::uuid $$;

  CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text);
  CREATE TABLE public.guest_players (id uuid PRIMARY KEY, email text);
  CREATE TABLE public.academy_managers (user_id uuid, academy_profile_id uuid);
  CREATE TABLE public.invoices (
    id uuid PRIMARY KEY, academy_profile_id uuid, trainer_id uuid,
    player_id uuid, guest_player_id uuid);

  CREATE FUNCTION public.is_academy_manager(_uid uuid, _aid uuid) RETURNS boolean
    LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM public.academy_managers WHERE user_id = _uid AND academy_profile_id = _aid) $$;
  CREATE FUNCTION public.is_admin(_uid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;

  CREATE TABLE public._dstub (invoice_id uuid PRIMARY KEY, s text);
  CREATE FUNCTION public.get_invoice_delivery_status(p_id uuid) RETURNS text
    LANGUAGE sql STABLE AS $$ SELECT s FROM public._dstub WHERE invoice_id = p_id $$;

  INSERT INTO public.trainer_profiles VALUES ('${T1}', '${U1}'), ('${T2}', '${U2}');
  INSERT INTO public.profiles VALUES ('${P1}', 'p1@test.com');
  INSERT INTO public.guest_players VALUES ('${G1}', 'g1@test.com');
  INSERT INTO public.academy_managers VALUES ('${UM}', '${AC1}');

  -- T1-owned: profile email, guest email, no email
  INSERT INTO public.invoices VALUES ('${id(1)}', NULL, '${T1}', '${P1}', NULL);
  INSERT INTO public.invoices VALUES ('${id(2)}', NULL, '${T1}', NULL, '${G1}');
  INSERT INTO public.invoices VALUES ('${id(3)}', NULL, '${T1}', NULL, NULL);
  -- other trainer's invoice + an academy invoice U1 must NOT see
  INSERT INTO public.invoices VALUES ('${id(4)}', NULL, '${T2}', '${P1}', NULL);
  INSERT INTO public.invoices VALUES ('${id(5)}', '${AC1}', NULL, '${P1}', NULL);
  INSERT INTO public._dstub VALUES ('${id(1)}', 'delivered'), ('${id(2)}', 'bounced');
`);

await db.exec(readFileSync('supabase/migrations/20260615110080_invoices_delivery_status_linked_email.sql', 'utf8'));

const all = [id(1), id(2), id(3), id(4), id(5)];
const call = async (uid, ids) => {
  await db.exec(`SET rehearse.uid = '${uid}';`);
  const r = await db.query(
    `SELECT invoice_id, delivery_status, linked_email FROM public.get_invoices_delivery_status(ARRAY[${ids.map((x) => `'${x}'`).join(',')}]::uuid[]);`);
  return r.rows;
};

// ---- as the owning trainer ----
const t1rows = await call(U1, all);
const t1ids = t1rows.map((r) => r.invoice_id).sort();
ok(t1ids.length === 3 && t1ids.includes(id(1)) && t1ids.includes(id(2)) && t1ids.includes(id(3)),
  'trainer sees exactly their own 3 invoices', t1ids);
ok(!t1ids.includes(id(4)), 'trainer does NOT see another trainer\'s invoice (no cross-tenant row)');
ok(!t1ids.includes(id(5)), 'trainer does NOT see an academy invoice they don\'t manage');

const byId = Object.fromEntries(t1rows.map((r) => [r.invoice_id, r]));
ok(byId[id(1)].linked_email === 'p1@test.com', 'linked_email resolves from the registered profile');
ok(byId[id(2)].linked_email === 'g1@test.com', 'linked_email resolves from the guest player');
ok(byId[id(3)].linked_email === null, 'linked_email is null when neither has an email (drives the No-email flag)');
ok(byId[id(1)].delivery_status === 'delivered' && byId[id(2)].delivery_status === 'bounced',
  'delivery_status still resolves alongside linked_email');

// ---- cross-tenant PII denial ----
const u2seesT1 = await call(U2, [id(1)]);
ok(u2seesT1.length === 0, 'a different trainer gets NOTHING for T1\'s invoice — no email leak', u2seesT1);

// ---- academy manager sees the academy invoice ----
const umRows = await call(UM, [id(5)]);
ok(umRows.length === 1 && umRows[0].linked_email === 'p1@test.com', 'academy manager sees their academy invoice + email');
const umSeesT1 = await call(UM, [id(1)]);
ok(umSeesT1.length === 0, 'academy manager does NOT see an unrelated trainer\'s invoice');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
