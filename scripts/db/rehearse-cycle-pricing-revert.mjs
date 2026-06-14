import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const CY = '40000000-0000-0000-0000-000000000001';
const S1 = '50000000-0000-0000-0000-000000000001';
const S2 = '50000000-0000-0000-0000-000000000002';
const INV = '60000000-0000-0000-0000-000000000001';
const B1 = '70000000-0000-0000-0000-000000000001';
const B2 = '70000000-0000-0000-0000-000000000002';
const B3 = '70000000-0000-0000-0000-000000000003';

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE public.cycles (id uuid PRIMARY KEY, price_per_session numeric, settings jsonb DEFAULT '{}'::jsonb);
  CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, cyclus_id uuid, price_per_session numeric,
    extra_costs jsonb, split_payment boolean, prices_include_vat boolean);
  CREATE TABLE public.invoices (id uuid PRIMARY KEY, status text, booking_ids uuid[]);
  CREATE TABLE public.bookings (id uuid PRIMARY KEY, status text, payment_status text, paid_at timestamptz);

  INSERT INTO public.cycles (id, price_per_session, settings) VALUES ('${CY}', 25, '{"foo":"bar","split_payment":false}'::jsonb);
  INSERT INTO public.availability_slots (id, cyclus_id, price_per_session, split_payment, prices_include_vat) VALUES
    ('${S1}', '${CY}', 25, false, false),
    ('${S2}', '${CY}', 25, false, false);

  INSERT INTO public.invoices (id, status, booking_ids) VALUES ('${INV}', 'sent', ARRAY['${B1}','${B2}','${B3}']::uuid[]);
  INSERT INTO public.bookings (id, status, payment_status, paid_at) VALUES
    ('${B1}', 'confirmed', 'paid', now()),       -- should revert
    ('${B2}', 'confirmed', 'paid', now()),       -- should revert
    ('${B3}', 'cancelled', 'paid', now());       -- already cancelled → skip
`);

await db.exec(readFileSync('supabase/migrations/20260614120000_atomic_cycle_pricing_and_invoice_cancel_revert.sql', 'utf8'));

let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? (pass++, console.log('PASS', m)) : (fail++, console.error('FAIL', m, x ?? '')); };
const one = async (sql) => (await db.query(sql)).rows[0];

// (1) update_cycle_pricing — atomic dual write.
await db.query(`SELECT public.update_cycle_pricing($1, $2, $3::jsonb, $4, $5)`,
  [CY, 20, JSON.stringify([{ label: 'Balls', amount: 5 }]), true, true]);
const cyc = await one(`SELECT price_per_session, settings FROM public.cycles WHERE id='${CY}'`);
ok(Number(cyc.price_per_session) === 20, 'RPC: cycle price updated to 20', cyc.price_per_session);
ok(cyc.settings.split_payment === true && cyc.settings.prices_include_vat === true
   && Array.isArray(cyc.settings.extra_costs) && cyc.settings.foo === 'bar',
   'RPC: cycle settings merged (split/vat/extra set, existing keys preserved)', cyc.settings);
const slots = (await db.query(`SELECT price_per_session, split_payment, prices_include_vat, extra_costs FROM public.availability_slots WHERE cyclus_id='${CY}' ORDER BY id`)).rows;
ok(slots.every((s) => Number(s.price_per_session) === 20 && s.split_payment === true && s.prices_include_vat === true && Array.isArray(s.extra_costs)),
   'RPC: ALL linked slots updated in lockstep (price + split + vat + extra_costs)', slots);

// empty extra_costs → slot extra_costs NULL (matches app)
await db.query(`SELECT public.update_cycle_pricing($1, $2, $3::jsonb, $4, $5)`, [CY, 22, JSON.stringify([]), false, false]);
const s1b = await one(`SELECT extra_costs FROM public.availability_slots WHERE id='${S1}'`);
ok(s1b.extra_costs === null, 'RPC: empty extra_costs array → slot extra_costs NULL', s1b.extra_costs);

// unknown cycle → raises
let raised = false;
try { await db.query(`SELECT public.update_cycle_pricing($1,$2,$3::jsonb,$4,$5)`, ['00000000-0000-0000-0000-000000000099', 1, '[]', false, false]); }
catch { raised = true; }
ok(raised, 'RPC: unknown cycle id raises cycle_not_found');

// (2) revert trigger — void a paid invoice.
await db.query(`UPDATE public.invoices SET status='cancelled' WHERE id='${INV}'`);
const b1 = await one(`SELECT payment_status, paid_at FROM public.bookings WHERE id='${B1}'`);
const b3 = await one(`SELECT payment_status FROM public.bookings WHERE id='${B3}'`);
ok(b1.payment_status === 'pending' && b1.paid_at === null, 'REVERT: paid booking on voided invoice → pending, paid_at cleared', b1);
ok(b3.payment_status === 'paid', 'REVERT: already-cancelled booking left untouched', b3);

// idempotent: a second status write (still cancelled) does nothing harmful.
await db.query(`UPDATE public.invoices SET status='cancelled' WHERE id='${INV}'`);
ok((await one(`SELECT payment_status FROM public.bookings WHERE id='${B1}'`)).payment_status === 'pending',
   'REVERT: re-cancel is a no-op (OLD already cancelled)', null);

console.log(fail === 0 ? '\nALL cycle-pricing/revert checks passed' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
