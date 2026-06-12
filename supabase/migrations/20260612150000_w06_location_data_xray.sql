-- W-06 pre-scoping X-ray (NOTICE-ONLY, no mutations): quantify the location
-- directory's free-text country/city drift and duplicate clubs, to size the
-- Wave 4 normalization. Counts only — no PII, no row data beyond country labels
-- (which are non-personal directory metadata).

DO $$
DECLARE
  r record;
  n integer;
  total integer;
BEGIN
  SELECT count(*) INTO total FROM public.locations;
  RAISE NOTICE 'W06 total locations: %', total;

  SELECT count(DISTINCT country) INTO n FROM public.locations;
  RAISE NOTICE 'W06 distinct country values: %', n;

  -- Top 15 country labels by row count (labels are directory metadata, not PII)
  FOR r IN
    SELECT country, count(*) AS c FROM public.locations
    GROUP BY country ORDER BY c DESC LIMIT 15
  LOOP
    RAISE NOTICE 'W06 country % -> % rows', r.country, r.c;
  END LOOP;

  -- Country labels that normalize to the same lowercase value (casing dupes)
  SELECT count(*) INTO n FROM (
    SELECT lower(trim(country)) FROM public.locations
    GROUP BY lower(trim(country)) HAVING count(DISTINCT country) > 1
  ) d;
  RAISE NOTICE 'W06 country labels duplicated by casing/whitespace: % groups', n;

  -- Cities duplicated by casing within the same country
  SELECT count(*) INTO n FROM (
    SELECT lower(trim(country)), lower(trim(city)) FROM public.locations
    GROUP BY lower(trim(country)), lower(trim(city))
    HAVING count(DISTINCT city) > 1
  ) d;
  RAISE NOTICE 'W06 city labels duplicated by casing within a country: % groups', n;

  -- Candidate duplicate clubs: same normalized name + street address
  SELECT count(*) INTO n FROM (
    SELECT lower(trim(name)), lower(trim(coalesce(street_address, '')))
    FROM public.locations
    WHERE coalesce(trim(street_address), '') <> ''
    GROUP BY lower(trim(name)), lower(trim(coalesce(street_address, '')))
    HAVING count(*) > 1
  ) d;
  RAISE NOTICE 'W06 duplicate clubs by (name, street_address): % groups', n;

  -- Same street address, different names (the ATC Veenhorst / LTC variants case)
  SELECT count(*) INTO n FROM (
    SELECT lower(trim(street_address)), lower(trim(city))
    FROM public.locations
    WHERE coalesce(trim(street_address), '') <> ''
    GROUP BY lower(trim(street_address)), lower(trim(city))
    HAVING count(*) > 1
  ) d;
  RAISE NOTICE 'W06 addresses shared by multiple club rows: % groups', n;

  -- Rows whose country looks like a 2-letter code vs free text
  SELECT count(*) INTO n FROM public.locations WHERE country ~ '^[A-Z]{2}$';
  RAISE NOTICE 'W06 rows with ISO-like 2-letter country codes: %', n;
END $$;
