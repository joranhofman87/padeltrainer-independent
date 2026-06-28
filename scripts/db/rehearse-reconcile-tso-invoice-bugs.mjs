// Validates scripts/db/reconcile-tso-invoice-bugs.sql — the READ-ONLY reconciliation
// that sizes live exposure from the TSO cycle-edit invoice bugs
// (docs/audits/TSO_INVOICE_WRITES_AUDIT.md). Runs the ACTUAL .sql statements against
// a PGlite Postgres seeded with one row per bug pattern + clean/paid/non-cyclus
// controls, and asserts each detector flags exactly the right invoices (and nothing
// else). Proves the query is correct + parses on real PG before it touches prod data.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const db = new PGlite();
let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? (pass++, console.log('PASS', m)) : (fail++, console.error('FAIL', m, JSON.stringify(x ?? ''))); };

const CYC = '10000000-0000-0000-0000-000000000001';   // a cyclus cycle (in scope)
const EVT = '10000000-0000-0000-0000-000000000002';   // a non-cyclus cycle (out of scope)
const ALICE = '20000000-0000-0000-0000-00000000000a';
const BOB = '20000000-0000-0000-0000-00000000000b';
const bA = '30000000-0000-0000-0000-0000000000a1';     // Alice's booking
const bB = '30000000-0000-0000-0000-0000000000b1';     // Bob's booking

// Minimal schema with only the columns the reconciliation references.
await db.exec(`
  CREATE TABLE cycles (id uuid PRIMARY KEY, type text);
  CREATE TABLE bookings (id uuid PRIMARY KEY, player_id uuid, guest_player_id uuid, status text);
  CREATE TABLE invoices (
    id uuid PRIMARY KEY, invoice_number text, cycle_id uuid, status text,
    split_count int, line_items jsonb, subtotal numeric, vat_amount numeric, total numeric,
    booking_ids uuid[], player_id uuid, guest_player_id uuid, prices_include_vat boolean,
    trainer_id uuid, academy_profile_id uuid, updated_at timestamptz DEFAULT now()
  );
  INSERT INTO cycles VALUES ('${CYC}','cyclus'), ('${EVT}','event');
  INSERT INTO bookings VALUES
    ('${bA}','${ALICE}',NULL,'confirmed'),
    ('${bB}','${BOB}',NULL,'confirmed');

  -- CLEAN: 1 player, total = subtotal+vat, split_count 1, has (1/1)-free single line. Flagged by NOTHING.
  INSERT INTO invoices (id,invoice_number,cycle_id,status,split_count,line_items,subtotal,vat_amount,total,booking_ids,player_id)
    VALUES ('a0000000-0000-0000-0000-000000000001','INV-CLEAN','${CYC}','sent',1,
      '[{"description":"Sessie","amount":121}]'::jsonb,100,21,121,ARRAY['${bA}']::uuid[],'${ALICE}');

  -- A1: non-split invoice whose booking_ids span TWO players (the matcher merged Bob in). Flagged by Q2 only.
  INSERT INTO invoices (id,invoice_number,cycle_id,status,split_count,line_items,subtotal,vat_amount,total,booking_ids,player_id)
    VALUES ('a0000000-0000-0000-0000-000000000002','INV-A1','${CYC}','sent',1,
      '[{"description":"Sessie","amount":242}]'::jsonb,200,42,242,ARRAY['${bA}','${bB}']::uuid[],'${ALICE}');

  -- B2: split_count 2 but NO "(1/N)" marker in any line. Flagged by Q3 only.
  INSERT INTO invoices (id,invoice_number,cycle_id,status,split_count,line_items,subtotal,vat_amount,total,booking_ids,player_id)
    VALUES ('a0000000-0000-0000-0000-000000000003','INV-B2','${CYC}','draft',2,
      '[{"description":"Sessie","amount":121}]'::jsonb,100,21,121,ARRAY['${bA}']::uuid[],'${ALICE}');

  -- B3: total (130) != subtotal+vat (121). Flagged by Q4 only.
  INSERT INTO invoices (id,invoice_number,cycle_id,status,split_count,line_items,subtotal,vat_amount,total,booking_ids,player_id)
    VALUES ('a0000000-0000-0000-0000-000000000004','INV-B3','${CYC}','overdue',1,
      '[{"description":"Sessie","amount":130}]'::jsonb,100,21,130,ARRAY['${bA}']::uuid[],'${ALICE}');

  -- PAID control: every corruption, but status='paid' → excluded everywhere.
  INSERT INTO invoices (id,invoice_number,cycle_id,status,split_count,line_items,subtotal,vat_amount,total,booking_ids,player_id)
    VALUES ('a0000000-0000-0000-0000-000000000005','INV-PAID','${CYC}','paid',2,
      '[{"description":"Sessie","amount":999}]'::jsonb,100,21,130,ARRAY['${bA}','${bB}']::uuid[],'${ALICE}');

  -- NON-CYCLUS control: multi-player + total drift, but cycle type='event' → excluded everywhere.
  INSERT INTO invoices (id,invoice_number,cycle_id,status,split_count,line_items,subtotal,vat_amount,total,booking_ids,player_id)
    VALUES ('a0000000-0000-0000-0000-000000000006','INV-EVT','${EVT}','sent',1,
      '[{"description":"Sessie","amount":130}]'::jsonb,100,21,130,ARRAY['${bA}','${bB}']::uuid[],'${ALICE}');
`);

// Load + split the ACTUAL reconciliation .sql (strip -- comments to EOL, split on ;).
const sqlPath = join(dirname(fileURLToPath(import.meta.url)), 'reconcile-tso-invoice-bugs.sql');
const statements = readFileSync(sqlPath, 'utf8')
  .split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')
  .split(';').map((s) => s.trim()).filter(Boolean);
ok(statements.length === 5, 'reconciliation .sql parses into 5 statements', statements.length);

const [q0, q1, q2, q3, q4] = statements;

const r0 = (await db.query(q0)).rows[0];
ok(Number(r0.unpaid_cyclus_invoices) === 4, 'Q0: 4 unpaid cyclus invoices (clean+A1+B2+B3; paid & event excluded)', r0.unpaid_cyclus_invoices);
ok(Number(r0.a1_multiplayer_single_invoices) === 1, 'Q0: exactly 1 A1 invoice', r0.a1_multiplayer_single_invoices);
ok(Number(r0.b2_split_missing_marker) === 1, 'Q0: exactly 1 B2 invoice', r0.b2_split_missing_marker);
ok(Number(r0.b3_total_not_subtotal_plus_vat) === 1, 'Q0: exactly 1 B3 invoice', r0.b3_total_not_subtotal_plus_vat);
ok(Number(r0.distinct_affected_invoices) === 3, 'Q0: 3 distinct affected invoices', r0.distinct_affected_invoices);

// Q1 population is informational; just confirm it runs + returns rows.
ok((await db.query(q1)).rows.length >= 1, 'Q1: population query runs');

const a1rows = (await db.query(q2)).rows;
ok(a1rows.length === 1 && a1rows[0].invoice_number === 'INV-A1' && Number(a1rows[0].distinct_players) === 2,
  'Q2: flags ONLY INV-A1 (2 distinct players)', a1rows.map((r) => r.invoice_number));

const b2rows = (await db.query(q3)).rows;
ok(b2rows.length === 1 && b2rows[0].invoice_number === 'INV-B2',
  'Q3: flags ONLY INV-B2 (split, no (1/N) marker)', b2rows.map((r) => r.invoice_number));

const b3rows = (await db.query(q4)).rows;
ok(b3rows.length === 1 && b3rows[0].invoice_number === 'INV-B3' && Math.abs(Number(b3rows[0].drift_eur) - 9) < 0.01,
  'Q4: flags ONLY INV-B3 (drift €9 = 130 - 121)', b3rows.map((r) => r.invoice_number));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
