-- W-06 (Wave 4 B2): normalize locations.country to ISO 3166-1 alpha-2 codes.
--
-- The column was unconstrained free text from a bulk import: 100 distinct
-- labels for ~70 countries (English names, ISO codes, 'México', flag emoji,
-- 'rance', a city, a club slug). Consequence in the product: the club picker's
-- default NL filter hid all 606 'Netherlands'-labeled Dutch clubs, and the
-- country dropdown showed duplicates ("Nederland" and "Netherlands").
--
-- Mapping below covers every label observed in the 2026-05-30 export AND the
-- live X-ray (20260612150000). Rows that still don't match ^[A-Z]{2}$ after
-- mapping (drift since the export) are set to the ISO user-assigned code 'ZZ'
-- (unknown) with a NOTICE count — deterministic, constraint-safe, recoverable.

UPDATE public.locations SET country = m.code
FROM (VALUES
  ('Spain','ES'), ('France','FR'), ('Italy','IT'), ('United Kingdom','GB'),
  ('Netherlands','NL'), ('Germany','DE'), ('Belgium','BE'), ('Denmark','DK'),
  ('Mexico','MX'), ('Sweden','SE'), ('United States','US'), ('Indonesia','ID'),
  ('United Arab Emirates','AE'), ('Chile','CL'), ('Pakistan','PK'),
  ('Ecuador','EC'), ('Colombia','CO'), ('Switzerland','CH'), ('Argentina','AR'),
  ('Austria','AT'), ('Canada','CA'), ('Portugal','PT'), ('Uruguay','UY'),
  ('Turkey','TR'), ('Kenya','KE'), ('Panama','PA'), ('Ireland','IE'),
  ('Malaysia','MY'), ('Cyprus','CY'), ('Costa Rica','CR'), ('Lithuania','LT'),
  ('Serbia','RS'), ('South Africa','ZA'), ('Dominican Republic','DO'),
  ('Estonia','EE'), ('Egypt','EG'), ('Poland','PL'), ('Australia','AU'),
  ('Finland','FI'), ('Latvia','LV'), ('Saudi Arabia','SA'), ('Morocco','MA'),
  ('India','IN'), ('Norway','NO'), ('Malta','MT'), ('Philippines','PH'),
  ('Slovakia','SK'), ('Kuwait','KW'), ('Qatar','QA'), ('Venezuela','VE'),
  ('Israel','IL'), ('Hungary','HU'), ('Singapore','SG'), ('Brazil','BR'),
  ('China','CN'), ('Bahrain','BH'), ('Greece','GR'), ('Bulgaria','BG'),
  ('Vietnam','VN'), ('New Zealand','NZ'), ('Tunisia','TN'), ('Japan','JP'),
  ('Thailand','TH'), ('Peru','PE'), ('Croatia','HR'), ('Nigeria','NG'),
  ('Czechia','CZ'), ('Romania','RO'), ('Bolivia','BO'),
  -- variants / typos / garbage observed in the data
  ('México','MX'), ('USA','US'), ('United Arab Emirates 🇦🇪','AE'),
  ('United Arab Emirate','AE'), ('rance','FR'),
  ('Cala Rajada','ES'),                            -- city in Mallorca
  ('tennis-club-dour-le-belvedere-dour','BE')      -- Dour is in Belgium
) AS m(label, code)
WHERE locations.country = m.label;

DO $$
DECLARE n integer;
BEGIN
  UPDATE public.locations SET country = 'ZZ' WHERE country !~ '^[A-Z]{2}$';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'W06 backfill: % rows set to ZZ (unknown country, fix manually)', n;
END $$;

-- Lock the format so free text can never creep back in.
ALTER TABLE public.locations
  ADD CONSTRAINT locations_country_iso_alpha2 CHECK (country ~ '^[A-Z]{2}$');
