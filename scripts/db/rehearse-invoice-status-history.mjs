// Rehearsal for the invoice status audit trail (migration 20260616100000): the trigger
// logs EVERY status transition (insert + updates) with who/when, system vs user attribution,
// the reason annotation, and the manager-gated read RPC.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
let fail = 0;
const ok = (m, c, x) => { c ? console.log('PASS', m) : (fail++, console.error('FAIL', m, JSON.stringify(x ?? ''))); };

const A = '11111111-1111-1111-1111-111111111111';
const UM = '99999999-9999-9999-9999-999999999991';   // manager auth user
const UX = '99999999-9999-9999-9999-9999999999ff';   // unrelated user
const INV = '22222222-2222-2222-2222-222222222221';

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('rehearse.uid', true), '')::uuid $$;
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid, full_name text);
  CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
  CREATE TABLE public.academy_managers (academy_profile_id uuid, user_id uuid);
  CREATE FUNCTION public.is_academy_manager(_uid uuid, _aid uuid) RETURNS boolean LANGUAGE sql STABLE AS
    $$ SELECT EXISTS (SELECT 1 FROM public.academy_managers WHERE academy_profile_id=_aid AND user_id=_uid) $$;
  CREATE FUNCTION public.is_admin(_uid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
  CREATE TABLE public.invoices (id uuid PRIMARY KEY, academy_profile_id uuid, trainer_id uuid, status text, total numeric);
  INSERT INTO public.profiles VALUES ('33333333-0000-0000-0000-000000000001', '${UM}', 'Manager Mara');
  INSERT INTO public.academy_managers VALUES ('${A}', '${UM}');
`);

await db.exec(readFileSync('supabase/migrations/20260616100000_invoice_status_history.sql', 'utf8'));

const hist = async (uid = UM) => {
  await db.exec(`SET rehearse.uid = '${uid}'`);
  return (await db.query(`SELECT * FROM public.get_invoice_status_history('${INV}')`)).rows;
};

// 1) creation logs the initial status
await db.exec(`SET rehearse.uid = '${UM}'`);
await db.exec(`INSERT INTO public.invoices VALUES ('${INV}', '${A}', NULL, 'draft', 100)`);
let h = await hist();
ok('creation logs (null -> draft) by the manager', h.length === 1 && h[0].old_status === null && h[0].new_status === 'draft' && h[0].changed_by === UM, h);
ok('changed_by_name resolves from profiles', h[0].changed_by_name === 'Manager Mara', h[0]);

// 2) updates log each transition
await db.exec(`UPDATE public.invoices SET status='sent' WHERE id='${INV}'`);
await db.exec(`UPDATE public.invoices SET status='cancelled' WHERE id='${INV}'`);
h = await hist();
ok('three transitions logged in order (draft->sent->cancelled)',
  JSON.stringify(h.map((r) => `${r.old_status}->${r.new_status}`)) === '["null->draft","draft->sent","sent->cancelled"]'.replace('null', 'null'), h.map((r) => `${r.old_status}->${r.new_status}`));
// (a no-op status write logs nothing)
await db.exec(`UPDATE public.invoices SET total=200, status='cancelled' WHERE id='${INV}'`);
ok('a status write that does not change the value logs nothing', (await hist()).length === 3);

// 3) reason annotation attaches to the latest transition
await db.exec(`SELECT public.annotate_invoice_status_reason('${INV}', '  email bounced  ')`);
h = await hist();
ok('reason annotated on the latest (cancelled) row, trimmed', h[2].reason === 'email bounced' && h[0].reason === null, h.map((r) => r.reason));

// 4) system (service_role / no auth) change attributes to NULL
await db.exec(`SET rehearse.uid = ''`);
await db.exec(`UPDATE public.invoices SET status='paid' WHERE id='${INV}'`);
h = await hist();
ok('system change (no auth.uid) logs changed_by = NULL', h[3].new_status === 'paid' && h[3].changed_by === null && h[3].changed_by_name === null, h[3]);

// 5) authorization: a non-manager cannot read or annotate
let denied = false;
await db.exec(`SET rehearse.uid = '${UX}'`);
try { await db.query(`SELECT * FROM public.get_invoice_status_history('${INV}')`); } catch (e) { denied = String(e).includes('not authorized'); }
ok('non-manager cannot read the history (42501)', denied);
let denied2 = false;
try { await db.query(`SELECT public.annotate_invoice_status_reason('${INV}', 'x')`); } catch (e) { denied2 = String(e).includes('not authorized'); }
ok('non-manager cannot annotate (42501)', denied2);

console.log(`\n${fail ? `*** FAILED (${fail}) ***` : '*** PASSED ***'}`);
process.exit(fail ? 1 : 0);
