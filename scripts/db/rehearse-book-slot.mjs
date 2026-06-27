import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const db = new PGlite();
const SLOT = '50000000-0000-0000-0000-000000000001';
const PL = '20000000-0000-0000-0000-000000000001';
await db.exec(`
  CREATE ROLE service_role;
  CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, max_participants int);
  CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid, status text, payment_status text, payment_amount numeric, notes text);
  INSERT INTO public.availability_slots VALUES ('${SLOT}', 2);
`);
await db.exec(readFileSync('supabase/migrations/20260614130000_book_slot_for_payment.sql','utf8'));
// Adds the optional _notes parameter (Option A mutation boundary). The 3-arg
// calls below must still resolve via the DEFAULT — that's the deploy-gap path.
await db.exec(readFileSync('supabase/migrations/20260701130000_book_slot_for_payment_notes.sql','utf8'));
let pass=0,fail=0; const ok=(c,m,x)=>{c?(pass++,console.log('PASS',m)):(fail++,console.error('FAIL',m,x??''));};
const book=async(p)=>{ try{ const r=await db.query(`SELECT public.book_slot_for_payment($1,$2,$3) AS id`,[SLOT,p,40]); return {id:r.rows[0].id}; }catch(e){ return {err:String(e.message||e)}; } };
// Backward-compat: the legacy 3-arg call still works against the new 4-arg overload.
let r=await book(PL); ok(!!r.id,'3-arg book #1 under capacity succeeds (notes default NULL)',r);
r=await book('20000000-0000-0000-0000-000000000002'); ok(!!r.id,'book #2 fills the slot (2/2)',r);
r=await book('20000000-0000-0000-0000-000000000003'); ok(!!r.err && /slot_full/.test(r.err),'book #3 rejected: slot_full (capacity enforced on paid path)',r);
const n=Number((await db.query(`SELECT count(*) n FROM public.bookings WHERE slot_id='${SLOT}'`)).rows[0].n);
ok(n===2,'no overbooking — exactly 2 bookings',n);

// Notes are persisted (and trimmed) via the 4-arg overload.
const SLOT2='50000000-0000-0000-0000-000000000010';
await db.exec(`INSERT INTO public.availability_slots VALUES ('${SLOT2}', 2);`);
const rn=await db.query(`SELECT public.book_slot_for_payment($1,$2,$3,$4) AS id`,[SLOT2,PL,40,'  bring my own racket  ']);
const note=(await db.query(`SELECT notes FROM public.bookings WHERE id=$1`,[rn.rows[0].id])).rows[0].notes;
ok(note==='bring my own racket','4-arg overload trims + stores notes',note);
const re=await db.query(`SELECT public.book_slot_for_payment($1,$2,$3,$4) AS id`,[SLOT2,'20000000-0000-0000-0000-000000000004',40,'   ']);
const noteE=(await db.query(`SELECT notes FROM public.bookings WHERE id=$1`,[re.rows[0].id])).rows[0].notes;
ok(noteE===null,'whitespace-only notes stored as NULL',noteE);

console.log(fail===0?'\nALL book-slot checks passed':`\n${fail} FAILED`); process.exit(fail===0?0:1);
