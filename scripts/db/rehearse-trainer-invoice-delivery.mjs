// Rehearsal for the TRAINER invoice-list email-delivery filter (migration 110070).
// Proves get_trainer_invoices's delivery_status/linked_email columns + p_delivery
// filter (no_email/bounced/delivered/undelivered) and get_trainer_invoice_delivery_summary
// counts, plus the ownership gate, on PGlite — against a full invoices stub so the
// RETURNS TABLE projection (SELECT i.*) is exercised exactly as in prod.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? (pass++, console.log('PASS', m)) : (fail++, console.error('FAIL', m, JSON.stringify(x ?? ''))); };

const T1 = '30000000-0000-0000-0000-000000000001'; // trainer profile
const U1 = '30000000-0000-0000-0000-0000000000a1'; // trainer's auth user
const UX = '30000000-0000-0000-0000-0000000000ff'; // an unrelated user
const P1 = '31000000-0000-0000-0000-000000000001'; // registered player (has email)
const G1 = '32000000-0000-0000-0000-000000000001'; // guest player (has email)
const id = (n) => `33000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('rehearse.uid', true), '')::uuid $$;

  CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text);
  CREATE TABLE public.guest_players (id uuid PRIMARY KEY, email text);

  -- Full invoices shape so SELECT i.* maps every RETURNS TABLE column.
  CREATE TABLE public.invoices (
    id uuid PRIMARY KEY,
    academy_profile_id uuid, booking_ids uuid[], created_at timestamptz DEFAULT now(),
    due_date date, forwarded_at timestamptz, guest_player_id uuid, invoice_date date DEFAULT current_date,
    invoice_number text, line_items jsonb, mollie_payment_id text, mollie_payment_url text,
    notes text, paid_at timestamptz, pdf_url text, player_address text, player_btw_number text,
    player_business_name text, player_id uuid, player_name text, prices_include_vat boolean,
    public_token uuid, public_token_revoked_at timestamptz, sent_at timestamptz,
    split_count integer, status text, subtotal numeric, total numeric, trainer_id uuid,
    updated_at timestamptz, vat_amount numeric, vat_breakdown jsonb, vat_rate numeric);

  -- Stub the delivery-status resolver via a control table so each invoice's status is fixed.
  CREATE TABLE public._dstub (invoice_id uuid PRIMARY KEY, s text);
  CREATE FUNCTION public.get_invoice_delivery_status(p_id uuid) RETURNS text
    LANGUAGE sql STABLE AS $$ SELECT s FROM public._dstub WHERE invoice_id = p_id $$;

  INSERT INTO public.trainer_profiles VALUES ('${T1}', '${U1}');
  INSERT INTO public.profiles VALUES ('${P1}', 'player@test.com');
  INSERT INTO public.guest_players VALUES ('${G1}', 'guest@test.com');
`);

await db.exec(readFileSync('supabase/migrations/20260615110070_trainer_invoice_delivery_filter.sql', 'utf8'));

// Seed 5 unpaid + 1 paid invoice, all trainer-owned standalone.
const seed = async (n, { player_id = null, guest_player_id = null, status = 'sent', sent = true, dstatus = null } = {}) => {
  await db.exec(`INSERT INTO public.invoices (id, trainer_id, academy_profile_id, player_id, guest_player_id,
      player_name, status, sent_at, due_date, total)
    VALUES ('${id(n)}', '${T1}', NULL, ${player_id ? `'${player_id}'` : 'NULL'}, ${guest_player_id ? `'${guest_player_id}'` : 'NULL'},
      'Player ${n}', '${status}', ${sent ? 'now()' : 'NULL'}, current_date + 14, ${n}0);`);
  if (dstatus !== null) await db.exec(`INSERT INTO public._dstub VALUES ('${id(n)}', '${dstatus}');`);
};
await seed(1, { player_id: P1, dstatus: 'delivered' });                 // A delivered
await seed(2, { guest_player_id: G1, dstatus: 'bounced' });             // B bounced
await seed(3, { player_id: P1, dstatus: 'failed' });                    // C failed
await seed(4, { player_id: null, guest_player_id: null, dstatus: null });// D no email
await seed(5, { player_id: P1, dstatus: 'sent' });                      // E pending (sent, not yet delivered)
await seed(6, { player_id: P1, status: 'paid', dstatus: 'delivered' }); // F paid (other tab)

await db.exec(`SET rehearse.uid = '${U1}';`);

const listIds = async (delivery, tab = 'unpaid') => {
  const r = await db.query(
    `SELECT id FROM public.get_trainer_invoices('${T1}', '${tab}', NULL, NULL, ${delivery ? `'${delivery}'` : 'NULL'}) ORDER BY player_name;`);
  return r.rows.map((x) => x.id);
};
const has = (ids, ...ns) => ids.length === ns.length && ns.every((n) => ids.includes(id(n)));

// ---- columns populated ----
const all = await db.query(
  `SELECT id, linked_email, delivery_status FROM public.get_trainer_invoices('${T1}','unpaid') ORDER BY player_name;`);
const byId = Object.fromEntries(all.rows.map((r) => [r.id, r]));
ok(byId[id(1)].linked_email === 'player@test.com' && byId[id(1)].delivery_status === 'delivered', 'row reflects profile email + delivered');
ok(byId[id(2)].linked_email === 'guest@test.com' && byId[id(2)].delivery_status === 'bounced', 'row reflects guest email + bounced');
ok(byId[id(4)].linked_email === null, 'no-email row has null linked_email');

// ---- p_delivery filter ----
ok(has(await listIds(null), 1, 2, 3, 4, 5), 'NULL delivery returns all 5 unpaid', await listIds(null));
ok(has(await listIds('no_email'), 4), 'no_email -> only the address-less invoice');
ok(has(await listIds('bounced'), 2, 3), 'bounced -> bounced + failed');
ok(has(await listIds('delivered'), 1), 'delivered -> only delivered');
ok(has(await listIds('undelivered'), 2, 3, 4), 'undelivered -> no_email + bounced + failed (not pending/delivered)');

// ---- tab scoping ----
ok(has(await listIds(null, 'paid'), 6), 'paid tab returns only the paid invoice');

// ---- summary ----
const sum = (await db.query(`SELECT * FROM public.get_trainer_invoice_delivery_summary('${T1}', 'unpaid');`)).rows[0];
ok(Number(sum.total) === 5, 'summary total = 5', sum);
ok(Number(sum.no_email) === 1, 'summary no_email = 1', sum);
ok(Number(sum.bounced) === 2, 'summary bounced = 2 (bounced+failed)', sum);
ok(Number(sum.delivered) === 1, 'summary delivered = 1', sum);
ok(Number(sum.pending) === 1, 'summary pending = 1 (sent, awaiting delivery)', sum);

// ---- ownership gate ----
await db.exec(`SET rehearse.uid = '${UX}';`);
let denied = false;
try { await db.query(`SELECT * FROM public.get_trainer_invoices('${T1}','unpaid');`); } catch { denied = true; }
ok(denied, 'a non-owner cannot read another trainer\'s invoices (42501)');
let denied2 = false;
try { await db.query(`SELECT * FROM public.get_trainer_invoice_delivery_summary('${T1}','unpaid');`); } catch { denied2 = true; }
ok(denied2, 'a non-owner cannot read the delivery summary (42501)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
