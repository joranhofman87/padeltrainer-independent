-- Search helpers + indexes for the server-side players overview RPC
-- (get_players_overview, next migration).

-- Immutable, extension-free search normalization (PGlite-safe; no unaccent
-- dependency). Mirrors src/lib/playerSearch.ts normalize(): lowercase +
-- strip common Latin diacritics. The two translate() argument strings MUST
-- stay equal length (companion _test.sql asserts representative foldings).
CREATE OR REPLACE FUNCTION public.fold_search_text(_value text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public
AS $$
  SELECT translate(lower(coalesce(_value, '')),
    'áàâäãåāăąçćčďđéèêëēĕėęěğģíìîïĩīĭįıķĺļľłñńņňóòôöõøōŏőŕŗřśšşťţúùûüũūŭůűųýÿžźż',
    'aaaaaaaaacccddeeeeeeeeeggiiiiiiiiikllllnnnnooooooooorrrsssttuuuuuuuuuuyyzzz');
$$;

CREATE OR REPLACE FUNCTION public.digits_only(_value text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public
AS $$
  SELECT regexp_replace(coalesce(_value, ''), '\D', '', 'g');
$$;

-- Indexes the overview's query plans need (verified missing today).
CREATE INDEX IF NOT EXISTS idx_bookings_guest_player_id
  ON public.bookings (guest_player_id)
  WHERE guest_player_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_guest_players_linked_profile
  ON public.guest_players (linked_profile_id)
  WHERE linked_profile_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_guest_player
  ON public.invoices (guest_player_id)
  WHERE guest_player_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_player
  ON public.invoices (player_id)
  WHERE player_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_academy_trainers_academy_status
  ON public.academy_trainers (academy_profile_id, status);
