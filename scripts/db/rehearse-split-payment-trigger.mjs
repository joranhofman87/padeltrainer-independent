import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const CY = '40000000-0000-0000-0000-000000000001';
const S1 = '50000000-0000-0000-0000-000000000001';
const S2 = '50000000-0000-0000-0000-000000000002';
const S3 = '50000000-0000-0000-0000-000000000003'; // added later
const STANDALONE = '50000000-0000-0000-0000-000000000009';

await db.exec(`
  CREATE TABLE public.cycles (id uuid PRIMARY KEY, settings jsonb DEFAULT '{}'::jsonb);
  CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, cyclus_id uuid, split_payment boolean);

  INSERT INTO public.cycles (id, settings) VALUES ('${CY}', '{"split_payment": true}'::jsonb);
  -- S1 correct, S2 pre-drifted (false while cycle says true), STANDALONE no cycle.
  INSERT INTO public.availability_slots (id, cyclus_id, split_payment) VALUES
    ('${S1}', '${CY}', true),
    ('${S2}', '${CY}', false),
    ('${STANDALONE}', NULL, true);
`);

const mig = readFileSync('supabase/migrations/20260613170000_split_payment_mirror_trigger.sql', 'utf8');
await db.exec(mig);

let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? (pass++, console.log('PASS', m)) : (fail++, console.error('FAIL', m, x ?? '')); };
const split = async (id) => (await db.query(`SELECT split_payment FROM public.availability_slots WHERE id='${id}'`)).rows[0]?.split_payment;

// (3) reconcile ran in the migration: S2 should now match the cycle (true).
ok((await split(S2)) === true, 'RECONCILE: pre-drifted slot repaired to match cycle (true)', await split(S2));
ok((await split(S1)) === true, 'RECONCILE: already-correct slot unchanged (true)', await split(S1));
ok((await split(STANDALONE)) === true, 'RECONCILE: standalone slot (no cycle) untouched', await split(STANDALONE));

// (1) mirror: toggle the cycle OFF → all linked slots become false.
await db.exec(`UPDATE public.cycles SET settings = '{"split_payment": false}'::jsonb WHERE id='${CY}'`);
ok((await split(S1)) === false && (await split(S2)) === false, 'MIRROR: cycle OFF propagates to all linked slots', [await split(S1), await split(S2)]);
ok((await split(STANDALONE)) === true, 'MIRROR: standalone slot not affected by cycle change', await split(STANDALONE));

// toggle back ON.
await db.exec(`UPDATE public.cycles SET settings = '{"split_payment": true}'::jsonb WHERE id='${CY}'`);
ok((await split(S1)) === true, 'MIRROR: cycle ON propagates back', await split(S1));

// (2) inherit: new slot linked to the cycle adopts the cycle's value, ignoring the inserted value.
await db.exec(`INSERT INTO public.availability_slots (id, cyclus_id, split_payment) VALUES ('${S3}', '${CY}', false)`);
ok((await split(S3)) === true, 'INHERIT: new slot linked to cycle adopts cycle value (true), not inserted false', await split(S3));

// inherit on relink: standalone slot linked to the cycle inherits.
await db.exec(`UPDATE public.availability_slots SET cyclus_id='${CY}' WHERE id='${STANDALONE}'`);
ok((await split(STANDALONE)) === true, 'INHERIT: slot re-linked to cycle adopts cycle value', await split(STANDALONE));

// no-recursion sanity: a plain split_payment update on a slot does not blow up.
await db.exec(`UPDATE public.availability_slots SET split_payment=false WHERE id='${S1}'`);
ok((await split(S1)) === false, 'NO-RECURSION: direct slot split_payment update succeeds', await split(S1));

console.log(fail === 0 ? '\nALL split_payment trigger checks passed' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
