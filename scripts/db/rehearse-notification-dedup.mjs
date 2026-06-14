// Rehearsal for BJ-08 notification_sends dedup table (20260614210000).
// Validates the claim/release semantics the notify-followers edge fn relies on:
// ON CONFLICT (dedup_key) DO NOTHING RETURNING claims only the not-yet-sent keys;
// a released (deleted) key can be re-claimed; and the table is service_role only.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? (pass++, console.log('PASS', m)) : (fail++, console.error('FAIL', m, JSON.stringify(x ?? ''))); };
const raises = async (sql) => { try { await db.exec(sql); return false; } catch { return true; } };
const claim = async (keys) => (await db.query(
  `INSERT INTO public.notification_sends (dedup_key) SELECT unnest($1::text[]) ON CONFLICT (dedup_key) DO NOTHING RETURNING dedup_key`,
  [keys],
)).rows.map((r) => r.dedup_key);

await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;`);
await db.exec(readFileSync('supabase/migrations/20260614210000_notification_sends_dedup.sql', 'utf8'));

await db.query(`SET ROLE service_role`);

// First claim of a fresh event: both keys are newly inserted.
const c1 = await claim(['t:p1:na:wk', 't:p2:na:wk']);
ok(c1.length === 2 && c1.includes('t:p1:na:wk') && c1.includes('t:p2:na:wk'),
  'claim returns both fresh keys (first send)', c1);

// Re-trigger of the SAME event: already-sent keys are skipped, only the new one claims.
const c2 = await claim(['t:p1:na:wk', 't:p3:na:wk']);
ok(c2.length === 1 && c2[0] === 't:p3:na:wk',
  'claim skips already-sent keys, returns only the new one (no re-spam on re-trigger)', c2);

// Release (failed send) → the key can be re-claimed next run.
await db.query(`DELETE FROM public.notification_sends WHERE dedup_key = 't:p2:na:wk'`);
const c3 = await claim(['t:p2:na:wk']);
ok(c3.length === 1 && c3[0] === 't:p2:na:wk', 'a released (failed) key is re-claimable (retryable)', c3);

// A distinct reopen event (different booking id anchor) is independent.
const c4 = await claim(['t:p1:sr:booking-1']);
ok(c4.length === 1, 'a distinct event anchor (sr:booking) claims independently', c4);

await db.query(`RESET ROLE`);

// Lockdown: authenticated cannot write the dedup table.
ok(await raises(`SET ROLE authenticated; INSERT INTO public.notification_sends (dedup_key) VALUES ('x')`),
  'authenticated CANNOT insert into notification_sends (RLS + no grant)', null);
await db.query(`RESET ROLE`);
ok(await raises(`SET ROLE anon; SELECT * FROM public.notification_sends`),
  'anon CANNOT read notification_sends', null);
await db.query(`RESET ROLE`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
