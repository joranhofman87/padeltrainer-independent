-- =============================================================================
-- CYCLE SERIES SPLIT — split 3 legacy "mega-cycles" into per-series cyclus rows
-- =============================================================================
-- OWNER-RUN, ONE-TIME, DELIBERATE. NOT a tracked migration on purpose: it must
-- run only after the pre-flight in docs/CYCLE_SERIES_SPLIT_RUNBOOK.md passes and
-- only when you choose to, so it is intentionally kept OUT of supabase/migrations/
-- where the next `supabase db push` would otherwise fire it automatically. Run it
-- by hand in the Supabase SQL editor (or psql).
--
-- WHAT IT DOES: three legacy cycles each bundle a whole season of MANY weekly
-- series into one row (e.g. "Padeltrainingen zomer 2026" = 322 slots / 23 series).
-- This splits each into one type='cyclus' cycle per weekly series — keyed by
-- (trainer, weekday, start-time, end-time, location) in the academy's timezone —
-- by INSERTing the new cycles and re-pointing availability_slots.cyclus_id. The
-- 3 parents are LEFT as empty shells (0 slots) — they still back the registration
-- form + intake_requests.cycle_id, so they are never written.
--
-- NON-DESTRUCTIVE / INVOICE-SAFE (owner-locked): the ONLY writes are
--   (a) INSERT new type='cyclus' cycles, and
--   (b) UPDATE availability_slots SET cyclus_id, cyclus_name  (those 2 columns only).
-- bookings, invoices and the 3 parent cycles are NEVER written. Bookings link to
-- slots by slot_id (unchanged), so every booking + invoice keeps its exact link.
-- The verify block re-checks bookings + invoices by CONTENT CHECKSUM and ROLLS
-- BACK on any drift.
--
-- DETERMINISTIC + IDEMPOTENT: each new cycle id = md5(parent_id || '::' ||
-- series_key)::uuid — a pure function of the data (no gen_random_uuid, no
-- uuid-ossp extension). Re-running computes the same ids: the INSERT
-- ON CONFLICT (id) DO NOTHING and the slot UPDATE (driven off slots still on a
-- parent) both become no-ops on run 2.
--
-- REVERSIBLE: every new cycle carries settings.split_migration =
-- 'CYCLE_SERIES_SPLIT_v1' + split_from_cycle_id. See the rollback block at the
-- bottom of docs/CYCLE_SERIES_SPLIT_RUNBOOK.md.
--
-- SELF-ROLLING-BACK: one explicit transaction. The verification DO block RAISEs
-- EXCEPTION on ANY anomaly → the txn aborts → the trailing COMMIT is reported as
-- ROLLBACK → zero rows changed.
--
-- DRY-RUN: change the final COMMIT to ROLLBACK and run it to inspect the NOTICE /
-- EXCEPTION arithmetic with no write.
--
-- TIMEZONE: the series key + dates are computed in the academy's own timezone
-- (academy_profiles.timezone, fallback 'Europe/Amsterdam'). All 3 parents are
-- academy-owned, so this resolves to the same tz the pre-flight sizing query used.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0) BASELINE — capture pre-write state inside THIS transaction. Content
--    checksums on the never-written tables PROVE the exact row-set is untouched.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _csplit_baseline ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM public.bookings)            AS bookings,
  (SELECT count(*) FROM public.invoices)            AS invoices,
  (SELECT count(*) FROM public.availability_slots)  AS slots,
  (SELECT count(*) FROM public.cycles)              AS cycles,
  -- content checksum of the never-written tables (id-set for bookings; id + every
  -- money/link field for invoices). Re-checked at the end → RAISE → ROLLBACK on drift.
  (SELECT md5(coalesce(string_agg(id::text, ',' ORDER BY id), '')) FROM public.bookings) AS bookings_ck,
  (SELECT md5(coalesce(string_agg(
      id::text || '|' || coalesce(total::text,'') || '|' || coalesce(subtotal::text,'')
      || '|' || coalesce(vat_amount::text,'') || '|' || coalesce(status,'')
      || '|' || coalesce(cycle_id::text,'') || '|' || coalesce(array_to_string(booking_ids, ','),''),
      ',' ORDER BY id), '')) FROM public.invoices) AS invoices_ck,
  -- slots still owned by one of the 3 parents (= the slots this run must move)
  (SELECT count(*) FROM public.availability_slots
     WHERE cyclus_id IN (
       '1e40f602-21eb-4ef1-ae31-f1616897f4c8',
       '2aa741a2-f0e6-435b-a3cb-998df8b6c005',
       '69f60dbe-9a7c-4c19-a794-e68e13915fc2')) AS parent_slots,
  -- slots ALREADY on a marker (split) cycle before this run (re-run safety)
  (SELECT count(*) FROM public.availability_slots s
     JOIN public.cycles nc ON nc.id = s.cyclus_id
    WHERE nc.settings->>'split_migration' = 'CYCLE_SERIES_SPLIT_v1') AS children_slots_before;

-- ---------------------------------------------------------------------------
-- 1) _slot_series — one row per slot STILL pointing at a parent, with its
--    series key (academy-tz wall clock) + deterministic new cycle id.
--    The `WHERE cyclus_id IN (<3 parents>)` filter is the primary idempotency
--    guard: after a full run there are no such slots, so this is empty on re-run.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _slot_series ON COMMIT DROP AS
WITH base AS (
  SELECT s.id AS slot_id, s.cyclus_id AS parent_id, s.trainer_id, s.location_id,
         s.start_time, s.end_time,
         COALESCE(ap.timezone, 'Europe/Amsterdam') AS tz
  FROM public.availability_slots s
  JOIN public.cycles p ON p.id = s.cyclus_id
  LEFT JOIN public.academy_profiles ap ON ap.id = p.owner_id AND p.owner_type = 'academy'
  WHERE s.cyclus_id IN (
    '1e40f602-21eb-4ef1-ae31-f1616897f4c8',
    '2aa741a2-f0e6-435b-a3cb-998df8b6c005',
    '69f60dbe-9a7c-4c19-a794-e68e13915fc2')
), k AS (
  SELECT slot_id, parent_id, trainer_id, location_id, start_time, end_time, tz,
         EXTRACT(ISODOW FROM start_time AT TIME ZONE tz)::int AS dow,
         to_char(start_time AT TIME ZONE tz, 'HH24:MI')       AS start_hhmm,
         (start_time AT TIME ZONE tz)::date                   AS local_date,
         ( COALESCE(trainer_id::text, '∅') || '|'
           || EXTRACT(ISODOW FROM start_time AT TIME ZONE tz)::int || '|'
           || to_char(start_time AT TIME ZONE tz, 'HH24:MI') || '|'
           || to_char(end_time   AT TIME ZONE tz, 'HH24:MI') || '|'
           || COALESCE(location_id::text, '∅') )             AS series_key
  FROM base
)
SELECT k.*,
       md5(parent_id::text || '::' || series_key)::uuid AS new_id
FROM k;

-- ---------------------------------------------------------------------------
-- 2) _series — one row per (parent, series_key). trainer_id / location_id are
--    constant within a key (they are part of it). start/end_date = the series'
--    wall-clock date span. new_id is deterministic.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _series ON COMMIT DROP AS
SELECT
  ss.new_id,
  ss.parent_id,
  ss.series_key,
  min(ss.trainer_id::text)::uuid  AS trainer_id,
  min(ss.location_id::text)::uuid AS location_id,
  min(ss.dow)                     AS dow,
  min(ss.start_hhmm)              AS start_hhmm,
  min(ss.local_date)              AS start_date,
  max(ss.local_date)              AS end_date
FROM _slot_series ss
GROUP BY ss.new_id, ss.parent_id, ss.series_key;

-- ---------------------------------------------------------------------------
-- (a) INSERT one type='cyclus' cycle per series. Copies the parent's
--     status / owner / currency / is_always_open and its FULL settings blob
--     (so settings.split_payment is preserved verbatim → the
--     trg_inherit_cycle_split_payment trigger that fires on the slot re-point
--     in step (b) is a no-op), merged with the provenance marker. Name is
--     derived "<NL weekday> <HH:MM> - <trainer full_name>" (fallback no name).
--     total_price is intentionally NULL (a per-series total is unknown; the
--     season-level parent total would be misleading — the slots carry the real
--     per-session price, untouched). Idempotent via the deterministic id.
-- ---------------------------------------------------------------------------
INSERT INTO public.cycles
  (id, type, name, status, owner_type, owner_id, start_date, end_date,
   settings, price_per_session, total_price, location_id, currency,
   is_always_open, created_at, updated_at)
SELECT
  se.new_id,
  'cyclus',
  ( CASE se.dow WHEN 1 THEN 'Maandag' WHEN 2 THEN 'Dinsdag' WHEN 3 THEN 'Woensdag'
                WHEN 4 THEN 'Donderdag' WHEN 5 THEN 'Vrijdag' WHEN 6 THEN 'Zaterdag'
                ELSE 'Zondag' END )
    || ' ' || se.start_hhmm
    || COALESCE(' - ' || pr.full_name, ''),
  p.status, p.owner_type, p.owner_id, se.start_date, se.end_date,
  COALESCE(p.settings, '{}'::jsonb)
    || jsonb_build_object('split_from_cycle_id', p.id::text,
                          'series_key', se.series_key,
                          'split_migration', 'CYCLE_SERIES_SPLIT_v1'),
  p.price_per_session,
  NULL,                                      -- total_price: do not fake a per-series total
  COALESCE(se.location_id, p.location_id),
  p.currency,
  p.is_always_open,
  now(), now()
FROM _series se
JOIN public.cycles p ON p.id = se.parent_id
LEFT JOIN public.trainer_profiles tp ON tp.id = se.trainer_id
LEFT JOIN public.profiles pr ON pr.user_id = tp.user_id
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- (b) Re-point each slot to its new per-series cycle + denormalize the name.
--     Only availability_slots.cyclus_id + cyclus_name are written. On re-run
--     _slot_series is empty → 0 rows updated.
-- ---------------------------------------------------------------------------
UPDATE public.availability_slots s
   SET cyclus_id   = ss.new_id,
       cyclus_name = nc.name
  FROM _slot_series ss
  JOIN public.cycles nc ON nc.id = ss.new_id
 WHERE s.id = ss.slot_id;

-- ---------------------------------------------------------------------------
-- (c) VERIFY in-transaction. Any RAISE EXCEPTION aborts → ROLLBACK (data intact).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  base      _csplit_baseline%ROWTYPE;
  bad       bigint;
  n_marker  bigint;
  marker_slots bigint;
BEGIN
  SELECT * INTO base FROM _csplit_baseline;

  -- (1) CONTENT-IMMUTABLE: bookings + invoices byte-for-byte the same row-set
  --     (checksum, not just count) — the headline money guarantee.
  IF (SELECT md5(coalesce(string_agg(id::text, ',' ORDER BY id), '')) FROM public.bookings) <> base.bookings_ck THEN
    RAISE EXCEPTION 'bookings row-set changed (checksum mismatch)';
  END IF;
  IF (SELECT md5(coalesce(string_agg(
        id::text || '|' || coalesce(total::text,'') || '|' || coalesce(subtotal::text,'')
        || '|' || coalesce(vat_amount::text,'') || '|' || coalesce(status,'')
        || '|' || coalesce(cycle_id::text,'') || '|' || coalesce(array_to_string(booking_ids, ','),''),
        ',' ORDER BY id), '')) FROM public.invoices) <> base.invoices_ck THEN
    RAISE EXCEPTION 'invoices row-set changed (money/link field moved) — rolled back';
  END IF;
  IF (SELECT count(*) FROM public.bookings) <> base.bookings THEN
    RAISE EXCEPTION 'bookings count changed: % -> %', base.bookings, (SELECT count(*) FROM public.bookings);
  END IF;
  IF (SELECT count(*) FROM public.invoices) <> base.invoices THEN
    RAISE EXCEPTION 'invoices count changed: % -> %', base.invoices, (SELECT count(*) FROM public.invoices);
  END IF;
  -- (2) slots are only re-pointed, never inserted/deleted.
  IF (SELECT count(*) FROM public.availability_slots) <> base.slots THEN
    RAISE EXCEPTION 'availability_slots count changed: % -> %', base.slots, (SELECT count(*) FROM public.availability_slots);
  END IF;

  -- (3) ZERO slots remain on the 3 parents.
  SELECT count(*) INTO bad FROM public.availability_slots
   WHERE cyclus_id IN (
     '1e40f602-21eb-4ef1-ae31-f1616897f4c8',
     '2aa741a2-f0e6-435b-a3cb-998df8b6c005',
     '69f60dbe-9a7c-4c19-a794-e68e13915fc2');
  IF bad > 0 THEN RAISE EXCEPTION '% slot(s) still point at a parent cycle', bad; END IF;

  -- (4) MAPPING CORRECTNESS: every slot owned by a marker (split) cycle must map
  --     to md5(parent || recomputed series_key) and carry that cycle's name.
  SELECT count(*) INTO bad
    FROM public.availability_slots s
    JOIN public.cycles nc ON nc.id = s.cyclus_id
    JOIN public.cycles p  ON p.id = (nc.settings->>'split_from_cycle_id')::uuid
    LEFT JOIN public.academy_profiles ap ON ap.id = p.owner_id AND p.owner_type = 'academy'
   WHERE nc.settings->>'split_migration' = 'CYCLE_SERIES_SPLIT_v1'
     AND ( s.cyclus_id <> md5(
             p.id::text || '::' ||
             ( COALESCE(s.trainer_id::text,'∅') || '|'
               || EXTRACT(ISODOW FROM s.start_time AT TIME ZONE COALESCE(ap.timezone,'Europe/Amsterdam'))::int || '|'
               || to_char(s.start_time AT TIME ZONE COALESCE(ap.timezone,'Europe/Amsterdam'),'HH24:MI') || '|'
               || to_char(s.end_time   AT TIME ZONE COALESCE(ap.timezone,'Europe/Amsterdam'),'HH24:MI') || '|'
               || COALESCE(s.location_id::text,'∅') )
           )::uuid
        OR s.cyclus_name IS DISTINCT FROM nc.name );
  IF bad > 0 THEN RAISE EXCEPTION '% slot(s) mis-mapped to a split cycle (id or name)', bad; END IF;

  -- (5) NO ORPHAN split cycle (every marker cycle owns >=1 slot).
  SELECT count(*) INTO bad FROM public.cycles nc
   WHERE nc.settings->>'split_migration' = 'CYCLE_SERIES_SPLIT_v1'
     AND NOT EXISTS (SELECT 1 FROM public.availability_slots s WHERE s.cyclus_id = nc.id);
  IF bad > 0 THEN RAISE EXCEPTION '% split cycle(s) own zero slots', bad; END IF;

  -- (6) SLOT CONSERVATION (re-run safe): slots now owned by marker cycles must
  --     equal those already on markers before + those just moved off parents.
  SELECT count(*) INTO marker_slots
    FROM public.availability_slots s
    JOIN public.cycles nc ON nc.id = s.cyclus_id
   WHERE nc.settings->>'split_migration' = 'CYCLE_SERIES_SPLIT_v1';
  IF marker_slots <> base.children_slots_before + base.parent_slots THEN
    RAISE EXCEPTION 'slot conservation failed: marker-owned slots = %, expected % (% prior + % moved)',
      marker_slots, base.children_slots_before + base.parent_slots, base.children_slots_before, base.parent_slots;
  END IF;

  n_marker := (SELECT count(*) FROM public.cycles WHERE settings->>'split_migration' = 'CYCLE_SERIES_SPLIT_v1');
  RAISE NOTICE 'cycle series split OK: % split cycles own % slots (% moved this run); parents now empty; bookings + invoices unchanged.',
    n_marker, marker_slots, base.parent_slots;
END $$;

COMMIT;
