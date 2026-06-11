/**
 * PGlite rehearsal for the shared-emails migration
 * (20260611220000_relax_guest_email_uniqueness.sql). Loads the ORIGINAL
 * linking functions/trigger (20260530190000) plus the old unique indexes,
 * applies the real migration on top, and asserts:
 *  - the unique indexes are gone (two kids + parent email can coexist)
 *  - signup auto-link with exactly ONE email match links guest+bookings+invoices
 *  - with TWO matches links NOTHING (no sibling mass-linking)
 *  - explicit linked_profile_id keeps linking its bookings regardless
 *  - the guest-change trigger inherits the guard
 *
 * Run: npx tsx scripts/db/rehearse-shared-emails.ts
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

await db.exec(`
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS
  $$ SELECT nullif(current_setting('app.uid', true), '')::uuid $$;

CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid, email text, full_name text);
CREATE TABLE public.user_roles (user_id uuid, role text, UNIQUE (user_id, role));
CREATE TABLE public.trainer_followers (player_id uuid, trainer_id uuid, UNIQUE (player_id, trainer_id));
CREATE TABLE public.guest_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id uuid, academy_profile_id uuid, full_name text NOT NULL,
  email text, phone text, linked_profile_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- the OLD unique indexes the migration must drop
CREATE UNIQUE INDEX idx_guest_players_trainer_email_unique ON public.guest_players (trainer_id, email)
  WHERE email IS NOT NULL AND email <> '' AND trainer_id IS NOT NULL;
CREATE UNIQUE INDEX idx_guest_players_academy_email_unique ON public.guest_players (academy_profile_id, email)
  WHERE email IS NOT NULL AND email <> '' AND academy_profile_id IS NOT NULL AND trainer_id IS NULL;

CREATE TABLE public.club_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_profile_id uuid NOT NULL, full_name text NOT NULL, email text NOT NULL,
  linked_profile_id uuid
);
CREATE UNIQUE INDEX unique_club_player_email ON public.club_players (club_profile_id, email);

CREATE TABLE public.bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id uuid, player_id uuid, guest_player_id uuid, status text
);
CREATE TABLE public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_player_id uuid, player_id uuid
);
`);

// original linking stack, then the migration under test on top
for (const f of [
  'supabase/migrations/20260530190000_link_guest_data_to_profile.sql',
  'supabase/migrations/20260611220000_relax_guest_email_uniqueness.sql',
]) {
  await db.exec(readFileSync(join(process.cwd(), f), 'utf8'));
}
console.log('migrations applied OK');

const q = async (sql: string) => (await db.query(sql)).rows as Record<string, unknown>[];
const T1 = '33333333-3333-3333-3333-333333333331';
const A1 = '11111111-1111-1111-1111-111111111111';

// 1. unique indexes gone: two kids + parent email coexist (would have been 23505)
{
  await db.exec(`
    INSERT INTO public.guest_players (trainer_id, full_name, email) VALUES
      ('${T1}', 'Kid A', 'parent@fam.nl'),
      ('${T1}', 'Kid B', 'parent@fam.nl');
    INSERT INTO public.guest_players (academy_profile_id, full_name, email) VALUES
      ('${A1}', 'Kid C', 'parent@fam.nl'),
      ('${A1}', 'Kid D', 'parent@fam.nl');
    INSERT INTO public.club_players (club_profile_id, full_name, email) VALUES
      ('${A1}', 'Kid E', 'parent@fam.nl'),
      ('${A1}', 'Kid F', 'parent@fam.nl');
  `);
  const n = await q(`SELECT count(*)::int AS n FROM public.guest_players WHERE email='parent@fam.nl'`);
  check('1. shared email allowed across multiple players (uniqueness dropped)', n[0].n === 4, n);
}

// 2. signup with AMBIGUOUS email (two kids) links NOTHING
{
  await db.exec(`
    INSERT INTO public.bookings (guest_player_id, status)
      SELECT id, 'confirmed' FROM public.guest_players WHERE full_name IN ('Kid A','Kid B');
    INSERT INTO public.profiles (id, user_id, email, full_name) VALUES
      ('44444444-4444-4444-4444-444444444441', gen_random_uuid(), 'parent@fam.nl', 'Parent Person');
  `);
  const r = await q(`SELECT public.link_guest_data_to_profile('44444444-4444-4444-4444-444444444441') AS r`);
  const res = r[0].r as Record<string, number>;
  const linked = await q(`SELECT count(*)::int AS n FROM public.guest_players WHERE linked_profile_id IS NOT NULL`);
  check('2. ambiguous email (4 matches) links nothing — no sibling mass-linking',
    res.guest_players_linked === 0 && res.bookings_linked === 0 && linked[0].n === 0, { res, linked });
}

// 3. single-match email links guest + bookings + invoices
{
  await db.exec(`
    INSERT INTO public.guest_players (trainer_id, full_name, email) VALUES
      ('${T1}', 'Solo Sam', 'solo@test.nl');
    INSERT INTO public.bookings (guest_player_id, status)
      SELECT id, 'confirmed' FROM public.guest_players WHERE full_name='Solo Sam';
    INSERT INTO public.invoices (guest_player_id)
      SELECT id FROM public.guest_players WHERE full_name='Solo Sam';
    INSERT INTO public.profiles (id, user_id, email, full_name) VALUES
      ('44444444-4444-4444-4444-444444444442', gen_random_uuid(), 'solo@test.nl', 'Solo Sam');
  `);
  const r = await q(`SELECT public.link_guest_data_to_profile('44444444-4444-4444-4444-444444444442') AS r`);
  const res = r[0].r as Record<string, number>;
  check('3. single email match links guest + booking + invoice',
    res.guest_players_linked === 1 && res.bookings_linked === 1 && res.invoices_linked === 1, res);
}

// 4. explicitly linked guest keeps linking its data even with shared email chaos
{
  await db.exec(`
    UPDATE public.guest_players SET linked_profile_id = '44444444-4444-4444-4444-444444444441'
    WHERE full_name = 'Kid A';
    INSERT INTO public.invoices (guest_player_id)
      SELECT id FROM public.guest_players WHERE full_name='Kid A';
  `);
  const r = await q(`SELECT public.link_guest_data_to_profile('44444444-4444-4444-4444-444444444441') AS r`);
  const res = r[0].r as Record<string, number>;
  check("4. explicit link still moves that guest's bookings/invoices (email path stays guarded)",
    res.invoices_linked === 1 && res.guest_players_linked === 0, res);
}

// 5. guest-change trigger inherits the guard: inserting another guest with the
// parent email must NOT auto-link it (3+ matches now)
{
  await db.exec(`
    INSERT INTO public.guest_players (trainer_id, full_name, email) VALUES
      ('${T1}', 'Kid G', 'parent@fam.nl');
  `);
  const g = await q(`SELECT linked_profile_id FROM public.guest_players WHERE full_name='Kid G'`);
  check('5. trigger on insert with ambiguous email leaves guest unlinked', g[0].linked_profile_id === null, g);
}

console.log(failures ? `\n*** REHEARSAL FAILED (${failures}) ***` : '\n*** REHEARSAL PASSED ***');
process.exit(failures ? 1 : 0);
