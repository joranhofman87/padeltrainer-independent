import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const A = '20000000-0000-0000-0000-000000000001'; // has history, drifted
const B = '20000000-0000-0000-0000-000000000002'; // has history, in sync
const C = '20000000-0000-0000-0000-000000000003'; // no history (left alone)

await db.exec(`
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, skill_rating numeric, rating_system text);
  CREATE TABLE public.player_rating_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id uuid, rating numeric, rating_system text, source text,
    scraped_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now());

  INSERT INTO public.profiles (id, skill_rating, rating_system) VALUES
    ('${A}', 6.0, 'knltb'),   -- profile says 6.0
    ('${B}', 4.5, 'knltb'),
    ('${C}', 3.0, 'knltb');
  -- A: last history is 5.0 (drifted from profile's 6.0). B: last history matches.
  INSERT INTO public.player_rating_history (profile_id, rating, rating_system, source, scraped_at) VALUES
    ('${A}', 7.0, 'knltb', 'scrape', now() - interval '2 day'),
    ('${A}', 5.0, 'knltb', 'scrape', now() - interval '1 day'),
    ('${B}', 4.5, 'knltb', 'scrape', now() - interval '1 day');
`);

await db.exec(readFileSync('supabase/migrations/20260613200000_skill_rating_history_sync.sql', 'utf8'));

let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? (pass++, console.log('PASS', m)) : (fail++, console.error('FAIL', m, x ?? '')); };
const lastRating = async (pid) => (await db.query(
  `SELECT rating FROM public.player_rating_history WHERE profile_id='${pid}' ORDER BY scraped_at DESC LIMIT 1`)).rows[0]?.rating;
const countFor = async (pid) => (await db.query(
  `SELECT count(*)::int AS n FROM public.player_rating_history WHERE profile_id='${pid}'`)).rows[0].n;

// Reconcile: A drifted (5.0 → should now have a 6.0 row); B in sync (no new row); C untouched.
ok(Number(await lastRating(A)) === 6.0, 'RECONCILE: drifted profile gets a history row matching skill_rating', await lastRating(A));
ok((await countFor(B)) === 1, 'RECONCILE: in-sync profile gets NO new row', await countFor(B));
ok((await countFor(C)) === 0, 'RECONCILE: profile with no history is left alone (no invented history)', await countFor(C));

// Trigger: changing skill_rating appends a history row.
await db.exec(`UPDATE public.profiles SET skill_rating = 5.5 WHERE id='${B}'`);
ok(Number(await lastRating(B)) === 5.5 && (await countFor(B)) === 2, 'TRIGGER: skill_rating change appends a matching history row', [await lastRating(B), await countFor(B)]);

// Dedup: setting skill_rating to the SAME value adds nothing.
await db.exec(`UPDATE public.profiles SET skill_rating = 5.5 WHERE id='${B}'`);
ok((await countFor(B)) === 2, 'DEDUP: re-setting the same skill_rating adds no row', await countFor(B));

// Null guard: setting skill_rating null does not insert.
await db.exec(`UPDATE public.profiles SET skill_rating = NULL WHERE id='${C}'`);
ok((await countFor(C)) === 0, 'NULL: clearing skill_rating inserts nothing', await countFor(C));

console.log(fail === 0 ? '\nALL skill-rating history sync checks passed' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
