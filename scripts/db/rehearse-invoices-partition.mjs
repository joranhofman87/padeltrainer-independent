// GUARDRAIL: invoices must never disappear. Asserts get_academy_invoices' paid/unpaid
// tabs are a COMPLETE PARTITION across EVERY status (incl. cancelled / void / '' / NULL /
// unknown) — paid_count + unpaid_count == total, every invoice in exactly one tab. This is
// the exact failure that hid 16 cancelled invoices. If anyone re-introduces an allow-list
// that drops a status, this fails. Also checks invoice_number search + summary count parity.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
let fail = 0;
const ok = (m, c, x) => { c ? console.log('PASS', m) : (fail++, console.error('FAIL', m, JSON.stringify(x ?? ''))); };

const A = '11111111-1111-1111-1111-111111111111';
const MGR = '99999999-9999-9999-9999-999999999991';

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('rehearse.uid', true), '')::uuid $$;
  CREATE TABLE public.academy_managers (academy_profile_id uuid, user_id uuid);
  CREATE FUNCTION public.is_academy_manager(_uid uuid, _aid uuid) RETURNS boolean LANGUAGE sql STABLE AS
    $$ SELECT EXISTS (SELECT 1 FROM public.academy_managers WHERE academy_profile_id=_aid AND user_id=_uid) $$;
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text);
  CREATE TABLE public.guest_players (id uuid PRIMARY KEY, email text);
  CREATE TABLE public.bookings (id uuid PRIMARY KEY, slot_id uuid);
  CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, location_id uuid);
  CREATE TABLE public.locations (id uuid PRIMARY KEY, name text, merged_into uuid);
  CREATE TABLE public.academy_locations (academy_profile_id uuid, location_id uuid, is_active boolean DEFAULT true);
  CREATE TABLE public._dstub (invoice_id uuid PRIMARY KEY, s text);
  CREATE FUNCTION public.get_invoice_delivery_status(p_id uuid) RETURNS text LANGUAGE sql STABLE AS $$ SELECT s FROM public._dstub WHERE invoice_id=p_id $$;
  CREATE TABLE public.invoices (
    id uuid PRIMARY KEY, academy_profile_id uuid, booking_ids uuid[], created_at timestamptz DEFAULT now(),
    due_date date, forwarded_at timestamptz, guest_player_id uuid, invoice_date date DEFAULT current_date,
    invoice_number text, line_items jsonb, mollie_payment_id text, mollie_payment_url text,
    notes text, paid_at timestamptz, pdf_url text, player_address text, player_btw_number text,
    player_business_name text, player_id uuid, player_name text, prices_include_vat boolean,
    public_token uuid, public_token_revoked_at timestamptz, sent_at timestamptz,
    split_count integer, status text, subtotal numeric, total numeric, trainer_id uuid,
    updated_at timestamptz, vat_amount numeric, vat_breakdown jsonb, vat_rate numeric);
  INSERT INTO public.academy_managers VALUES ('${A}','${MGR}');
`);

// the fix re-creates get_academy_invoices / get_academy_invoice_summary (among others)
await db.exec(readFileSync('supabase/migrations/20260615110130_invoices_show_all_statuses.sql', 'utf8'));

// seed one invoice per status — EVERY status must remain visible in exactly one tab
const STATUSES = ['paid', 'sent', 'draft', 'open', 'overdue', 'cancelled', 'void', 'refunded', '', null, 'totally_unknown'];
let n = 0;
for (const st of STATUSES) {
  n++;
  await db.exec(`INSERT INTO public.invoices (id, academy_profile_id, invoice_number, player_name, status, total, due_date)
    VALUES ('22222222-0000-0000-0000-${String(n).padStart(12, '0')}', '${A}', 'INV-${1000 + n}', 'Player ${n}', ${st === null ? 'NULL' : `'${st}'`}, ${n}0, current_date + 14);`);
}
await db.exec(`SET rehearse.uid = '${MGR}'`);

const tabCount = async (tab) => {
  const r = await db.query(`SELECT total_count FROM public.get_academy_invoices('${A}', '${tab}', NULL, NULL, NULL, NULL, false, NULL, 'created_at', 'desc', 500, 0) LIMIT 1`);
  return Number(r.rows[0]?.total_count ?? 0);
};
const tabStatuses = async (tab) => {
  const r = await db.query(`SELECT status FROM public.get_academy_invoices('${A}', '${tab}', NULL, NULL, NULL, NULL, false, NULL, 'created_at', 'desc', 500, 0)`);
  return r.rows.map((x) => x.status);
};

const paidN = await tabCount('paid');
const unpaidN = await tabCount('unpaid');
ok(`COMPLETE PARTITION: paid(${paidN}) + unpaid(${unpaidN}) == all(${STATUSES.length}) — nothing hidden`,
  paidN + unpaidN === STATUSES.length, { paidN, unpaidN, all: STATUSES.length });
ok('paid tab = only paid', JSON.stringify(await tabStatuses('paid')) === '["paid"]');
const unpaid = await tabStatuses('unpaid');
ok('unpaid tab shows cancelled (the bug)', unpaid.includes('cancelled'), unpaid);
ok('unpaid tab shows void', unpaid.includes('void'));
ok('unpaid tab shows NULL status', unpaid.includes(null));
ok('unpaid tab shows unknown status', unpaid.includes('totally_unknown'));
ok('unpaid tab shows empty-string status', unpaid.includes(''));

// search by invoice number (the cancelled one)
const byNum = await db.query(`SELECT invoice_number, status FROM public.get_academy_invoices('${A}', 'unpaid', NULL, 'INV-1006', NULL, NULL, false, NULL, 'created_at', 'desc', 500, 0)`);
ok('search by invoice_number finds the cancelled invoice', byNum.rows.some((r) => r.invoice_number === 'INV-1006' && r.status === 'cancelled'), byNum.rows);

// summary count_unpaid matches the unpaid list
const sum = (await db.query(`SELECT * FROM public.get_academy_invoice_summary('${A}', NULL, NULL)`)).rows[0];
ok(`summary count_unpaid (${sum.count_unpaid}) == unpaid list (${unpaidN})`, Number(sum.count_unpaid) === unpaidN, sum);
ok('summary count_paid == 1', Number(sum.count_paid) === 1, sum);

console.log(`\n${fail ? `*** FAILED (${fail}) ***` : '*** PASSED ***'}`);
process.exit(fail ? 1 : 0);
