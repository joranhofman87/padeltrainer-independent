-- W-06 B4 follow-up: the main pass merges duplicates into the GROUP survivor
-- (claimed/oldest at an address) and only when names are similar. Two sets
-- remained whose members are IDENTICAL to each other (same name+address+city)
-- but dissimilar to the group survivor — unambiguous duplicates. Merge each
-- identical set into its own claimed/oldest member, then create the
-- prevention index the main pass had to skip.

DO $$
DECLARE
  grp record; dup record; fk record; r record;
  v_surv uuid;
  retired integer := 0; junction_deduped integer := 0; remaining integer;
BEGIN
  FOR grp IN
    SELECT lower(trim(name)) AS nm, lower(trim(coalesce(street_address, ''))) AS addr,
           lower(trim(city)) AS cty, array_agg(id) AS ids
    FROM public.locations
    WHERE is_active AND merged_into IS NULL AND coalesce(trim(street_address), '') <> ''
    GROUP BY 1, 2, 3
    HAVING count(*) > 1
  LOOP
    SELECT l.id INTO v_surv
    FROM public.locations l
    LEFT JOIN public.club_profiles cp ON cp.location_id = l.id
    WHERE l.id = ANY (grp.ids)
    ORDER BY (cp.location_id IS NOT NULL) DESC, l.created_at ASC, l.id ASC
    LIMIT 1;

    FOR dup IN
      SELECT l.* FROM public.locations l WHERE l.id = ANY (grp.ids) AND l.id <> v_surv
    LOOP
      FOR fk IN
        SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.confrelid = 'public.locations'::regclass AND c.contype = 'f'
          AND c.conrelid <> 'public.locations'::regclass
      LOOP
        FOR r IN EXECUTE format('SELECT ctid AS tid FROM %s WHERE %I = $1', fk.tbl, fk.col) USING dup.id
        LOOP
          BEGIN
            EXECUTE format('UPDATE %s SET %I = $1 WHERE ctid = $2', fk.tbl, fk.col) USING v_surv, r.tid;
          EXCEPTION WHEN unique_violation THEN
            IF fk.tbl IN ('academy_locations', 'trainer_locations', 'player_locations',
                          'location_translations', 'court_reviews',
                          'public.academy_locations', 'public.trainer_locations', 'public.player_locations',
                          'public.location_translations', 'public.court_reviews') THEN
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
  END LOOP;

  RAISE NOTICE 'W06 exact-pair pass: % rows retired, % junction rows deduped', retired, junction_deduped;

  SELECT count(*) INTO remaining FROM (
    SELECT 1 FROM public.locations
    WHERE is_active AND merged_into IS NULL AND coalesce(trim(street_address), '') <> ''
    GROUP BY lower(trim(name)), lower(trim(coalesce(street_address, ''))), lower(trim(city))
    HAVING count(*) > 1
  ) d;
  IF remaining = 0 THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_location_identity
      ON public.locations (lower(trim(name)), lower(trim(coalesce(street_address, ''''))), lower(trim(city)))
      WHERE is_active AND merged_into IS NULL AND coalesce(trim(street_address), '''') <> ''''';
    RAISE NOTICE 'W06 prevention index created';
  ELSE
    RAISE EXCEPTION 'W06: % exact-duplicate groups still remain — investigate', remaining;
  END IF;
END $$;
