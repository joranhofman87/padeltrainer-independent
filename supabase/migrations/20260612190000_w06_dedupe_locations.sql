-- W-06 B4 (maintainer-approved 2026-06-12): merge duplicate club rows.
--
-- Policy (per docs/W06-DEDUPE-DRYRUN.md, approved "all 101"):
--  * groups = active rows sharing (street_address, city), address non-empty;
--  * within a group, only SIMILAR-named rows merge (substring or shared first
--    word) — different-named venues at one address are left alone;
--  * survivor = claimed club (club_profiles row) first, else oldest created_at;
--  * duplicates are SOFT-retired: is_active=false + merged_into=survivor
--    (slug stays resolvable; the client follows merged_into);
--  * every FK referencing locations(id) is repointed generically from
--    pg_constraint; junction tables dedup on unique-violation instead of
--    failing (allow-list below) — any other unique violation aborts the
--    whole migration (transactional, nothing partial).

ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS merged_into uuid REFERENCES public.locations(id);

DO $$
DECLARE
  grp record; dup record; fk record; r record;
  v_surv uuid;
  groups_done integer := 0; retired integer := 0; junction_deduped integer := 0;
  remaining_violations integer;
BEGIN
  FOR grp IN
    SELECT lower(trim(street_address)) AS addr, lower(trim(city)) AS cty,
           array_agg(id) AS ids
    FROM public.locations
    WHERE coalesce(trim(street_address), '') <> ''
      AND is_active AND merged_into IS NULL
    GROUP BY 1, 2
    HAVING count(*) > 1
  LOOP
    SELECT l.id INTO v_surv
    FROM public.locations l
    LEFT JOIN public.club_profiles cp ON cp.location_id = l.id
    WHERE l.id = ANY (grp.ids)
    ORDER BY (cp.location_id IS NOT NULL) DESC, l.created_at ASC, l.id ASC
    LIMIT 1;

    FOR dup IN
      SELECT l.* FROM public.locations l
      WHERE l.id = ANY (grp.ids) AND l.id <> v_surv
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM public.locations s
        WHERE s.id = v_surv
          AND (position(lower(trim(dup.name)) IN lower(trim(s.name))) > 0
            OR position(lower(trim(s.name)) IN lower(trim(dup.name))) > 0
            OR split_part(lower(trim(s.name)), ' ', 1) = split_part(lower(trim(dup.name)), ' ', 1))
      ) THEN
        CONTINUE;
      END IF;

      FOR fk IN
        SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.confrelid = 'public.locations'::regclass
          AND c.contype = 'f'
          AND c.conrelid <> 'public.locations'::regclass
      LOOP
        FOR r IN EXECUTE format('SELECT ctid AS tid FROM %s WHERE %I = $1', fk.tbl, fk.col) USING dup.id
        LOOP
          BEGIN
            EXECUTE format('UPDATE %s SET %I = $1 WHERE ctid = $2', fk.tbl, fk.col)
              USING v_surv, r.tid;
          EXCEPTION WHEN unique_violation THEN
            IF fk.tbl IN ('academy_locations', 'trainer_locations', 'player_locations',
                          'location_translations', 'court_reviews',
                          'public.academy_locations', 'public.trainer_locations', 'public.player_locations',
                          'public.location_translations', 'public.court_reviews') THEN
              -- the survivor already carries this relation (link/translation/review) — the duplicate row is redundant
              EXECUTE format('DELETE FROM %s WHERE ctid = $1', fk.tbl) USING r.tid;
              junction_deduped := junction_deduped + 1;
            ELSE
              RAISE;
            END IF;
          END;
        END LOOP;
      END LOOP;

      UPDATE public.locations SET is_active = false, merged_into = v_surv WHERE id = dup.id;
      retired := retired + 1;
    END LOOP;
    groups_done := groups_done + 1;
  END LOOP;

  RAISE NOTICE 'W06 dedupe: % groups scanned, % rows retired, % junction rows deduped',
    groups_done, retired, junction_deduped;

  -- Prevention: block NEW exact (name, address, city) duplicates among active
  -- rows. Only created when no violating pairs remain (else NOTICE + skip so
  -- the merges above still commit).
  SELECT count(*) INTO remaining_violations FROM (
    SELECT 1 FROM public.locations
    WHERE is_active AND merged_into IS NULL AND coalesce(trim(street_address), '') <> ''
    GROUP BY lower(trim(name)), lower(trim(coalesce(street_address, ''))), lower(trim(city))
    HAVING count(*) > 1
  ) d;
  IF remaining_violations = 0 THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_location_identity
      ON public.locations (lower(trim(name)), lower(trim(coalesce(street_address, ''''))), lower(trim(city)))
      WHERE is_active AND merged_into IS NULL AND coalesce(trim(street_address), '''') <> ''''';
    RAISE NOTICE 'W06 dedupe: prevention index created';
  ELSE
    RAISE NOTICE 'W06 dedupe: % exact-duplicate groups remain — prevention index SKIPPED', remaining_violations;
  END IF;
END $$;
