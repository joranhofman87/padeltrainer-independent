-- Sanity assertions for the players-overview helpers. Runs on every
-- db reset / db push; pure checks, no data mutation.
DO $$
DECLARE
  v_from text := 'áàâäãåāăąçćčďđéèêëēĕėęěğģíìîïĩīĭįıķĺļľłñńņňóòôöõøōŏőŕŗřśšşťţúùûüũūŭůűųýÿžźż';
  v_to   text := 'aaaaaaaaacccddeeeeeeeeeggiiiiiiiiikllllnnnnooooooooorrrsssttuuuuuuuuuuyyzzz';
BEGIN
  -- translate() maps char-by-char: the two strings MUST be equal length or
  -- folding silently deletes characters.
  IF length(v_from) <> length(v_to) THEN
    RAISE EXCEPTION 'fold_search_text translate strings length mismatch: % vs %',
      length(v_from), length(v_to);
  END IF;

  IF public.fold_search_text('Émilie van Dijk') <> 'emilie van dijk' THEN
    RAISE EXCEPTION 'fold_search_text diacritic folding broken: %',
      public.fold_search_text('Émilie van Dijk');
  END IF;

  IF public.fold_search_text('José García-Çelik') <> 'jose garcia-celik' THEN
    RAISE EXCEPTION 'fold_search_text folding broken: %',
      public.fold_search_text('José García-Çelik');
  END IF;

  IF public.digits_only('+31 6 1234-5678') <> '31612345678' THEN
    RAISE EXCEPTION 'digits_only broken: %', public.digits_only('+31 6 1234-5678');
  END IF;

  -- The RPC must exist with the expected signature.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_players_overview'
  ) THEN
    RAISE EXCEPTION 'get_players_overview missing';
  END IF;
END $$;
