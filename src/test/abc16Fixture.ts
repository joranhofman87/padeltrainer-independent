/**
 * ABC-16 — the shared PRE-H0 fixture.
 *
 * Both ABC-16 suites (the PGlite authority suite and the real-Postgres privilege suite) need
 * the same thing: a database in the state main was in BEFORE the H0 migration, built from the
 * REAL migration files rather than hand-copied statements. Two hand-maintained copies would
 * drift, and the drift would read as coverage.
 *
 * Only the ambient objects those migrations depend on are stubbed — tables and helper
 * functions that other migrations own. Everything ABC-16 actually reasons about (the overlay
 * tables, their policies and grants, the three authority predicates, `set_player_location`,
 * the person-stamp functions and triggers) comes from the shipped files.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MIGRATION = (f: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8');

/** The containment migration under test (ABC-16 + ABC-17). */
export const H0_MIGRATION = '20261118110000_abc16_abc17_relationship_evidence_containment.sql';

/**
 * The shipped files that build the pre-H0 overlay world, in chain order.
 *
 * Chosen by what defines the objects ABC-16 changes: the overlay tables and their FOR ALL
 * policies, the billing-email column, the locations table + `set_player_location`, the three
 * authority predicates in their EFFECTIVE definitions, and the person-stamp triggers.
 */
export const PRE_H0_MIGRATIONS = [
  // Chronological: the chain must apply in timestamp order.
  '20260224171306_1e85f4f8-c803-42b0-9b68-a30cd581ffcd.sql',
  '20260510090036_ef6a35bb-824f-45dc-b596-c77d707b02e8.sql',
  '20260510102923_d1c09638-3284-4cfd-b382-ab4c1abb85f4.sql',
  '20260531130000_academy_player_metadata_preferred_location.sql',
  '20260531140000_academy_player_metadata_removed.sql',
  '20260615100000_session_player_notes.sql',
  '20260615110040_email_remediation.sql',
  '20260615110050_email_remediation_hardening.sql',
  '20260615110100_academy_player_locations.sql',
  '20260704120000_academy_manager_bookings_update.sql',
  '20260706130100_p2_2_guest_players_academy_scope.sql',
  '20260713110000_trainer_guest_visibility.sql',
  '20260716100000_member_window_linked_guest.sql',
  '20260717100000_lock_can_book_member_window.sql',
  '20260731100000_member_window_priority_guest.sql',
  '20260801100000_fix_guest_players_select_returning.sql',
  '20260826210000_guest_twin_bridge.sql',
  '20260826240000_twin_reader_precedence_and_lock.sql',
  '20260826250000_repurpose_trigger_definer.sql',
  '20260826260000_persons_expand.sql',
  '20260826280000_persons_backfill.sql',
  '20260826290000_phase31_person_display_readers.sql',
  '20260831100000_phase33_attendance_person_rls.sql',
  '20260901100000_phase33d_person_refs_has_login.sql',
  '20260905110000_phase35c_notes_journey_person.sql',
  '20260906100000_phase35d_small_readers_person.sql',
  '20261001100000_is_cycle_member_guest_safe_lockdown.sql',
];

/**
 * Ambient schema the above files assume. Deliberately minimal: enough columns for the real
 * statements to compile and for the ABC-16 predicates to be exercised honestly.
 *
 * `authenticated` / `anon` / `service_role` are created because the real files GRANT and
 * REVOKE against them, and because H0's install assertions read the resulting ACL.
 */
export const STUB_SQL = /* sql */ `
  DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE service_role BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

  -- The platform grants clients broad table privileges by default; reproducing that is what
  -- makes H0's REVOKE meaningful instead of vacuous.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

  -- Supabase also grants EXECUTE on new FUNCTIONS to the three client roles. Without this the
  -- fixture only carried PostgreSQL's PUBLIC default, so a function the chain never granted
  -- explicitly looked "not callable by service_role" when on the real platform it is. Every
  -- ABC-18 assertion about a definer RPC being unreachable depends on reproducing this — it is
  -- exactly the gap that let collapse_guest_person_into look contained when it was not.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE TABLE IF NOT EXISTS auth.users (
    id uuid PRIMARY KEY,
    email text,
    last_sign_in_at timestamptz,
    email_confirmed_at timestamptz
  );

  -- auth.uid() is a settable stub: tests switch identity with set_config('abc16.uid', ...).
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
    SELECT NULLIF(current_setting('abc16.uid', true), '')::uuid
  $fn$;

  -- Supabase grants client roles USAGE on the auth schema. WITHOUT this, auth.uid() raises
  -- "permission denied for schema auth" inside every policy expression evaluated as
  -- the authenticated role, and an RLS predicate that errors yields no rows, so a test would
  -- report "correctly denied" when the truth is "the fixture is broken". Every assertion in
  -- these suites that runs under SET ROLE depends on this line being present.
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  GRANT SELECT ON auth.users TO service_role;

  CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger
  LANGUAGE plpgsql AS $fn$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $fn$;

  -- The full account mirror. Every column here is one that mint_person_for_profile copies into
  -- persons; the fixture must carry them all, or the "did the mirror survive?" assertion cannot
  -- be written at all.
  CREATE TABLE IF NOT EXISTS public.profiles (
    id uuid PRIMARY KEY, user_id uuid, full_name text, email text, phone text,
    first_name text, last_name text, birth_date date, skill_rating numeric,
    rating_system text, rating_member_id text, avatar_url text, bio text, location text,
    preferred_language text, billing_business_name text, billing_address text,
    billing_btw_number text, stripe_customer_id text,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS public.academy_profiles (id uuid PRIMARY KEY, name text, slug text);
  CREATE TABLE IF NOT EXISTS public.academy_managers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    academy_profile_id uuid NOT NULL, user_id uuid NOT NULL, role text DEFAULT 'manager'
  );
  CREATE TABLE IF NOT EXISTS public.trainer_profiles (
    id uuid PRIMARY KEY, user_id uuid, is_public boolean DEFAULT false
  );
  -- Ambient tables profiles_public joins for its retained club/trainer arms.
  CREATE TABLE IF NOT EXISTS public.trainer_locations (trainer_id uuid, location_id uuid);
  CREATE TABLE IF NOT EXISTS public.club_profiles (id uuid PRIMARY KEY, location_id uuid);
  CREATE TABLE IF NOT EXISTS public.club_managers (club_profile_id uuid, user_id uuid);
  CREATE TABLE IF NOT EXISTS public.academy_trainers (
    academy_profile_id uuid, trainer_profile_id uuid, status text
  );
  CREATE TABLE IF NOT EXISTS public.guest_players (
    id uuid PRIMARY KEY, full_name text, first_name text, last_name text,
    email text DEFAULT '', phone text,
    -- academy_profile_id is NOT declared here: 20260224171306 adds it with a bare ADD COLUMN,
    -- which errors if the stub already has it. The shipped migration owns that column.
    trainer_id uuid, linked_profile_id uuid, twin_of_profile_id uuid,
    birth_date date, skill_rating numeric, rating_system text, notes text, source text,
    has_trained boolean, billing_business_name text, billing_address text, billing_btw_number text,
    created_at timestamptz DEFAULT now()
  );
  -- guest_players carries RLS in production (20260116200114 onwards); the ABC-16 guest-PII
  -- assertions are about a POLICY, so the stub must enable it or those tests would pass
  -- because RLS was off rather than because the policy closed.
  ALTER TABLE public.guest_players ENABLE ROW LEVEL SECURITY;

  CREATE TABLE IF NOT EXISTS public.locations (id uuid PRIMARY KEY, name text, merged_into uuid);
  CREATE TABLE IF NOT EXISTS public.academy_locations (
    academy_profile_id uuid, location_id uuid, is_active boolean DEFAULT true
  );
  CREATE TABLE IF NOT EXISTS public.availability_slots (
    id uuid PRIMARY KEY, academy_profile_id uuid, trainer_id uuid, location_id uuid,
    cyclus_id uuid, source_cycle_id uuid, start_time timestamptz DEFAULT now(),
    end_time timestamptz,
    -- columns the claim-by-token payload projects (their own migrations own them upstream)
    cyclus_name text, price_per_session numeric, total_price numeric,
    max_participants integer, priority_window_ends_at timestamptz
  );
  ALTER TABLE public.availability_slots ADD COLUMN IF NOT EXISTS booking_tier text;
  CREATE TABLE IF NOT EXISTS public.bookings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid,
    guest_player_id uuid, player_id uuid,
    paid_by_player_id uuid, paid_by_guest_player_id uuid,
    status text, created_at timestamptz DEFAULT now()
  );
  -- ABC-17 turns on whether an academy manager can REASSIGN a booking's subject under the real
  -- UPDATE policy (20260704120000, applied from its shipped file). With RLS off, the
  -- reassignment test would prove nothing about the policy.
  ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
  CREATE TABLE IF NOT EXISTS public.invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), player_id uuid, guest_player_id uuid,
    trainer_id uuid, academy_profile_id uuid
  );
  CREATE TABLE IF NOT EXISTS public.intake_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), player_id uuid, guest_player_id uuid, status text
  );
  -- RLS + the shipped player/slot-owner policies live in 20260506080606; that migration also
  -- creates the table, so the stub below is guarded and the policies are added here instead of
  -- pulling in an early, unrelated chain.
  CREATE TABLE IF NOT EXISTS public.slot_priority_claims (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid,
    guest_player_id uuid, booked_by_player_id uuid, booked_by_guest_player_id uuid,
    booked_by_profile_id uuid
  );
  -- session_reports is ambient for the attendance surface; session_player_notes comes from its
  -- own shipped migration so the real policies are exercised.
  CREATE TABLE IF NOT EXISTS public.session_reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, reporter_role text,
    reporter_id uuid, session_happened boolean, public_notes text, notes text,
    attendees jsonb, created_at timestamptz DEFAULT now()
  );
  ALTER TABLE public.session_reports ENABLE ROW LEVEL SECURITY;
  -- seen-markers for shared coaching notes (its own migration owns this upstream).
  CREATE TABLE IF NOT EXISTS public.coaching_note_views (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), note_id uuid, profile_id uuid,
    viewed_at timestamptz DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS public.player_rating_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), player_id uuid, rating numeric,
    rating_system text, created_at timestamptz DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS public.email_campaign_templates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), academy_profile_id uuid, name text
  );
  CREATE TABLE IF NOT EXISTS public.email_campaigns (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), academy_profile_id uuid, name text
  );
  CREATE TABLE IF NOT EXISTS public.cycles (
    id uuid PRIMARY KEY, settings jsonb DEFAULT '{}'::jsonb, owner_type text, owner_id uuid,
    type text, location_id uuid
  );
  -- Touched by link_guest_data_to_profile when it re-keys a claimed guest's rows.
  CREATE TABLE IF NOT EXISTS public.club_players (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid, player_id uuid, guest_player_id uuid
  );

  -- Helper predicates other migrations own. Same shape as production; the ABC-16 suites never
  -- assert ON these, they assert on what H0 does given them.
  CREATE OR REPLACE FUNCTION public.get_user_academy_ids(_user_id uuid)
  RETURNS SETOF uuid LANGUAGE sql STABLE AS $fn$
    SELECT academy_profile_id FROM public.academy_managers WHERE user_id = _user_id
  $fn$;

  CREATE OR REPLACE FUNCTION public.is_academy_manager(_user_id uuid, _academy_profile_id uuid)
  RETURNS boolean LANGUAGE sql STABLE AS $fn$
    SELECT EXISTS (
      SELECT 1 FROM public.academy_managers
      WHERE user_id = _user_id AND academy_profile_id = _academy_profile_id
    )
  $fn$;

  CREATE OR REPLACE FUNCTION public.is_admin(_user_id uuid)
  RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT false $fn$;

  CREATE OR REPLACE FUNCTION public.is_guest_split_frozen(_guest_id uuid)
  RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT false $fn$;

  CREATE OR REPLACE FUNCTION public.get_profile_id_for_user(_user_id uuid)
  RETURNS uuid LANGUAGE sql STABLE AS $fn$
    SELECT id FROM public.profiles WHERE user_id = _user_id LIMIT 1
  $fn$;

  -- Ambient person helper used by the attendance surface (its own migration owns it upstream).
  -- plpgsql, not sql: a SQL body is parsed at CREATE time and person_links does not exist yet
  -- (persons_expand creates it later in the chain). plpgsql resolves at call time.
  CREATE OR REPLACE FUNCTION public.get_my_person_id()
  RETURNS uuid LANGUAGE plpgsql STABLE AS $fn$
  DECLARE v uuid;
  BEGIN
    SELECT pl.person_id INTO v FROM public.person_links pl
    JOIN public.profiles p ON p.id = pl.profile_id
    WHERE p.user_id = auth.uid() LIMIT 1;
    RETURN v;
  END;
  $fn$;

  CREATE OR REPLACE FUNCTION public.get_user_club_ids(_user_id uuid)
  RETURNS SETOF uuid LANGUAGE sql STABLE AS $fn$
    SELECT club_profile_id FROM public.club_managers WHERE user_id = _user_id
  $fn$;

  CREATE OR REPLACE FUNCTION public.is_cycle_member(_user_id uuid, _cycle_id uuid)
  RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT false $fn$;

  -- Referenced by 20260826240000 (which the chain needs only for the repurpose trigger).
  CREATE OR REPLACE FUNCTION public.can_current_user_book_member_window(_cycle_id uuid)
  RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT false $fn$;

  -- Tier helpers can_book_slot calls. Their own chain is unrelated to A3; these reproduce the
  -- shape it depends on (tier from the slot column, cutoff off by default).
  CREATE OR REPLACE FUNCTION public.resolve_slot_booking_tier(_slot_id uuid)
  RETURNS text LANGUAGE plpgsql STABLE AS $fn$
  DECLARE v text;
  BEGIN
    SELECT coalesce(booking_tier, 'public') INTO v FROM public.availability_slots WHERE id = _slot_id;
    RETURN coalesce(v, 'public');
  END; $fn$;

  CREATE OR REPLACE FUNCTION public.is_slot_within_player_booking_cutoff(_slot_id uuid)
  RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT false $fn$;

  -- Search folding used by get_players_overview. Same contract as production (case/diacritic
  -- folding); the ABC suites assert scope, not collation subtleties.
  CREATE OR REPLACE FUNCTION public.fold_search_text(_t text)
  RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT lower(coalesce(_t, '')) $fn$;

  -- The billing columns the restored overdue predicate reads: past-due AND unpaid AND
  -- non-terminal, not merely status = 'overdue'.
  ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS status text;
  -- ABC-20 keys its two partial indexes on this column (20260705130000 owns it upstream).
  ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS rebook_cyclus_id uuid;
  -- resume-payment columns the token boundary reads (their own migrations own them upstream)
  ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS rebook_group_id uuid;
  ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS public_token text;
  ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS public_token_revoked_at timestamptz;
  ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
  -- the profile-first index ABC-20 replaces, so the swap is exercised rather than assumed
  CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_rebook_cyclus_claimant
    ON public.invoices (rebook_cyclus_id, COALESCE(player_id, guest_player_id))
    WHERE rebook_cyclus_id IS NOT NULL AND status <> 'cancelled';
  ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS booking_ids uuid[];
  -- A3 reads these on the claim/slot side; the shipped migrations own them upstream.
  ALTER TABLE public.slot_priority_claims ADD COLUMN IF NOT EXISTS status text DEFAULT 'pending';
  ALTER TABLE public.slot_priority_claims ADD COLUMN IF NOT EXISTS claim_token text;
  ALTER TABLE public.slot_priority_claims ADD COLUMN IF NOT EXISTS rebook_group_id uuid;
  ALTER TABLE public.availability_slots ADD COLUMN IF NOT EXISTS cyclus_name text;
  ALTER TABLE public.availability_slots ADD COLUMN IF NOT EXISTS price_per_session numeric;
  ALTER TABLE public.availability_slots ADD COLUMN IF NOT EXISTS priority_window_ends_at timestamptz;
  -- enforce_booking_slot_tier (installed by the member-window chain) fires on every booking
  -- write and reads these; without them the trigger raises and unrelated tests fail.
  ALTER TABLE public.availability_slots ADD COLUMN IF NOT EXISTS hold_expires_at timestamptz;
  ALTER TABLE public.availability_slots ADD COLUMN IF NOT EXISTS booking_tier text;
  ALTER TABLE public.availability_slots ADD COLUMN IF NOT EXISTS released_at timestamptz;
  ALTER TABLE public.availability_slots ADD COLUMN IF NOT EXISTS max_players integer;
  ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS payment_status text;
  ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS paid_externally boolean;
  ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS notes text;
  -- the capacity/tier trigger counts held seats on BOOKINGS, not on slots
  ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS hold_expires_at timestamptz;
  ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS due_date date;
  ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS paid_at timestamptz;

  -- Ambient bookings SELECT scope. Production has several (20260115210247 onwards); this
  -- reproduces the academy-manager one, scoped exactly like the shipped UPDATE policy.
  --
  -- It is REQUIRED for the ABC-17 probe to mean anything: with RLS enabled and no SELECT
  -- policy, an UPDATE ... WHERE cannot find its rows at all, so a reassignment attempt reports
  -- "0 rows changed" and would read as "correctly refused" no matter what the guard does.
  -- Defined last because it calls get_user_academy_ids, declared just above.
  -- The shipped slot_priority_claims policies (20260506080606). Reproduced here rather than
  -- applying that early migration, which creates unrelated rebook scaffolding. The PLAYER one is
  -- the pre-correction shape on purpose: the containment re-emits it, and starting from the
  -- narrowed form would make the correction untestable.
  ALTER TABLE public.slot_priority_claims ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "Players read own priority claims"
    ON public.slot_priority_claims FOR SELECT TO authenticated
    USING (player_id = public.get_profile_id_for_user(auth.uid()));
  CREATE POLICY "Slot owners manage priority claims"
    ON public.slot_priority_claims FOR ALL TO authenticated
    USING (EXISTS (
      SELECT 1 FROM public.availability_slots s
      WHERE s.id = slot_priority_claims.slot_id
        AND (s.academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid()))
          OR s.trainer_id IN (SELECT tp.id FROM public.trainer_profiles tp WHERE tp.user_id = auth.uid()))
    ));

  CREATE POLICY "abc16 fixture: academy managers read bookings on their slots"
    ON public.bookings FOR SELECT TO authenticated
    USING (EXISTS (
      SELECT 1 FROM public.availability_slots s
      WHERE s.id = bookings.slot_id
        AND s.academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid()))
    ));
`;

/**
 * Extract one shipped `CREATE OR REPLACE FUNCTION` block verbatim from a migration file.
 *
 * `link_guest_data_to_profile` lives in 20260611220000, a broad migration that also rewrites
 * club tables this fixture has no reason to model. Applying the whole file would drag in
 * unrelated schema; hand-copying the function would test a copy instead of the shipped code.
 * This takes the real bytes and nothing else — the function under containment is exercised as
 * written, and the ambient noise stays out.
 */
export function extractFunction(file: string, name: string): string {
  const sql = MIGRATION(file);
  // BOTH forms: some shipped migrations use a bare `CREATE FUNCTION`. Matching only
  // `CREATE OR REPLACE` returned -1, and slicing from -1 silently produced a fragment that
  // applied without error while defining nothing — the failure then surfaced much later as a
  // return-type conflict. Throw instead of guessing.
  const start = [
    `CREATE OR REPLACE FUNCTION public.${name}`,
    `CREATE FUNCTION public.${name}`,
  ].map((needle) => sql.indexOf(needle)).find((i) => i >= 0);
  if (start === undefined) throw new Error(`extractFunction: ${name} not found in ${file}`);
  const end = sql.indexOf('$$;', start);
  if (end < 0) throw new Error(`extractFunction: unterminated body for ${name} in ${file}`);
  // A bare CREATE FUNCTION cannot replace an existing one, and the chain may already have an
  // older overload, so drop first.
  return `DROP FUNCTION IF EXISTS public.${name}(uuid);\n${sql.slice(start, end + 3)}`;
}

/** The shipped bridge minter, needed so the containment's REVOKE has a real target. */
export const BRIDGE_MINTER_SQL = () =>
  extractFunction('20260611220000_relax_guest_email_uniqueness.sql', 'link_guest_data_to_profile');

/**
 * `guest_verified_account_profile` — the person_links -> twin -> linked resolver that
 * `is_cycle_member` and `can_book_member_window` used before A3 withdrew those arms. Its own
 * migration (20260927100000) also rewrites unrelated rebook schema, so the shipped function is
 * taken on its own: the A3 suite needs the PRE-state resolver to exist in order to prove the
 * arms that consumed it are gone.
 */
export const GUEST_VERIFIED_RESOLVER_SQL = () =>
  extractFunction('20260927100000_rebook_identity_guest_first.sql', 'guest_verified_account_profile');

/**
 * The effective 3-column `get_cycle_roster_names` (id, full_name, has_login). Its migration
 * also re-emits `get_academy_cyclus_groups`, which belongs to an unrelated chain this fixture
 * has no reason to model — so the roster function is taken on its own. Without it the fixture
 * carries the older 2-column version and the A1 re-emission cannot even be created.
 */
export const ROSTER_HAS_LOGIN_SQL = () =>
  extractFunction('20260828100000_phase33a_roster_haslogin.sql', 'get_cycle_roster_names');

/** Apply the stubs, then every pre-H0 migration in chain order. */
export async function applyPreH0(exec: (sql: string) => Promise<unknown>): Promise<void> {
  await exec(STUB_SQL);
  for (const file of PRE_H0_MIGRATIONS) {
    await exec(MIGRATION(file));
    // The extracted helpers land at their real chain position: after person_links exists (their
    // bodies reference it, and a SQL body is parsed at CREATE time) AND after 20260826290000,
    // which re-emits a 2-column get_cycle_roster_names that would otherwise overwrite the
    // effective 3-column one. Appending them at the very end instead would fail for the
    // consumers applied earlier in the chain.
    if (file.startsWith('20260826290000')) {
      await exec(BRIDGE_MINTER_SQL());
      await exec(GUEST_VERIFIED_RESOLVER_SQL());
      await exec(ROSTER_HAS_LOGIN_SQL());
    }
  }
}

/** Apply the H0 migration under test. */
export async function applyH0(exec: (sql: string) => Promise<unknown>): Promise<void> {
  await exec(MIGRATION(H0_MIGRATION));
}

// ── identifiers shared by both suites ─────────────────────────────────────────────────────

export const IDS = {
  /** The ATTACKER: an authenticated user who created their own academy and manages it. */
  attackerUser: '50000000-0000-0000-0000-0000000000a1',
  attackerAcademy: '40000000-0000-0000-0000-0000000000a1',

  /** An unrelated, legitimate academy the attacker has nothing to do with. */
  victimAcademy: '40000000-0000-0000-0000-0000000000b1',
  victimUser: '50000000-0000-0000-0000-0000000000b1',

  /** A trainer the attacker controls (for the trainer-owned arm). */
  attackerTrainer: '70000000-0000-0000-0000-0000000000a1',

  /** Guests. */
  guestOwnedByAttackerAcademy: '20000000-0000-0000-0000-000000000001',
  guestBookedOnAttackerSlot: '20000000-0000-0000-0000-000000000002',
  guestTargetedByForgedMetadata: '20000000-0000-0000-0000-000000000003',
  guestOwnedByVictimAcademy: '20000000-0000-0000-0000-000000000004',

  /** Registered players. */
  nascentProfile: '10000000-0000-0000-0000-000000000001',
  nascentUser: '60000000-0000-0000-0000-000000000001',
  bookedProfile: '10000000-0000-0000-0000-000000000002',

  /** Slots. */
  attackerSlot: '30000000-0000-0000-0000-0000000000a1',
  victimSlot: '30000000-0000-0000-0000-0000000000b1',

  /** Clubs. */
  attackerLocation: '80000000-0000-0000-0000-0000000000a1',
} as const;

/**
 * The world the attack is staged in.
 *
 * The forged rows are inserted as the OWNER (bypassing RLS) on purpose: they represent rows an
 * attacker minted BEFORE H0, when the FOR ALL policy allowed exactly this. H0 must neither
 * delete them nor honour them.
 */
export const FIXTURE_SQL = /* sql */ `
  INSERT INTO auth.users (id, email, last_sign_in_at, email_confirmed_at) VALUES
    ('${IDS.nascentUser}', 'nascent@example.test', NULL, NULL);

  INSERT INTO public.academy_profiles (id, name, slug) VALUES
    ('${IDS.attackerAcademy}', 'Attacker Academy', 'attacker'),
    ('${IDS.victimAcademy}',   'Victim Academy',   'victim');

  INSERT INTO public.academy_managers (academy_profile_id, user_id, role) VALUES
    ('${IDS.attackerAcademy}', '${IDS.attackerUser}', 'owner'),
    ('${IDS.victimAcademy}',   '${IDS.victimUser}',   'owner');

  INSERT INTO public.trainer_profiles (id, user_id) VALUES
    ('${IDS.attackerTrainer}', '${IDS.attackerUser}');

  INSERT INTO public.profiles (id, user_id, full_name, email) VALUES
    ('${IDS.nascentProfile}', '${IDS.nascentUser}', 'Nascent Player', 'nascent@example.test'),
    ('${IDS.bookedProfile}',  NULL,                  'Booked Player',  'booked@example.test');

  -- THE WRONG-TARGET FK, modelled deliberately.
  --
  -- academy_player_locations.academy_profile_id REFERENCES profiles(id) (20260615110100), while
  -- every authorization path resolves an academy through academy_profiles(id) /
  -- academy_managers.academy_profile_id, and academy_profiles.id is an independent
  -- gen_random_uuid() space (create-academy-profile). So a location row is only insertable when
  -- its academy id ALSO exists in profiles.
  --
  -- This row makes that true for the attacker's academy. Without it the FK alone would reject
  -- every location insert, and the location negative controls below would pass for the wrong
  -- reason — proving a foreign key works, not that H0 withdrew the privilege. H0 does not
  -- repair this FK; the inventory reports it as wrong_target_academy_fk.
  INSERT INTO public.profiles (id, full_name) VALUES
    ('${IDS.attackerAcademy}', 'Attacker Academy (profiles-side row that satisfies the wrong FK)');

  INSERT INTO public.locations (id, name) VALUES ('${IDS.attackerLocation}', 'Attacker Club');
  INSERT INTO public.academy_locations (academy_profile_id, location_id, is_active) VALUES
    ('${IDS.attackerAcademy}', '${IDS.attackerLocation}', true);

  INSERT INTO public.availability_slots (id, academy_profile_id, trainer_id) VALUES
    ('${IDS.attackerSlot}', '${IDS.attackerAcademy}', '${IDS.attackerTrainer}'),
    ('${IDS.victimSlot}',   '${IDS.victimAcademy}',   NULL);

  -- (a) a guest the attacker's academy genuinely owns — must stay visible
  INSERT INTO public.guest_players (id, full_name, academy_profile_id) VALUES
    ('${IDS.guestOwnedByAttackerAcademy}', 'Own Guest', '${IDS.attackerAcademy}');

  -- (b) a TRAINER-owned guest with a real booking on the attacker's academy slot. Owned by the
  --     trainer rather than ownerless, because 20260224171306 adds guest_players_owner_check
  --     (exactly one of academy_profile_id / trainer_id).
  INSERT INTO public.guest_players (id, full_name, trainer_id) VALUES
    ('${IDS.guestBookedOnAttackerSlot}', 'Booked Guest', '${IDS.attackerTrainer}');
  INSERT INTO public.bookings (slot_id, guest_player_id, status) VALUES
    ('${IDS.attackerSlot}', '${IDS.guestBookedOnAttackerSlot}', 'confirmed');

  -- (c) THE ATTACK: a guest of the victim academy, with a forged metadata row pointing at the
  --     attacker's academy and nothing else connecting them.
  INSERT INTO public.guest_players (id, full_name, email, phone, academy_profile_id) VALUES
    ('${IDS.guestTargetedByForgedMetadata}', 'Victim Guest', 'victim-guest@example.test', '0600000000', '${IDS.victimAcademy}');
  INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id, notes) VALUES
    ('${IDS.attackerAcademy}', '${IDS.guestTargetedByForgedMetadata}', 'forged');

  -- a guest of the victim academy with NO forged row — the baseline negative control
  INSERT INTO public.guest_players (id, full_name, academy_profile_id) VALUES
    ('${IDS.guestOwnedByVictimAcademy}', 'Other Victim Guest', '${IDS.victimAcademy}');

  -- THE ATTACK, registered arm: a forged metadata row claiming the nascent account.
  INSERT INTO public.academy_player_metadata (academy_profile_id, profile_id, notes) VALUES
    ('${IDS.attackerAcademy}', '${IDS.nascentProfile}', 'forged');

  -- a location-only claim on the same nascent account
  INSERT INTO public.academy_player_locations (academy_profile_id, profile_id, location_id, dismissed) VALUES
    ('${IDS.attackerAcademy}', '${IDS.nascentProfile}', '${IDS.attackerLocation}', false);

  -- a legitimately booked registered player at the attacker's academy (positive control)
  INSERT INTO public.bookings (slot_id, player_id, status) VALUES
    ('${IDS.attackerSlot}', '${IDS.bookedProfile}', 'confirmed');
`;
