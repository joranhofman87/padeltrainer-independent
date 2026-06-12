-- W-06 (Wave 4 B3): canonicalize locations.city spellings.
--
-- The directory import left ~80-97 (country, city) groups where the same city
-- appears with multiple spellings (Alkmaar/ALKMAAR, casing and whitespace
-- variants), which splits the club picker's city grouping. Rule: within each
-- (country, lower(trim(city))) group, the most frequent spelling (mode) wins.
-- Display/grouping only — slugs are a separate column and untouched.

UPDATE public.locations SET city = trim(city) WHERE city <> trim(city);

DO $$
DECLARE n integer;
BEGIN
  UPDATE public.locations l
  SET city = m.canonical
  FROM (
    SELECT country, lower(city) AS k,
           mode() WITHIN GROUP (ORDER BY city) AS canonical
    FROM public.locations
    GROUP BY country, lower(city)
    HAVING count(DISTINCT city) > 1
  ) m
  WHERE l.country = m.country
    AND lower(l.city) = m.k
    AND l.city <> m.canonical;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'W06 city canonicalization: % rows updated', n;

  SELECT count(*) INTO n FROM (
    SELECT 1 FROM public.locations
    GROUP BY country, lower(city) HAVING count(DISTINCT city) > 1
  ) d;
  RAISE NOTICE 'W06 remaining mixed-spelling city groups: %', n;
END $$;
