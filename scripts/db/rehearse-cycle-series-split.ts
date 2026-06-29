/**
 * PGlite rehearsal for the one-time cycle series split (docs/CYCLE_SERIES_SPLIT.sql).
 * Real Postgres in WASM; runs the ACTUAL owner-run SQL file against a synthetic
 * schema seeded with the edge cases:
 *   - a multi-court timeslot (many slots, same trainer/dow/time) -> ONE cycle
 *   - a NULL-location series (must split distinctly from a located one)
 *   - a DST-spanning series (two slots at the same Amsterdam wall-time across the
 *     Oct switch) -> ONE cycle (UTC grouping would wrongly split them)
 *   - bookings + an invoice that must be byte-identical afterwards
 *   - an untouched non-parent single-series cycle
 * plus RUN2 idempotency and the rollback block.
 *
 * The synthetic parent cycles use the REAL prod parent UUIDs because the SQL
 * filters on them by id.
 *
 * Run: npx tsx scripts/db/rehearse-cycle-series-split.ts
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const db = new PGlite();
let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `  → ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
};
const q = async (sql: string) => (await db.query(sql)).rows as Record<string, unknown>[];
const scalar = async (sql: string) => (await q(sql))[0];

// real prod parent ids (the SQL filters on these literally)
const P1 = '1e40f602-21eb-4ef1-ae31-f1616897f4c8'; // Padel zomer
const P2 = '2aa741a2-f0e6-435b-a3cb-998df8b6c005'; // Tennis zomer
const P3 = '69f60dbe-9a7c-4c19-a794-e68e13915fc2'; // Volgende ronde (DST case)
const ACA = '11111111-1111-1111-1111-111111111111';
const CX = '99999999-9999-9999-9999-999999999999'; // untouched non-parent cycle
const TR1 = '33333333-3333-3333-3333-333333333331';
const TR2 = '33333333-3333-3333-3333-333333333332';
const U1 = '44444444-4444-4444-4444-444444444441';
const U2 = '44444444-4444-4444-4444-444444444442';
const L1 = '55555555-5555-5555-5555-555555555551';

await db.exec(`
CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY, timezone text NOT NULL DEFAULT 'Europe/Amsterdam');
CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid NOT NULL);
CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, full_name text);
CREATE TABLE public.cycles (
  id uuid PRIMARY KEY,
  type text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  owner_type text NOT NULL,
  owner_id uuid NOT NULL,
  start_date date,
  end_date date,
  settings jsonb,
  price_per_session numeric,
  total_price numeric,
  location_id uuid,
  currency text,
  is_always_open boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.availability_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cyclus_id uuid,
  cyclus_name text,
  trainer_id uuid,
  location_id uuid,
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL,
  split_payment boolean
);
CREATE TABLE public.bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id uuid NOT NULL, status text, payment_status text
);
CREATE TABLE public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  total numeric, subtotal numeric, vat_amount numeric, status text,
  cycle_id uuid, booking_ids uuid[]
);

-- mirror the prod trigger that fires on a cyclus_id re-point: it copies the new
-- cycle's settings.split_payment into the slot. If the split did NOT copy the
-- parent settings, this would null the slot's split_payment -> the assertion fails.
CREATE FUNCTION public.inherit_cycle_split_payment() RETURNS trigger AS $$
BEGIN
  IF NEW.cyclus_id IS NOT NULL THEN
    NEW.split_payment := (SELECT (settings->>'split_payment')::boolean FROM public.cycles WHERE id = NEW.cyclus_id);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_inherit_cycle_split_payment
  BEFORE INSERT OR UPDATE OF cyclus_id ON public.availability_slots
  FOR EACH ROW EXECUTE FUNCTION public.inherit_cycle_split_payment();
`);

await db.exec(`
INSERT INTO public.academy_profiles (id, timezone) VALUES ('${ACA}', 'Europe/Amsterdam');
INSERT INTO public.trainer_profiles (id, user_id) VALUES ('${TR1}', '${U1}'), ('${TR2}', '${U2}');
INSERT INTO public.profiles (user_id, full_name) VALUES ('${U1}', 'Nick Trainer'), ('${U2}', 'Sanne Coach');

-- 3 parent mega-cycles (academy-owned, split_payment=true in settings)
INSERT INTO public.cycles (id, type, name, status, owner_type, owner_id, settings, price_per_session, currency, is_always_open) VALUES
  ('${P1}', 'cyclus', 'Padeltrainingen zomer 2026', 'open', 'academy', '${ACA}', '{"split_payment": true, "lesson_types": ["padel"]}'::jsonb, 15, 'EUR', false),
  ('${P2}', 'cyclus', 'Tennistrainingen zomer 2026', 'open', 'academy', '${ACA}', '{"split_payment": true}'::jsonb, 12, 'EUR', false),
  ('${P3}', 'cyclus', 'Volgende ronde 2026', 'open', 'academy', '${ACA}', '{"split_payment": true}'::jsonb, 18, 'EUR', false);

-- untouched non-parent single-series cycle + its slots
INSERT INTO public.cycles (id, type, name, status, owner_type, owner_id, settings, price_per_session, currency, is_always_open) VALUES
  ('${CX}', 'cyclus', 'Maandag 09:00 - Untouched', 'open', 'academy', '${ACA}', '{"split_payment": false}'::jsonb, 20, 'EUR', false);

-- P1 series (parent slots have cyclus_name = NULL, matching prod):
--   S1 Mon 18:00-19:00 TR1 @L1 -> 4 slots (2 dates x 2 courts) -> 1 cycle
--   S2 Mon 19:00-20:00 TR1 @L1 -> 2 slots -> 1 cycle
--   S3 Tue 12:30-14:00 TR1 @NULL location -> 2 slots -> 1 cycle (distinct via NULL loc)
INSERT INTO public.availability_slots (cyclus_id, cyclus_name, trainer_id, location_id, start_time, end_time, split_payment) VALUES
  ('${P1}', NULL, '${TR1}', '${L1}', '2026-04-06 16:00:00+00', '2026-04-06 17:00:00+00', true),
  ('${P1}', NULL, '${TR1}', '${L1}', '2026-04-06 16:00:00+00', '2026-04-06 17:00:00+00', true),
  ('${P1}', NULL, '${TR1}', '${L1}', '2026-04-13 16:00:00+00', '2026-04-13 17:00:00+00', true),
  ('${P1}', NULL, '${TR1}', '${L1}', '2026-04-13 16:00:00+00', '2026-04-13 17:00:00+00', true),
  ('${P1}', NULL, '${TR1}', '${L1}', '2026-04-06 17:00:00+00', '2026-04-06 18:00:00+00', true),
  ('${P1}', NULL, '${TR1}', '${L1}', '2026-04-13 17:00:00+00', '2026-04-13 18:00:00+00', true),
  ('${P1}', NULL, '${TR1}', NULL,     '2026-04-07 10:30:00+00', '2026-04-07 12:00:00+00', true),
  ('${P1}', NULL, '${TR1}', NULL,     '2026-04-14 10:30:00+00', '2026-04-14 12:00:00+00', true);

-- P2 series: S4 Wed 17:00-18:00 TR2 @L1 -> 2 slots -> 1 cycle
INSERT INTO public.availability_slots (cyclus_id, cyclus_name, trainer_id, location_id, start_time, end_time, split_payment) VALUES
  ('${P2}', NULL, '${TR2}', '${L1}', '2026-04-08 15:00:00+00', '2026-04-08 16:00:00+00', true),
  ('${P2}', NULL, '${TR2}', '${L1}', '2026-04-15 15:00:00+00', '2026-04-15 16:00:00+00', true);

-- P3 series: S5 Fri 18:00-19:00 TR2 @L1 DST-spanning -> 2 slots (CEST 16:00Z + CET 17:00Z) -> 1 cycle.
-- NON-NULL cyclus_name on purpose (matches prod "Volgende ronde 2026") to prove the rollback restores it.
INSERT INTO public.availability_slots (cyclus_id, cyclus_name, trainer_id, location_id, start_time, end_time, split_payment) VALUES
  ('${P3}', 'Volgende ronde 2026', '${TR2}', '${L1}', '2026-08-28 16:00:00+00', '2026-08-28 17:00:00+00', true),
  ('${P3}', 'Volgende ronde 2026', '${TR2}', '${L1}', '2026-11-06 17:00:00+00', '2026-11-06 18:00:00+00', true);

-- untouched cycle CX slots
INSERT INTO public.availability_slots (id, cyclus_id, cyclus_name, trainer_id, location_id, start_time, end_time, split_payment) VALUES
  ('66666666-6666-6666-6666-666666666661', '${CX}', 'Maandag 09:00 - Untouched', '${TR1}', '${L1}', '2026-04-06 07:00:00+00', '2026-04-06 08:00:00+00', false),
  ('66666666-6666-6666-6666-666666666662', '${CX}', 'Maandag 09:00 - Untouched', '${TR1}', '${L1}', '2026-04-13 07:00:00+00', '2026-04-13 08:00:00+00', false);

-- bookings on P1 slots (must be byte-identical afterwards; ids default)
INSERT INTO public.bookings (slot_id, status, payment_status)
SELECT id, 'confirmed', 'paid'
FROM public.availability_slots WHERE cyclus_id = '${P1}' LIMIT 3;

-- one invoice referencing CX, with booking_ids (immutability target)
INSERT INTO public.invoices (id, total, subtotal, vat_amount, status, cycle_id, booking_ids)
SELECT 'cccccccc-0000-0000-0000-000000000001', 45.00, 45.00, 0, 'paid', '${CX}',
       array_agg(id) FROM public.bookings;
`);

const SQL_FILE = 'docs/CYCLE_SERIES_SPLIT.sql';
const sql = readFileSync(join(process.cwd(), SQL_FILE), 'utf8');

// fingerprints of the never-written tables (same expressions the SQL checks)
const BOOK_CK = `SELECT md5(coalesce(string_agg(id::text, ',' ORDER BY id), '')) AS ck FROM public.bookings`;
const INV_CK = `SELECT md5(coalesce(string_agg(id::text||'|'||coalesce(total::text,'')||'|'||coalesce(subtotal::text,'')||'|'||coalesce(vat_amount::text,'')||'|'||coalesce(status,'')||'|'||coalesce(cycle_id::text,'')||'|'||coalesce(array_to_string(booking_ids,','),''), ',' ORDER BY id), '')) AS ck FROM public.invoices`;
const CX_CK = `SELECT md5(id::text||name||status||coalesce(price_per_session::text,'')) AS ck FROM public.cycles WHERE id='${CX}'`;

const bookBefore = (await scalar(BOOK_CK)).ck;
const invBefore = (await scalar(INV_CK)).ck;
const cxBefore = (await scalar(CX_CK)).ck;
const slotsBefore = (await scalar(`SELECT count(*)::int AS n FROM public.availability_slots`)).n;

console.log('--- RUN 1 ---');
try {
  await db.exec(sql);
  check('RUN1 migration commits without RAISE', true);
} catch (e) {
  check('RUN1 migration commits without RAISE', false, String(e));
}

const marker = `settings->>'split_migration' = 'CYCLE_SERIES_SPLIT_v1'`;

{
  const r = await scalar(`SELECT count(*)::int AS n FROM public.availability_slots WHERE cyclus_id IN ('${P1}','${P2}','${P3}')`);
  check('1. zero slots remain on the 3 parents', r.n === 0, r);
}
{
  const r = await scalar(`SELECT count(*)::int AS n FROM public.cycles WHERE ${marker}`);
  check('2. exactly 5 split cycles created (3 P1 + 1 P2 + 1 P3)', r.n === 5, r);
}
{
  const r = await scalar(`SELECT count(*)::int AS n FROM public.availability_slots s JOIN public.cycles nc ON nc.id=s.cyclus_id WHERE nc.${marker}`);
  check('3. all 12 parent slots now owned by split cycles', r.n === 12, r);
}
{
  // S1 multi-court (4 slots) collapsed into ONE Monday-18:00 cycle named after the trainer
  const r = await q(`SELECT nc.name, count(s.id)::int AS slots
    FROM public.cycles nc JOIN public.availability_slots s ON s.cyclus_id=nc.id
    WHERE nc.${marker} AND nc.settings->>'split_from_cycle_id'='${P1}'
      AND nc.name LIKE 'Maandag 18:00%' GROUP BY nc.name`);
  check('4. multi-court Mon 18:00 -> ONE cycle with 4 slots, trainer-named',
    r.length === 1 && r[0].slots === 4 && r[0].name === 'Maandag 18:00 - Nick Trainer', r);
}
{
  // NULL-location Tuesday series formed its own cycle (2 slots)
  const r = await q(`SELECT nc.name, nc.location_id, count(s.id)::int AS slots
    FROM public.cycles nc JOIN public.availability_slots s ON s.cyclus_id=nc.id
    WHERE nc.${marker} AND nc.name LIKE 'Dinsdag 12:30%' GROUP BY nc.name, nc.location_id`);
  check('5. NULL-location Tue 12:30 -> own cycle (2 slots, null location)',
    r.length === 1 && r[0].slots === 2 && r[0].location_id === null, r);
}
{
  // DST-spanning Friday series collapsed to ONE cycle owning both slots
  const r = await q(`SELECT nc.name, count(s.id)::int AS slots
    FROM public.cycles nc JOIN public.availability_slots s ON s.cyclus_id=nc.id
    WHERE nc.${marker} AND nc.settings->>'split_from_cycle_id'='${P3}' GROUP BY nc.name`);
  check('6. DST-spanning Fri 18:00 -> ONE cycle with both slots (CEST+CET)',
    r.length === 1 && r[0].slots === 2 && r[0].name === 'Vrijdag 18:00 - Sanne Coach', r);
}
{
  // split_payment preserved: trigger re-applied the (copied) cycle setting -> slots still true
  const r = await scalar(`SELECT count(*)::int AS n FROM public.availability_slots s JOIN public.cycles nc ON nc.id=s.cyclus_id WHERE nc.${marker} AND s.split_payment IS NOT TRUE`);
  check('7. split_payment preserved on every re-pointed slot (trigger no-op)', r.n === 0, r);
  const c = await scalar(`SELECT count(*)::int AS n FROM public.cycles WHERE ${marker} AND (settings->>'split_payment')::boolean IS NOT TRUE`);
  check('7b. every split cycle inherited split_payment=true from its parent settings', c.n === 0, c);
}
{
  const b = (await scalar(BOOK_CK)).ck;
  const i = (await scalar(INV_CK)).ck;
  const x = (await scalar(CX_CK)).ck;
  const sl = (await scalar(`SELECT count(*)::int AS n FROM public.availability_slots`)).n;
  check('8. bookings row-set byte-identical', b === bookBefore, { b, bookBefore });
  check('9. invoices row-set byte-identical (money + links untouched)', i === invBefore, { i, invBefore });
  check('10. untouched cycle CX row-set byte-identical', x === cxBefore, { x, cxBefore });
  check('11. availability_slots count unchanged', sl === slotsBefore, { sl, slotsBefore });
  const cx = await scalar(`SELECT count(*)::int AS n FROM public.availability_slots WHERE cyclus_id='${CX}'`);
  check('11b. untouched cycle CX still owns its 2 slots', cx.n === 2, cx);
}

// idempotency
console.log('--- RUN 2 (idempotency) ---');
const cyclesBeforeRun2 = (await scalar(`SELECT count(*)::int AS n FROM public.cycles`)).n;
const mapBeforeRun2 = (await scalar(`SELECT md5(string_agg(id::text||cyclus_id::text, ',' ORDER BY id)) AS ck FROM public.availability_slots`)).ck;
try {
  await db.exec(sql);
  check('RUN2 commits without RAISE', true);
} catch (e) {
  check('RUN2 commits without RAISE', false, String(e));
}
const cyclesAfterRun2 = (await scalar(`SELECT count(*)::int AS n FROM public.cycles`)).n;
const mapAfterRun2 = (await scalar(`SELECT md5(string_agg(id::text||cyclus_id::text, ',' ORDER BY id)) AS ck FROM public.availability_slots`)).ck;
check('12. RUN2 idempotent: no new cycles, no slots moved',
  cyclesBeforeRun2 === cyclesAfterRun2 && mapBeforeRun2 === mapAfterRun2,
  { cyclesBeforeRun2, cyclesAfterRun2 });

// rollback
console.log('--- ROLLBACK ---');
const ROLLBACK = `
BEGIN;
UPDATE public.availability_slots s
   SET cyclus_id = (nc.settings->>'split_from_cycle_id')::uuid,
       cyclus_name = (nc.settings->>'orig_cyclus_name')
  FROM public.cycles nc
 WHERE nc.id = s.cyclus_id
   AND nc.settings->>'split_migration' = 'CYCLE_SERIES_SPLIT_v1';
DELETE FROM public.cycles nc
 WHERE nc.settings->>'split_migration' = 'CYCLE_SERIES_SPLIT_v1'
   AND NOT EXISTS (SELECT 1 FROM public.availability_slots s WHERE s.cyclus_id = nc.id);
COMMIT;`;
await db.exec(ROLLBACK);
{
  const m = (await scalar(`SELECT count(*)::int AS n FROM public.cycles WHERE ${marker}`)).n;
  check('13. rollback removed all split cycles', m === 0, { m });
  const onParents = (await scalar(`SELECT count(*)::int AS n FROM public.availability_slots WHERE cyclus_id IN ('${P1}','${P2}','${P3}')`)).n;
  check('14. rollback re-pointed all 12 slots back to parents', onParents === 12, { onParents });
  const p12named = (await scalar(`SELECT count(*)::int AS n FROM public.availability_slots WHERE cyclus_id IN ('${P1}','${P2}') AND cyclus_name IS NOT NULL`)).n;
  check('15. rollback restored cyclus_name = NULL on P1/P2 parent slots', p12named === 0, { p12named });
  const p3restored = (await scalar(`SELECT count(*)::int AS n FROM public.availability_slots WHERE cyclus_id='${P3}' AND cyclus_name='Volgende ronde 2026'`)).n;
  check('15b. rollback restored original cyclus_name ("Volgende ronde 2026") on P3 slots', p3restored === 2, { p3restored });
  const b = (await scalar(BOOK_CK)).ck;
  const i = (await scalar(INV_CK)).ck;
  check('16. bookings + invoices still byte-identical after rollback', b === bookBefore && i === invBefore, { b, i });
}

console.log(failures ? `\n*** REHEARSAL FAILED (${failures}) ***` : '\n*** REHEARSAL PASSED ***');
process.exit(failures ? 1 : 0);
