/**
 * Phase 4 F2 rehearsal (PGlite): update_cycle_pricing after the canonical id-ordered slot lock was
 * added. The lock is invisible to a single connection, so this is a CHARACTERIZATION test — it proves
 * the relocked function reproduces the EXACT repricing contract (atomic cycle + slot push, settings
 * merge, the extra_costs array/empty CASE, cycle_not_found) so the added lock changed nothing else.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const CY = '40000000-0000-0000-0000-000000000001';
const S1 = '50000000-0000-0000-0000-000000000001';
const S2 = '50000000-0000-0000-0000-000000000002';

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE public.cycles (id uuid PRIMARY KEY, price_per_session numeric, settings jsonb DEFAULT '{}'::jsonb);
  CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, cyclus_id uuid, price_per_session numeric,
    extra_costs jsonb, split_payment boolean, prices_include_vat boolean);

  INSERT INTO public.cycles (id, price_per_session, settings) VALUES ('${CY}', 25, '{"foo":"bar","split_payment":false}'::jsonb);
  INSERT INTO public.availability_slots (id, cyclus_id, price_per_session, split_payment, prices_include_vat) VALUES
    ('${S1}', '${CY}', 25, false, false),
    ('${S2}', '${CY}', 25, false, false);
`);

await db.exec(readFileSync('supabase/migrations/20260629150000_phase4_f2_cycle_pricing_relock.sql', 'utf8'));

let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? (pass++, console.log('PASS', m)) : (fail++, console.error('FAIL', m, x ?? '')); };
const reprice = (cy, price, extra, split, vat) =>
  db.query(`SELECT public.update_cycle_pricing($1, $2, $3::jsonb, $4, $5)`, [cy, price, JSON.stringify(extra), split, vat]);
const cycle = async () => (await db.query(`SELECT * FROM public.cycles WHERE id='${CY}'`)).rows[0];
const slots = async () => (await db.query(`SELECT * FROM public.availability_slots WHERE cyclus_id='${CY}' ORDER BY id`)).rows;

// (1) atomic dual write + extra_costs (non-empty array) + settings merge.
await reprice(CY, 30, [{ label: 'balls', amount: 2 }], true, true);
const c1 = await cycle(); const s1 = await slots();
ok(Number(c1.price_per_session) === 30, '1: cycle price -> 30', c1.price_per_session);
ok(s1.every((s) => Number(s.price_per_session) === 30 && s.split_payment === true && s.prices_include_vat === true),
  '1: every slot repriced 30 + split + vat (atomic push)', s1.map((s) => s.price_per_session));
ok(s1.every((s) => Array.isArray(s.extra_costs) && s.extra_costs[0].label === 'balls'), '1: extra_costs array written to slots', s1[0].extra_costs);
ok(c1.settings.foo === 'bar' && c1.settings.split_payment === true && c1.settings.prices_include_vat === true
   && Array.isArray(c1.settings.extra_costs), '1: settings merged (foo kept; split/vat/extra_costs set)', c1.settings);

// (2) empty extra_costs array -> slot extra_costs cleared to NULL (the CASE).
await reprice(CY, 28, [], false, false);
const s2 = await slots();
ok(s2.every((s) => Number(s.price_per_session) === 28 && s.extra_costs === null && s.split_payment === false),
  '2: empty extra_costs -> NULL on slots; price 28; split off', s2.map((s) => s.extra_costs));

// (3) unknown cycle raises cycle_not_found (orphan groups can't be repriced — intended).
let raised = false;
try { await reprice('40000000-0000-0000-0000-0000000000ff', 10, [], false, false); }
catch (e) { raised = /cycle_not_found/.test(String(e.message ?? e)); }
ok(raised, '3: unknown cycle -> RAISE cycle_not_found', raised);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
