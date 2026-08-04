-- 10c-b J — THE REVERSE PREFERENCE BRIDGE (v2 -> v1), and the recursion guard that makes a
-- two-way bridge safe.
--
-- ===========================================================================================
-- WHY THIS EXISTS — the mixed-version gap the one-way bridge cannot close
--
-- 20261011100000 §5b installed a ONE-WAY mirror: a legacy write to
-- notification_preferences.open_slots_digest is carried FORWARD into
-- notification_preferences_v2('open_slots_player'). That closes the direction in which a CACHED
-- pre-cutover settings bundle keeps writing v1 after the control has gone from the page.
--
-- It does not close the other direction, and that direction is not hypothetical — the 10c-b
-- runbook MANUFACTURES it on purpose. ADR 0008 ("10c-b D — the notify-followers cutover: deploy
-- ORDER is part of the design") requires: migrations -> FRONTEND -> wait out the browser
-- bundle-cache window -> edge function. The frontend deploys itself on merge; edge functions are
-- deployed by hand afterwards. So there is a deliberately-observed window in which:
--
--   * the NEW settings page is live, and it no longer carries an `open_slots_digest` control at
--     all (removed from LEGACY_PLAYER in NotificationSettings.tsx) — a player changing their
--     open-slots cadence therefore writes ONLY notification_preferences_v2;
--   * the OLD notify-followers bundle is STILL live, and it still POSTs send-email with
--     new_availability / slot_reopened;
--   * send-email — untouched by this PR — maps both onto the v1 column open_slots_digest and
--     ENFORCES it (`off` suppresses, `daily`/`weekly` queue into notification_queue).
--
-- Net effect without this migration: a player opens the new page, sets open slots to OFF, sees
-- "Saved", and keeps receiving open-slot mail until the owner deploys the edge function. That is
-- a consent violation with a UI that reports success — precisely the failure the forward bridge
-- was built to prevent, running in the other direction.
--
-- (Precision, because it is easy to get wrong when reading the cutover: notify-followers itself
-- never read open_slots_digest. Its own filter read notification_preferences.email_new_availability,
-- a column DROPPED in 20260210090026 whose error was discarded, so that filter was silently inert.
-- The live v1 reader inside the window is send-email, reached THROUGH the old notify-followers.)
--
-- ===========================================================================================
-- WHAT THIS MIGRATION DOES
--
--   1. adds a re-entrancy guard shared by both directions, so a two-way bridge cannot ping-pong;
--   2. re-creates the forward (v1 -> v2) trigger function to honour that guard — its behaviour is
--      otherwise UNCHANGED, and every rule 20261011100000 §5b established still holds;
--   3. adds the reverse (v2 -> v1) trigger.
--
-- This is a COMPATIBILITY SHIM with a defined end. See "RETIREMENT" at the foot of this file.

-- ===========================================================================================
-- 1. THE RE-ENTRANCY GUARD.
--
-- With two mirrors installed, every write to either table fires a write to the other, which
-- fires a write back. Postgres does NOT detect this: it recurses until it exhausts the stack.
--
-- It is tempting to rely on VALUE CONVERGENCE instead — write only when the target actually
-- differs, so the bounce dies out after one hop. Note carefully WHICH direction does that: the
-- REVERSE (v2 -> v1) upserts are distinct-only; the FORWARD (v1 -> v2) ones update
-- UNCONDITIONALLY, because that body is carried over from the reviewed 20261011100000 unchanged
-- and its `DO UPDATE` also stamps `updated_at`. So the redundancy is one-sided, and the guard is
-- the only thing standing between the forward mirror and a real second write — which is precisely
-- what the "recursion guard removed" mutation pin observes.
--
-- Convergence must not be the ONLY protection in any case:
--   * it costs a full extra round trip and an extra row lock on every single save;
--   * it is silent — nothing fails if a future edit makes the two directions disagree about what
--     the converged value should be, and the two directions ALREADY disagree by design about the
--     ambiguous-INSERT cases (see §3), so the argument that they always converge is not one that
--     stays true by construction.
--
-- pg_trigger_depth() was considered and REJECTED: it suppresses the bridge whenever the write
-- arrives from ANY trigger, including some future unrelated one, and it fails OPEN — the mirror
-- silently stops and a preference stops propagating with nothing to notice it. The guard has to
-- name THIS bridge, not "any nesting".
--
-- So: a transaction-local GUC, set only around a bridge's own nested write. VOLATILE, never
-- STABLE — a STABLE function may be folded within a statement, and the whole point is that this
-- value changes underneath one.
CREATE OR REPLACE FUNCTION public.notif_pref_bridge_hop_active()
RETURNS boolean
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog
AS $$
  -- COALESCE is a parser construct, not a function: it takes no schema qualification and cannot
  -- be shadowed. current_setting IS a function, so it carries one — and this function's own
  -- search_path is pg_catalog, which is what keeps the `=` resolution honest too.
  SELECT COALESCE(
           pg_catalog.current_setting('notif.pref_bridge_hop', true) OPERATOR(pg_catalog.=) 'on',
           false)
$$;

COMMENT ON FUNCTION public.notif_pref_bridge_hop_active() IS
  'True while a notification-preference bridge hop is in progress in THIS transaction. Both mirror triggers (v1 -> v2 and v2 -> v1) return immediately when it is true, so the pair cannot recurse. Transaction-local: set with set_config(..., is_local => true) around the nested write only, and reverted by COMMIT, ROLLBACK or any subtransaction abort. Retire with the bridge.';

-- ===========================================================================
-- 1b. THE VALUES THE PLATFORM CAN SUPPLY WITHOUT THE USER CHOOSING THEM.
--
-- The reverse INSERT rule turns on this set, so it is defined once rather than restated at each
-- use, and it is DERIVED rather than hard-coded — a literal would silently invert the rule the
-- day either default moved.
--
-- There are exactly two such sources, and getting this list wrong in either direction is a
-- consent bug:
--
--   * the CATALOG default (notification_event_types.default_email_frequency). NotificationSettings
--     `saveEvent()` always writes BOTH channel columns, computing the one the user did not touch
--     from `effective()`, which falls back to this value. So a save that touches only the OTHER
--     channel carries an email cadence nobody chose.
--
--     TODAY THIS ARM IS FORWARD-LOOKING, NOT LIVE, and saying otherwise would be wrong:
--     `open_slots_player` ships `supports_whatsapp = false` (20261008100000), and the page renders
--     the WhatsApp switch only for events that support it (NotificationSettings.tsx), so there is
--     currently no way to save this event without touching email. It is kept because Stage 8 turns
--     WhatsApp on, and the rule must already be right when it does.
--
--   * the v2 COLUMN default ('instant', 20260910100000). notification_preferences_v2 is granted
--     INSERT to `authenticated` with an own-rows RLS policy, so a row can be created through the
--     table API without naming email_frequency at all, and the column default then applies. THIS
--     arm is live today. Without it an incidental 'instant' would be treated as an explicit choice
--     and would overwrite a legacy 'off'.
--
-- An empty result is the correct fail-safe: if neither default can be determined then nothing is
-- platform-supplied, and every value is a genuine choice.
CREATE OR REPLACE FUNCTION public.notif_pref_open_slots_incidental_values()
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $fn$
  SELECT ARRAY(
    SELECT v FROM (
      SELECT (SELECT t.default_email_frequency
                FROM public.notification_event_types t
               WHERE t.key = 'open_slots_player') AS v
      UNION
      SELECT (SELECT (pg_catalog.regexp_match(
                        pg_catalog.pg_get_expr(d.adbin, d.adrelid), $re$^'([a-z]+)'$re$))[1]
                FROM pg_catalog.pg_attrdef d
                JOIN pg_catalog.pg_attribute a
                  ON a.attrelid = d.adrelid AND a.attnum = d.adnum
               WHERE d.adrelid = 'public.notification_preferences_v2'::pg_catalog.regclass
                 AND a.attname = 'email_frequency')
    ) s
    WHERE v IS NOT NULL
      -- 'off' is NEVER incidental, whatever the defaults happen to be.
      --
      -- Not because it cannot currently BE a default — it can: both CHECK constraints permit it,
      -- and a future catalog edit could set default_email_frequency = 'off'. The reason is that the
      -- rule's whole purpose is asymmetric. Seeding-only exists to stop an unchosen value from
      -- RESUMING mail; suppressing mail is safe whether the user chose it or inherited it. Leaving
      -- 'off' in the set would invert that: the day the catalog default became 'off', an explicit
      -- opt-out would stop overwriting a legacy 'instant' and the legacy reader would keep mailing
      -- someone who had just opted out — the exact failure this file was written to prevent,
      -- reintroduced by a one-word change somewhere else.
      --
      -- So the guarantee "an opt-out ALWAYS applies" is made structural here rather than left as an
      -- observation about today's configuration.
      AND v <> 'off')
$fn$;

COMMENT ON FUNCTION public.notif_pref_open_slots_incidental_values() IS
  'The open_slots_player email cadences the platform can supply on its own: the catalog default (via the settings page effective() fallback) and the notification_preferences_v2.email_frequency COLUMN default (via a partial insert through the table API). The reverse bridge only SEEDS these on INSERT, so an incidental value can never overwrite an explicit legacy opt-out. Derived, not hard-coded. Retire with the bridge.';

-- ===========================================================================
-- 1c. HARDEN THE LEGACY VALIDATION TRIGGER THAT THE REVERSE BRIDGE NOW INVOKES.
--
-- Writing v1 from a SECURITY DEFINER function means validate_notification_frequency() — a trigger
-- this migration does not own — now runs with the definer's privileges. Its body is
-- `EXECUTE format('SELECT ($1).%I', col)` under `SET search_path TO 'public'`, i.e. an unqualified
-- call to a function whose schema is first on the path, inside a dynamic EXECUTE. Slice I measured
-- on a real server that an exact-arity overload beats pg_catalog's own, so a `public.format(text,
-- text)` would capture that call.
--
-- MEASURED, because the earlier draft of this file asserted the opposite and was wrong: on this
-- project NO application role can create it. `pg_namespace.nspacl` for `public` grants USAGE to
-- anon/authenticated/service_role and CREATE only to pg_database_owner, so
-- has_schema_privilege('authenticated','public','CREATE') is FALSE. The path is therefore not
-- reachable by an authenticated user today; it is closed here because this migration is what makes
-- it privileged at all, and because "not currently grantable" is a weaker guarantee than "cannot be
-- captured".
--
-- The body is otherwise unchanged from 20260210090026 — same column list, same message, same
-- semantics. SECURITY INVOKER is deliberately NOT used for the bridge instead: `authenticated` is
-- not granted DML on notification_preferences by any migration in this repo, so an invoker-rights
-- bridge would turn a preference save into a hard error rather than a mirrored write.
CREATE OR REPLACE FUNCTION public.validate_notification_frequency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  col text;
  val text;
  freq_columns text[] := ARRAY[
    'booking_confirmation', 'booking_reminder', 'open_slots_digest',
    'upcoming_sessions_digest', 'payment_receipt', 'waitlist_update',
    'new_booking', 'booking_cancelled', 'new_follower', 'new_player',
    'new_registration', 'new_review', 'upcoming_schedule_digest', 'payment_received'
  ];
BEGIN
  FOREACH col IN ARRAY freq_columns LOOP
    EXECUTE pg_catalog.format('SELECT ($1).%I', col) INTO val USING NEW;
    IF val IS NOT NULL AND val NOT IN ('instant', 'daily', 'weekly', 'off') THEN
      RAISE EXCEPTION 'Invalid frequency value "%" for column "%". Must be instant, daily, weekly, or off.', val, col;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

-- ===========================================================================================
-- 2. FORWARD DIRECTION (v1 -> v2), re-created to honour the guard.
--
-- Every rule below is carried over from 20261011100000 §5b UNCHANGED and is still pinned by
-- openSlotsResolverDigest.realpg.test.ts. Only three things differ:
--   * it returns immediately when a bridge hop is already in progress;
--   * it sets/clears the guard around its own nested write;
--   * search_path is pg_catalog rather than public, and now() is qualified. This function is
--     SECURITY DEFINER, and 10c-b I established on a real server that an exact-arity overload in
--     a schema on the path beats pg_catalog's own — with `search_path = public` and CREATE not
--     revoked on public, a rival public.now() would be resolved here. Every other name in this
--     body was already schema-qualified; now() was the one that was not.
CREATE OR REPLACE FUNCTION public.notif_mirror_open_slots_pref_to_v2()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
  -- RECURSION GUARD. A v2 -> v1 hop is already carrying this user's choice; re-mirroring it
  -- forward would bounce it straight back.
  IF public.notif_pref_bridge_hop_active() THEN RETURN NEW; END IF;

  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
  -- Only the four cadences v2 understands; anything else is ignored rather than coerced into a
  -- sending cadence (same rule as the backfill).
  IF NEW.open_slots_digest IS NULL OR NEW.open_slots_digest NOT IN ('off','instant','daily','weekly') THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = NEW.user_id) THEN RETURN NEW; END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Only an actual CHANGE to this column is a user action. An unrelated UPDATE must not
    -- resurrect a stale cadence over a newer v2 choice.
    IF NEW.open_slots_digest IS NOT DISTINCT FROM OLD.open_slots_digest THEN
      RETURN NEW;
    END IF;
    PERFORM pg_catalog.set_config('notif.pref_bridge_hop', 'on', true);
    INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency)
    VALUES (NEW.user_id, 'open_slots_player', NEW.open_slots_digest)
    ON CONFLICT (user_id, event_type)
    DO UPDATE SET email_frequency = EXCLUDED.email_frequency, updated_at = pg_catalog.now();
    PERFORM pg_catalog.set_config('notif.pref_bridge_hop', 'off', true);
    RETURN NEW;
  END IF;

  -- INSERT is DIFFERENT, and it can go wrong in BOTH directions.
  --
  -- The settings page upserts a PARTIAL row when the user changes any OTHER legacy control, and
  -- open_slots_digest then takes its column DEFAULT of 'weekly' (20260210090026:13). That is not
  -- a choice about open slots at all: mirroring it with DO UPDATE would overwrite an explicit v2
  -- 'off' with 'weekly' and start mailing someone who had opted out.
  --
  -- But blanket DO NOTHING loses the opposite case. A user can hold a v2 row and NO v1 row at
  -- all — the v2 settings page creates rows directly, and the one-time backfill only creates a
  -- v2 row where a v1 row already existed. A cached page's genuine opt-out then arrives as an
  -- INSERT (no v1 row to update), and DO NOTHING would discard it: the UI reports success while
  -- delivery keeps mailing. That is the very failure this bridge exists to prevent.
  --
  -- The two cases are distinguishable, and only by the VALUE: 'weekly' is exactly the column
  -- default, so an inserted 'weekly' is ambiguous and is treated as the incidental default;
  -- 'off' / 'instant' / 'daily' cannot be produced by the default and are therefore a real
  -- choice about open slots, which applies.
  --
  -- THE RESIDUAL, stated accurately. A genuine 'weekly' choice made on a cached page IS lost
  -- when a v2 row already exists, and that is not always "less mail": over an existing 'instant'
  -- or 'daily' it leaves MORE mail than the user asked for. It is kept anyway, because the
  -- alternative is strictly worse in kind rather than in degree — a DO UPDATE here would let the
  -- incidental default overwrite an explicit 'off' and resume mail for someone who had opted
  -- out. A cadence that is wrong is still consented mail; mail after an opt-out is not. So the
  -- rule trades a cadence mismatch for a consent violation, deliberately, and only for the
  -- lifetime of the cached bundle. (The realpg suite pins the column default AND both conflict
  -- outcomes, so neither this reasoning nor its behaviour can silently rot.)
  PERFORM pg_catalog.set_config('notif.pref_bridge_hop', 'on', true);
  IF NEW.open_slots_digest = 'weekly' THEN
    INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency)
    VALUES (NEW.user_id, 'open_slots_player', NEW.open_slots_digest)
    ON CONFLICT (user_id, event_type) DO NOTHING;
  ELSE
    INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency)
    VALUES (NEW.user_id, 'open_slots_player', NEW.open_slots_digest)
    ON CONFLICT (user_id, event_type)
    DO UPDATE SET email_frequency = EXCLUDED.email_frequency, updated_at = pg_catalog.now();
  END IF;
  PERFORM pg_catalog.set_config('notif.pref_bridge_hop', 'off', true);
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.notif_mirror_open_slots_pref_to_v2() IS
  'Cutover bridge (v1 -> v2): mirrors a legacy notification_preferences.open_slots_digest write forward into notification_preferences_v2(open_slots_player), so a CACHED settings bundle cannot silently disagree with delivery. Installed before the one-time backfill so no write falls between the two. Honours notif_pref_bridge_hop_active() so it cannot ping-pong with the reverse bridge. Retire with the v1 column in 10c-d.';

-- The trigger itself is unchanged (AFTER INSERT OR UPDATE OF open_slots_digest); CREATE OR
-- REPLACE FUNCTION above re-points it. It is deliberately NOT dropped and recreated: doing so
-- would take a stronger lock for no behavioural gain.

-- ===========================================================================================
-- 3. REVERSE DIRECTION (v2 -> v1). The new half.
--
-- SCOPE. Exactly one event key (open_slots_player) onto exactly one legacy column
-- (open_slots_digest), email only. v2's whatsapp_frequency / push_frequency have no v1
-- counterpart and are not mirrored. This is narrow by construction, not by convention.
--
-- THE INSERT AMBIGUITY IS MIRROR-IMAGED, NOT ABSENT.
-- The forward direction had to defend against a PARTIAL row: the legacy page upserts one column
-- and the other thirteen take their column DEFAULTs, so an arriving 'weekly' may be nobody's
-- choice. The v2 side has the same hazard, from two sources rather than one, and only on INSERT:
--
--   * v2 UPDATE with a CHANGED email_frequency is ALWAYS an explicit email choice. A save that
--     touches only the other channel re-writes email_frequency with the value it already had,
--     which the no-change short-circuit below drops. Apply unconditionally.
--   * v2 INSERT may carry a value the PLATFORM supplied rather than the user — either the catalog
--     default (via saveEvent()'s effective() fallback) or the v2 COLUMN default (via a partial
--     insert through the granted table API). Mirroring either over an existing v1 'off' with
--     DO UPDATE would resume mail for someone who had opted out — the same consent violation the
--     forward rule refuses, arriving the other way round.
--
-- So INSERT applies the SAME test by value, against BOTH defaults:
-- notif_pref_open_slots_incidental_values() (§1b) is the single derived definition of "a value the
-- platform can produce on its own". A value in that set is ambiguous and only ever SEEDS; any
-- other value could not have been produced without a user choosing it, and therefore applies.
--
-- Note which of the two arms is live TODAY, because the first draft of this file got it backwards:
-- the catalog-default arm is currently unreachable for this event (`supports_whatsapp = false`, and
-- the page renders the WhatsApp switch only where supported, so every save touches email); the
-- COLUMN-default arm is the live one. The catalog arm is kept for Stage 8, which turns WhatsApp on.
--
-- THE RESIDUAL, stated as plainly as the forward one. A first-time v2 insert carrying either
-- default does not push that cadence onto an EXISTING legacy row — v1 keeps what it had. That is a
-- cadence mismatch confined to the deploy window, never a resurrection of mail after an opt-out,
-- and it is narrow in practice: anyone holding a legacy row also holds a v2 row from C's backfill,
-- so their next change is an UPDATE, which applies unconditionally. And `off` is excluded from the
-- incidental set STRUCTURALLY (§1b), not by luck of today's defaults, so an opt-out ALWAYS applies
-- — which is the case the contract actually names.
CREATE OR REPLACE FUNCTION public.notif_mirror_open_slots_pref_to_v1()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  v_incidental text[];
BEGIN
  -- RECURSION GUARD, as above.
  IF public.notif_pref_bridge_hop_active() THEN RETURN NEW; END IF;

  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;

  -- Defence in depth. notification_preferences_v2.email_frequency already carries a CHECK for
  -- exactly this set, so this is unreachable while that CHECK stands. It matters anyway: the v1
  -- table has NO check constraint, only the validate_notification_prefs_frequency trigger, which
  -- RAISES on an unknown cadence. Without this filter, relaxing the v2 CHECK would turn a
  -- preference save into a hard error at the UI instead of a no-op.
  IF NEW.email_frequency IS NULL OR NEW.email_frequency NOT IN ('off','instant','daily','weekly') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Only an actual CHANGE is a user action about EMAIL. A WhatsApp-only save re-writes this
    -- column unchanged and must not be mirrored (it would also cost a pointless row lock on v1).
    IF NEW.email_frequency IS NOT DISTINCT FROM OLD.email_frequency THEN
      RETURN NEW;
    END IF;

    PERFORM pg_catalog.set_config('notif.pref_bridge_hop', 'on', true);
    INSERT INTO public.notification_preferences (user_id, open_slots_digest)
    VALUES (NEW.user_id, NEW.email_frequency)
    ON CONFLICT (user_id)
    DO UPDATE SET open_slots_digest = EXCLUDED.open_slots_digest
    WHERE public.notification_preferences.open_slots_digest IS DISTINCT FROM EXCLUDED.open_slots_digest;
    PERFORM pg_catalog.set_config('notif.pref_bridge_hop', 'off', true);
    RETURN NEW;
  END IF;

  -- INSERT: resolve the ambiguity by value against BOTH platform-suppliable defaults (header, §1b).
  v_incidental := public.notif_pref_open_slots_incidental_values();

  PERFORM pg_catalog.set_config('notif.pref_bridge_hop', 'on', true);
  IF NEW.email_frequency = ANY (v_incidental) THEN
    -- Ambiguous: could be a default rather than a choice. SEED only — this still creates the
    -- legacy row when the user has none, which is what "a first-time v2 insert must reach the
    -- legacy reader" requires; it just never overwrites an existing legacy choice.
    INSERT INTO public.notification_preferences (user_id, open_slots_digest)
    VALUES (NEW.user_id, NEW.email_frequency)
    ON CONFLICT (user_id) DO NOTHING;
  ELSE
    INSERT INTO public.notification_preferences (user_id, open_slots_digest)
    VALUES (NEW.user_id, NEW.email_frequency)
    ON CONFLICT (user_id)
    DO UPDATE SET open_slots_digest = EXCLUDED.open_slots_digest
    WHERE public.notification_preferences.open_slots_digest IS DISTINCT FROM EXCLUDED.open_slots_digest;
  END IF;
  PERFORM pg_catalog.set_config('notif.pref_bridge_hop', 'off', true);
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.notif_mirror_open_slots_pref_to_v1() IS
  'Cutover bridge (v2 -> v1): mirrors notification_preferences_v2(open_slots_player).email_frequency BACK into the legacy notification_preferences.open_slots_digest column, so an opt-out saved on the NEW settings page reaches the still-live legacy send-email reader during the deploy window the 10c-b runbook deliberately opens (migrations -> frontend -> wait out bundle cache -> edge function). Email only; WhatsApp/push have no v1 counterpart. Honours notif_pref_bridge_hop_active() so it cannot ping-pong with the forward bridge. Retire together with the forward bridge and the v1 column in 10c-d.';

DROP TRIGGER IF EXISTS trg_mirror_open_slots_pref_to_v1 ON public.notification_preferences_v2;
CREATE TRIGGER trg_mirror_open_slots_pref_to_v1
  AFTER INSERT OR UPDATE OF email_frequency ON public.notification_preferences_v2
  FOR EACH ROW
  WHEN (NEW.event_type = 'open_slots_player')
  EXECUTE FUNCTION public.notif_mirror_open_slots_pref_to_v1();

-- NOTE ON `UPDATE OF email_frequency`: this fires when the column is NAMED in the SET list, not
-- only when its value changes, so the in-function no-change short-circuit above is load-bearing —
-- the settings page always writes both channel columns. A WhatsApp-only UPDATE issued in raw SQL
-- (not naming email_frequency) does not fire the trigger at all, which is the same outcome by a
-- cheaper route.
--
-- NOTE ON DELETE: deliberately not mirrored. Deleting a v2 row reverts the effective preference to
-- the catalog default while v1 would keep the mirrored value, so a DELETE mirror looks tempting.
-- But nothing deletes a single v2 row: the settings page has no delete, and the only deleter is
-- full account deletion (_shared/delete-user-data.ts), which removes the v1 row too. Adding a
-- DELETE mirror would therefore only add a way to clobber v1 during account teardown.

-- ===========================================================================================
-- 3b. ONE-TIME REVERSE RECONCILE, for v2 rows that predate the trigger.
--
-- A trigger only sees FUTURE writes. Any v2 row already carrying an open-slots choice when this
-- migration lands would never reach the legacy reader — which is exactly the gap this file exists
-- to close — so existing state is closed too, not only new writes.
--
-- HOW BIG IS THAT POPULATION? Nearly always zero, but not provably zero, and this is a consent
-- path:
--   * `open_slots_player` does not exist in the production catalog at all — 20261008100000 is on
--     this branch — so no user can hold a v2 row for it before this deploy;
--   * BUT one `supabase db push` applies its migrations in sequence, and the ALREADY-deployed
--     settings page reads the event catalog dynamically. From the moment 20261008100000 commits,
--     that page renders the new event and a save writes a v2 row — before this file runs;
--   * and C's backfill (20261011100000 §6) is ON CONFLICT DO NOTHING, so such a row WINS and its
--     legacy counterpart is never written. Without this statement that user's choice is stranded
--     precisely BECAUSE they were quick.
-- It also makes the migration correct on any environment that already holds v2 rows — a re-run, a
-- clone, a rehearsal target — rather than only on production's exact ordering.
--
-- SEMANTICS ARE THE TRIGGER'S, not a second rule: seed where no legacy row exists, and overwrite an
-- existing one only with a value the platform could not have supplied. The guard is held for the
-- duration so the forward mirror does not bounce every row straight back.
--
-- Bounded (one statement over one event's v2 rows), forward-only, and a pure no-op on re-run: the
-- DO UPDATE predicate stops matching once the two agree.
DO $reconcile$
DECLARE
  v_incidental text[] := public.notif_pref_open_slots_incidental_values();
  v_rows int;
BEGIN
  PERFORM pg_catalog.set_config('notif.pref_bridge_hop', 'on', true);

  INSERT INTO public.notification_preferences (user_id, open_slots_digest)
  SELECT p.user_id, p.email_frequency
    FROM public.notification_preferences_v2 p
   WHERE p.event_type = 'open_slots_player'
     AND p.user_id IS NOT NULL
     AND p.email_frequency IN ('off','instant','daily','weekly')
  ON CONFLICT (user_id) DO UPDATE
     SET open_slots_digest = EXCLUDED.open_slots_digest
   WHERE public.notification_preferences.open_slots_digest IS DISTINCT FROM EXCLUDED.open_slots_digest
     AND NOT (EXCLUDED.open_slots_digest = ANY (v_incidental));

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM pg_catalog.set_config('notif.pref_bridge_hop', 'off', true);
  RAISE NOTICE 'notif 10c-b J: reverse preference reconcile touched % legacy row(s)', v_rows;
END
$reconcile$;

-- ===========================================================================================
-- 4. CONCURRENCY — what is guaranteed, and what is not.
--
-- Two writers for the SAME user, one on each table, lock the two tables in opposite orders
-- (a v2 save locks v2 then v1; a legacy save locks v1 then v2). That is a lock cycle, and
-- Postgres resolves it by aborting one transaction with `deadlock detected`.
--
-- A cross-table advisory lock taken in a BEFORE INSERT trigger on both tables was considered and
-- REJECTED: it would take one advisory lock PER ROW on every preference write forever — held to
-- end of transaction, and so a bulk write of N rows would occupy N lock-table slots — to prevent
-- an event that requires one user to save on two differently-versioned bundles within the same
-- few milliseconds, and whose consequence is already benign.
--
-- The INVARIANT that actually matters is preserved either way, and it is the one the tests
-- assert: AFTER ANY COMMITTED **APPLYING** WRITE, v1 AND v2 AGREE. A deadlock aborts one
-- transaction whole, so it cannot leave the two tables disagreeing; a serialised pair leaves both
-- at the later writer's value. There is no interleaving that commits a v1 'instant' next to a
-- v2 'off'.
--
-- STATE THE EXCEPTION, because an unqualified "they always agree" is false and a future reader
-- would be right to call it a bug: a SEED-ONLY write leaves them DIFFERENT ON PURPOSE. A partial
-- v2 insert over a legacy 'off' commits v1='off' alongside v2='instant', and that divergence IS
-- the protection — the alternative is resuming mail after an opt-out. The concurrency argument
-- above is about applying writes; the ambiguous ones are governed by §3's rule instead, and the
-- direction of their divergence is always "the legacy reader sends no more than the user asked
-- for", never less consent than they gave.
--
-- Lost updates are prevented by the upserts themselves: ON CONFLICT DO UPDATE re-reads the
-- conflicting row under lock, so the second writer sees the first writer's committed value rather
-- than the snapshot it started from. The `WHERE ... IS DISTINCT FROM` predicates are evaluated
-- against that same locked, current row.

-- ===========================================================================================
-- RETIREMENT — when and how this comes out.
--
-- CONDITION. Both directions and the guard are removed together, in 10c-d (legacy retirement),
-- once ALL of the following hold:
--   1. send-email no longer maps any type onto open_slots_digest — i.e. new_availability and
--      slot_reopened are gone from TYPE_TO_PREF_COLUMN (send-email/index.ts). This is the real
--      trigger: while that map still names the column, a deployed old bundle can still enforce it.
--   2. That send-email revision is DEPLOYED, not merely merged. "Merged" is not "live" in this
--      repo: edge functions are pushed by hand after the frontend auto-deploys.
--   3. The browser bundle-cache window for the pre-cutover settings page has elapsed, so no
--      cached client is still writing v1 (this is what the FORWARD direction protects).
--   4. The v1 column itself is dropped in the same release unit, or the two mirrors are removed
--      first and the column left inert — never the reverse, which would strand writes.
--
-- HOW. In one migration: DROP TRIGGER trg_mirror_open_slots_pref_to_v1 ON
-- public.notification_preferences_v2; DROP TRIGGER trg_mirror_open_slots_pref_to_v2 ON
-- public.notification_preferences; DROP FUNCTION notif_mirror_open_slots_pref_to_v1(),
-- notif_mirror_open_slots_pref_to_v2(), notif_pref_bridge_hop_active(),
-- notif_pref_open_slots_incidental_values().
-- (validate_notification_frequency stays — §1c hardened it; it is not part of the bridge.)
--
-- ENFORCEMENT, and the trap inside it. Only condition 1 is mechanical, and it is pinned:
-- legacySendEmailInventory.test.ts asserts send-email's TYPE_TO_PREF_COLUMN still maps
-- new_availability and slot_reopened onto open_slots_digest. That assertion is green today and
-- goes RED the moment the SOURCE stops naming the column.
--
-- RED DOES NOT MEAN "DELETE THIS FILE". It means condition 1 is met and conditions 2-4 must now be
-- checked BY HAND, because no test in this repository can see them: the register measures the
-- REPOSITORY, and what still enforces v1 is the DEPLOYED bundle. Removing the bridge on a green
-- CI while the old send-email is still live would re-open this exact gap — migrations are pushed
-- before the edge function, so there would again be a window in which v2 writes are invisible to a
-- live v1 reader. Conflating "merged" with "live" is the mistake this whole file exists to survive.
-- The test says so in its own failure message, so the instruction arrives with the failure rather
-- than only here.
