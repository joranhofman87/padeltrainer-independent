import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const CY = '40000000-0000-0000-0000-000000000001';
const CY_NOSPLIT = '40000000-0000-0000-0000-000000000002';
const S1 = '50000000-0000-0000-0000-000000000001';
const S2 = '50000000-0000-0000-0000-000000000002';
const INV_UNPAID = '60000000-0000-0000-0000-000000000001';
const INV_PAID = '60000000-0000-0000-0000-000000000002';
const PA = '20000000-0000-0000-0000-00000000000a';
const PB = '20000000-0000-0000-0000-00000000000b';
const GC = '30000000-0000-0000-0000-00000000000c';

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, cyclus_id uuid, split_payment boolean);
  CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid, guest_player_id uuid, status text);
  CREATE TABLE public.invoices (id uuid PRIMARY KEY, status text, split_count int, booking_ids uuid[]);

  INSERT INTO public.availability_slots VALUES ('${S1}','${CY}',true), ('${S2}','${CY}',true);
  -- Active players in the cycle: PA (twice, both slots), PB (once), guest GC (once) => 3 distinct.
  -- Plus a cancelled booking (excluded) and a NULL-status booking (excluded, matching .in()).
  INSERT INTO public.bookings (id, slot_id, player_id, guest_player_id, status) VALUES
    ('70000000-0000-0000-0000-000000000001','${S1}','${PA}',NULL,'confirmed'),
    ('70000000-0000-0000-0000-000000000002','${S2}','${PA}',NULL,'pending'),
    ('70000000-0000-0000-0000-000000000003','${S1}','${PB}',NULL,'confirmed'),
    ('70000000-0000-0000-0000-000000000004','${S1}',NULL,'${GC}','confirmed'),
    ('70000000-0000-0000-0000-000000000005','${S1}','${PB}',NULL,'cancelled'),
    ('70000000-0000-0000-0000-000000000006','${S1}','20000000-0000-0000-0000-00000000000d',NULL,NULL);

  INSERT INTO public.invoices (id, status, split_count, booking_ids) VALUES
    ('${INV_UNPAID}','sent', 1, ARRAY['70000000-0000-0000-0000-000000000001']::uuid[]),
    ('${INV_PAID}','paid', 1, ARRAY['70000000-0000-0000-0000-000000000003']::uuid[]);
`);

await db.exec(readFileSync('supabase/migrations/20260614150000_recalc_cycle_split_count.sql', 'utf8'));

// Golden-master: the JS count = unique (player_id||guest_player_id) over confirmed/pending.
const jsBookings = [
  { player_id: PA, guest_player_id: null, status: 'confirmed' },
  { player_id: PA, guest_player_id: null, status: 'pending' },
  { player_id: PB, guest_player_id: null, status: 'confirmed' },
  { player_id: null, guest_player_id: GC, status: 'confirmed' },
  { player_id: PB, guest_player_id: null, status: 'cancelled' },
  { player_id: '20000000-0000-0000-0000-00000000000d', guest_player_id: null, status: null },
];
const jsCount = new Set(jsBookings.filter(b => ['confirmed', 'pending'].includes(b.status)).map(b => b.player_id || b.guest_player_id)).size;

let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? (pass++, console.log('PASS', m)) : (fail++, console.error('FAIL', m, x ?? '')); };
const rpc = async (cy) => (await db.query(`SELECT public.recalc_cycle_split_count($1) AS c`, [cy])).rows[0].c;

const n = await rpc(CY);
ok(n === jsCount, `GOLDEN-MASTER: RPC count (${n}) === JS unique-active-players count (${jsCount})`, { n, jsCount });
ok(n === 3, 'count = 3 (PA + PB + guest GC; cancelled + null-status excluded)', n);

const unpaid = (await db.query(`SELECT split_count FROM public.invoices WHERE id='${INV_UNPAID}'`)).rows[0];
ok(Number(unpaid.split_count) === 3, 'unpaid sibling invoice split_count set to authoritative 3', unpaid);
const paid = (await db.query(`SELECT split_count FROM public.invoices WHERE id='${INV_PAID}'`)).rows[0];
ok(Number(paid.split_count) === 1, 'PAID invoice untouched (split_count stays 1)', paid);

// Non-split cycle returns 0 and writes nothing.
await db.exec(`INSERT INTO public.availability_slots VALUES ('50000000-0000-0000-0000-000000000009','${CY_NOSPLIT}',false)`);
ok((await rpc(CY_NOSPLIT)) === 0, 'non-split cycle returns 0 (no divisor)', null);
ok((await rpc(null)) === 0, 'null cycle id returns 0', null);

console.log(fail === 0 ? '\nALL recalc-split checks passed' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
