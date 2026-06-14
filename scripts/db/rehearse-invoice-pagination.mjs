// Golden-master rehearsal for the paginated invoice RPCs (P-RD-001).
// Proves: auth gate (42501), scoreboard == JS page logic (whole-set + trainer +
// location scope), pagination never drops/dupes a row, computed_status mirrors
// getComputedStatus, location = first non-null booking slot, linked_email +
// no-email filter, academy/trainer scope isolation.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();

// ---- ids -------------------------------------------------------------------
const AC = '10000000-0000-0000-0000-0000000000ac';
const AC2 = '10000000-0000-0000-0000-0000000000c2';
const U_MGR = '11000000-0000-0000-0000-0000000000a1';
const U_OTHER = '11000000-0000-0000-0000-0000000000ff';
const T1 = '12000000-0000-0000-0000-000000000001';
const T2 = '12000000-0000-0000-0000-000000000002';
const UT1 = '13000000-0000-0000-0000-000000000001';
const UT2 = '13000000-0000-0000-0000-000000000002';
const L1 = '14000000-0000-0000-0000-000000000001';
const L2 = '14000000-0000-0000-0000-000000000002';
const SLOT_L1 = '15000000-0000-0000-0000-000000000001';
const SLOT_L2 = '15000000-0000-0000-0000-000000000002';
const SLOT_NULL = '15000000-0000-0000-0000-0000000000ff';
const PROF = '16000000-0000-0000-0000-000000000001'; // profile with email
const GUEST_EMAIL = '17000000-0000-0000-0000-000000000001'; // guest with email
const GUEST_NOEMAIL = '17000000-0000-0000-0000-0000000000ff'; // guest without email

const DUE_PAST = '2020-01-01';
const DUE_FUTURE = '2099-01-01';

// id helper for invoices/bookings
const inv = (n) => `18000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;
const bk = (n) => `19000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;

// ---- seed model (academy AC unless noted) ----------------------------------
// email: 'profile' | 'guest' | 'none'   loc: L1 | L2 | null | 'L2_via_2nd'
const MODEL = [
  { n: 1, status: 'sent', sent: true, due: DUE_FUTURE, trainer: T1, total: 100, email: 'profile', name: 'Alice', loc: L1, exp: 'sent' },
  { n: 2, status: 'sent', sent: true, due: DUE_PAST, trainer: T1, total: 50, email: 'guest', name: 'Bob', loc: 'L2_via_2nd', exp: 'overdue' },
  { n: 3, status: 'draft', sent: false, due: DUE_FUTURE, trainer: T2, total: 30, email: 'none', name: 'Carol', loc: L1, exp: 'draft' },
  { n: 4, status: 'paid', sent: true, due: DUE_PAST, trainer: T1, total: 80, email: 'profile', name: 'Alice', loc: L1, paid: true, exp: 'paid' },
  { n: 5, status: 'cancelled', sent: true, due: DUE_PAST, trainer: T2, total: 999, email: 'profile', name: 'Dan', loc: L2, exp: 'cancelled' },
  { n: 6, status: 'sent', sent: true, due: DUE_FUTURE, trainer: T2, total: 20, email: 'profile', name: 'Eve', loc: null, exp: 'sent' },
  { n: 7, status: 'overdue', sent: true, due: DUE_PAST, trainer: T1, total: 40, email: 'profile', name: 'Frank', loc: L2, exp: 'overdue' },
  { n: 8, status: 'sent', sent: true, due: DUE_FUTURE, trainer: T1, total: 10, email: 'profile', name: 'Gina', loc: L1, exp: 'sent' },
  { n: 9, status: 'sent', sent: true, due: DUE_FUTURE, trainer: T1, total: 15, email: 'profile', name: 'Hank', loc: L2, exp: 'sent' },
  { n: 10, status: 'sent', sent: false, due: DUE_FUTURE, trainer: T1, total: 5, email: 'profile', name: 'Ivy', loc: L1, exp: 'open' },
];
// scope-isolation rows
const OTHER_ACADEMY = { n: 20, academy: AC2, status: 'sent', sent: true, due: DUE_FUTURE, trainer: T1, total: 7777, email: 'profile', name: 'OtherAcademy', loc: L1 };
const TRAINER_OWNED_UNPAID = { n: 21, academy: null, status: 'sent', sent: true, due: DUE_FUTURE, trainer: T1, total: 200, email: 'profile', name: 'TrainerOwned', loc: L1 };
const TRAINER_OWNED_PAID = { n: 22, academy: null, status: 'paid', sent: true, due: DUE_PAST, trainer: T1, total: 300, email: 'profile', name: 'TrainerPaid', loc: L1, paid: true };

const ALL = [...MODEL, OTHER_ACADEMY, TRAINER_OWNED_UNPAID, TRAINER_OWNED_PAID];

// ---- build SQL -------------------------------------------------------------
function slotForLoc(loc) {
  if (loc === L1) return SLOT_L1;
  if (loc === L2) return SLOT_L2;
  return SLOT_NULL;
}

const bookingInserts = [];
const invoiceInserts = [];
let bkCounter = 1;
for (const m of ALL) {
  const academy = m.academy === undefined ? AC : m.academy;
  let bookingIds = [];
  if (m.loc === 'L2_via_2nd') {
    const b1 = bk(bkCounter++); // first booking → null-location slot (must be skipped)
    const b2 = bk(bkCounter++); // second booking → L2 (resolved)
    bookingInserts.push(`('${b1}','${SLOT_NULL}')`, `('${b2}','${SLOT_L2}')`);
    bookingIds = [b1, b2];
  } else {
    const b1 = bk(bkCounter++);
    bookingInserts.push(`('${b1}','${slotForLoc(m.loc)}')`);
    bookingIds = [b1];
  }
  const player_id = m.email === 'profile' ? `'${PROF}'` : 'NULL';
  const guest_id = m.email === 'guest' ? `'${GUEST_EMAIL}'` : (m.email === 'none' ? `'${GUEST_NOEMAIL}'` : 'NULL');
  const sent_at = m.sent ? `'2024-01-01T00:00:00Z'` : 'NULL';
  const paid_at = m.paid ? `'2024-02-01T00:00:00Z'` : 'NULL';
  const created = `'2026-06-01T00:00:${String(m.n).padStart(2, '0')}Z'`;
  const academySql = academy === null ? 'NULL' : `'${academy}'`;
  const arr = `ARRAY[${bookingIds.map((b) => `'${b}'`).join(',')}]::uuid[]`;
  invoiceInserts.push(
    `('${inv(m.n)}', ${academySql}, '${m.trainer}', ${player_id}, ${guest_id}, '${m.name}', '${m.status}', ${sent_at}, ${paid_at}, '${m.due}', ${m.total}, ${arr}, ${created}, 'INV-${m.n}')`,
  );
}

await db.exec(`
  SET TimeZone='UTC';
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('rehearse.uid', true), '')::uuid $$;

  CREATE TABLE rehearse_managers (user_id uuid, academy_profile_id uuid);
  INSERT INTO rehearse_managers VALUES ('${U_MGR}', '${AC}'), ('${U_MGR}', '${AC2}');
  CREATE FUNCTION public.is_academy_manager(_uid uuid, _academy uuid) RETURNS boolean
    LANGUAGE sql STABLE AS
    $$ SELECT EXISTS (SELECT 1 FROM rehearse_managers m WHERE m.user_id = _uid AND m.academy_profile_id = _academy) $$;

  CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
  INSERT INTO public.trainer_profiles VALUES ('${T1}', '${UT1}'), ('${T2}', '${UT2}');

  CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text);
  INSERT INTO public.profiles VALUES ('${PROF}', 'profile@example.com');

  CREATE TABLE public.guest_players (id uuid PRIMARY KEY, email text);
  INSERT INTO public.guest_players VALUES ('${GUEST_EMAIL}', 'guest@example.com'), ('${GUEST_NOEMAIL}', NULL);

  CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, location_id uuid);
  INSERT INTO public.availability_slots VALUES ('${SLOT_L1}','${L1}'), ('${SLOT_L2}','${L2}'), ('${SLOT_NULL}', NULL);

  CREATE TABLE public.bookings (id uuid PRIMARY KEY, slot_id uuid);
  INSERT INTO public.bookings (id, slot_id) VALUES ${bookingInserts.join(',')};

  CREATE TABLE public.invoices (
    id uuid PRIMARY KEY, academy_profile_id uuid, booking_ids uuid[],
    created_at timestamptz, due_date date, forwarded_at timestamptz,
    guest_player_id uuid, invoice_date date DEFAULT current_date, invoice_number text,
    line_items jsonb DEFAULT '[]'::jsonb, mollie_payment_id text, mollie_payment_url text,
    notes text, paid_at timestamptz, pdf_url text, player_address text, player_btw_number text,
    player_business_name text, player_id uuid, player_name text,
    prices_include_vat boolean DEFAULT false, public_token uuid DEFAULT gen_random_uuid(),
    public_token_revoked_at timestamptz, sent_at timestamptz, split_count integer,
    status text, subtotal numeric DEFAULT 0, total numeric, trainer_id uuid,
    updated_at timestamptz DEFAULT now(), vat_amount numeric DEFAULT 0,
    vat_breakdown jsonb, vat_rate numeric DEFAULT 0
  );
  INSERT INTO public.invoices
    (id, academy_profile_id, trainer_id, player_id, guest_player_id, player_name, status, sent_at, paid_at, due_date, total, booking_ids, created_at, invoice_number)
  VALUES ${invoiceInserts.join(',')};
`);

await db.exec(readFileSync('supabase/migrations/20260614160000_paginated_invoice_rpcs.sql', 'utf8'));

// ---- harness ---------------------------------------------------------------
let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? (pass++, console.log('PASS', m)) : (fail++, console.error('FAIL', m, JSON.stringify(x ?? ''))); };
const asUid = async (uid) => db.query(`SELECT set_config('rehearse.uid', $1, false)`, [uid ?? '']);
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

// ---- JS golden -------------------------------------------------------------
const academyRows = MODEL; // all in AC
const board = (rows) => ({
  sum_unpaid: rows.filter((r) => r.status !== 'paid' && r.status !== 'cancelled').reduce((s, r) => s + r.total, 0),
  count_unpaid: rows.filter((r) => r.status !== 'paid' && r.status !== 'cancelled').length,
  count_paid: rows.filter((r) => r.status === 'paid').length,
  count_draft: rows.filter((r) => !r.sent && r.status !== 'paid' && r.status !== 'cancelled').length,
});
const resolvedLoc = (m) => (m.loc === 'L2_via_2nd' ? L2 : m.loc);

// === 1. AUTH GATE ===========================================================
await asUid(U_OTHER);
let raised = false;
try { await q(`SELECT * FROM public.get_academy_invoice_summary($1)`, [AC]); } catch (e) { raised = /not authorized/.test(e.message); }
ok(raised, 'academy summary: non-manager raises 42501', null);
raised = false;
try { await q(`SELECT * FROM public.get_academy_invoices($1)`, [AC]); } catch (e) { raised = /not authorized/.test(e.message); }
ok(raised, 'academy list: non-manager raises 42501', null);
raised = false;
try { await q(`SELECT * FROM public.get_trainer_invoices($1)`, [T1]); } catch (e) { raised = /not authorized/.test(e.message); }
ok(raised, 'trainer list: non-owner raises 42501', null);

// === 2. ACADEMY SCOREBOARD (whole set) ======================================
await asUid(U_MGR);
const gWhole = board(academyRows);
let r = (await q(`SELECT * FROM public.get_academy_invoice_summary($1)`, [AC]))[0];
ok(Number(r.sum_unpaid) === gWhole.sum_unpaid, `academy summary sum_unpaid = ${gWhole.sum_unpaid}`, r);
ok(Number(r.count_unpaid) === gWhole.count_unpaid, `academy summary count_unpaid = ${gWhole.count_unpaid}`, r);
ok(Number(r.count_paid) === gWhole.count_paid, `academy summary count_paid = ${gWhole.count_paid}`, r);
ok(Number(r.count_draft) === gWhole.count_draft, `academy summary count_draft = ${gWhole.count_draft}`, r);

// === 3. ACADEMY SCOREBOARD scoped by trainer T1 =============================
const gT1 = board(academyRows.filter((m) => m.trainer === T1));
r = (await q(`SELECT * FROM public.get_academy_invoice_summary($1,$2)`, [AC, T1]))[0];
ok(Number(r.sum_unpaid) === gT1.sum_unpaid && Number(r.count_unpaid) === gT1.count_unpaid && Number(r.count_paid) === gT1.count_paid && Number(r.count_draft) === gT1.count_draft,
  `academy summary scoped trainer T1 == JS ${JSON.stringify(gT1)}`, r);

// === 4. ACADEMY SCOREBOARD scoped by location L1 ============================
const gL1 = board(academyRows.filter((m) => resolvedLoc(m) === L1));
r = (await q(`SELECT * FROM public.get_academy_invoice_summary($1,$2,$3)`, [AC, null, L1]))[0];
ok(Number(r.sum_unpaid) === gL1.sum_unpaid && Number(r.count_unpaid) === gL1.count_unpaid && Number(r.count_paid) === gL1.count_paid && Number(r.count_draft) === gL1.count_draft,
  `academy summary scoped location L1 == JS ${JSON.stringify(gL1)}`, r);

// === 5. PAGINATION never drops/dupes (academy AC, tab unpaid, pageSize 3) ===
const expectedUnpaidIds = new Set(academyRows.filter((m) => m.status !== 'paid' && m.status !== 'cancelled').map((m) => inv(m.n)));
const seen = [];
let totalCounts = new Set();
for (let page = 0; page < 4; page++) {
  const rows = await q(`SELECT id, total_count FROM public.get_academy_invoices($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [AC, 'unpaid', null, null, null, null, false, 'created_at', 'desc', 3, page * 3]);
  rows.forEach((row) => { seen.push(row.id); totalCounts.add(Number(row.total_count)); });
}
const dupes = seen.length !== new Set(seen).size;
ok(!dupes, 'pagination: no duplicate rows across pages', { seen: seen.length, distinct: new Set(seen).size });
ok(new Set(seen).size === expectedUnpaidIds.size && [...expectedUnpaidIds].every((id) => seen.includes(id)),
  `pagination: union of pages == all ${expectedUnpaidIds.size} unpaid rows (no drops)`, { got: new Set(seen).size, want: expectedUnpaidIds.size });
ok(totalCounts.size === 1 && totalCounts.has(expectedUnpaidIds.size), `pagination: total_count stable == ${expectedUnpaidIds.size} on every page`, [...totalCounts]);

// === 6. computed_status per row mirrors getComputedStatus ===================
const statusRows = await q(`SELECT id, computed_status, location_id, linked_email FROM public.get_academy_invoices($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [AC, 'all', null, null, null, null, false, 'created_at', 'desc', 500, 0]);
// p_tab 'all' (<> 'paid') returns unpaid set only; check those; then check paid + cancelled via dedicated calls
let statusOk = true;
const statusById = Object.fromEntries(statusRows.map((row) => [row.id, row.computed_status]));
for (const m of MODEL.filter((x) => x.status !== 'paid' && x.status !== 'cancelled')) {
  if (statusById[inv(m.n)] !== m.exp) { statusOk = false; console.error('  status mismatch', m.name, 'got', statusById[inv(m.n)], 'want', m.exp); }
}
ok(statusOk, 'computed_status mirrors getComputedStatus for unpaid set (incl overdue, open, draft)', null);
// paid tab → I4 computed 'paid'
const paidRows = await q(`SELECT id, computed_status FROM public.get_academy_invoices($1,$2)`, [AC, 'paid']);
ok(paidRows.length === 1 && paidRows[0].id === inv(4) && paidRows[0].computed_status === 'paid', 'paid tab returns only I4 with computed_status paid', paidRows);

// === 7. location_id resolution ==============================================
const locById = Object.fromEntries(statusRows.map((row) => [row.id, row.location_id]));
ok(locById[inv(1)] === L1, 'I1 location_id = L1', locById[inv(1)]);
ok(locById[inv(2)] === L2, 'I2 location_id = L2 (resolved via 2nd booking; null-slot first skipped)', locById[inv(2)]);
ok(locById[inv(6)] === null, 'I6 location_id = null (slot has no location)', locById[inv(6)]);

// === 8. linked_email + no_email filter ======================================
const emailById = Object.fromEntries(statusRows.map((row) => [row.id, row.linked_email]));
ok(emailById[inv(1)] === 'profile@example.com', 'I1 linked_email = profile email', emailById[inv(1)]);
ok(emailById[inv(2)] === 'guest@example.com', 'I2 linked_email = guest email', emailById[inv(2)]);
ok(emailById[inv(3)] === null, 'I3 linked_email = null (no email)', emailById[inv(3)]);
const noEmailRows = await q(`SELECT id FROM public.get_academy_invoices($1,$2,$3,$4,$5,$6,$7)`,
  [AC, 'unpaid', null, null, null, null, true]);
ok(noEmailRows.length === 1 && noEmailRows[0].id === inv(3), 'no_email filter returns only I3 (the only emailless unpaid invoice)', noEmailRows);

// === 9. search (ILIKE player_name) ==========================================
const searchRows = await q(`SELECT id FROM public.get_academy_invoices($1,$2,$3,$4)`, [AC, 'unpaid', null, 'ali']);
ok(searchRows.length === 1 && searchRows[0].id === inv(1), 'search "ali" matches only Alice (I1, unpaid)', searchRows);

// === 10. status filter (computed) ===========================================
const overdueRows = await q(`SELECT id FROM public.get_academy_invoices($1,$2,$3)`, [AC, 'unpaid', 'overdue']);
ok(overdueRows.length === 2 && overdueRows.map((x) => x.id).sort().join() === [inv(2), inv(7)].sort().join(),
  'status filter overdue → I2 + I7', overdueRows.map((x) => x.id));

// === 11. ACADEMY scope isolation (AC2 + trainer-owned excluded) =============
const allAcademy = await q(`SELECT id FROM public.get_academy_invoices($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [AC, 'all', null, null, null, null, false, 'created_at', 'desc', 500, 0]);
const allAcademyPaid = await q(`SELECT id FROM public.get_academy_invoices($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [AC, 'paid', null, null, null, null, false, 'created_at', 'desc', 500, 0]);
const academyIds = new Set([...allAcademy, ...allAcademyPaid].map((x) => x.id));
ok(!academyIds.has(inv(20)) && !academyIds.has(inv(21)) && !academyIds.has(inv(22)),
  'academy RPC excludes other-academy + trainer-owned invoices', [...academyIds]);

// === 12. TRAINER list + summary =============================================
await asUid(UT1);
const trBoard = (await q(`SELECT * FROM public.get_trainer_invoice_summary($1)`, [T1]))[0];
ok(Number(trBoard.sum_unpaid) === 200 && Number(trBoard.count_unpaid) === 1 && Number(trBoard.count_paid) === 1 && Number(trBoard.count_draft) === 0,
  'trainer summary: owned set only (unpaid 200/1, paid 1, draft 0)', trBoard);
const trUnpaid = await q(`SELECT id, total_count FROM public.get_trainer_invoices($1,$2)`, [T1, 'unpaid']);
ok(trUnpaid.length === 1 && trUnpaid[0].id === inv(21) && Number(trUnpaid[0].total_count) === 1,
  'trainer list unpaid: only the trainer-owned unpaid invoice (academy ones excluded)', trUnpaid);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
