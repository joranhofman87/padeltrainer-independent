-- AUDIT (read-only): production data invariants X-ray.
-- Emits RAISE NOTICE counts only — never mutates, never fails. Safe to re-run.
-- Part of the 2026-06 full app audit (docs/AUDIT-2026-06.md).

DO $$
DECLARE
  n integer;
BEGIN
  RAISE NOTICE '=== data invariants audit (counts only) ===';

  -- 1. Orphaned references
  SELECT count(*) INTO n FROM public.bookings b
    WHERE b.guest_player_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.guest_players g WHERE g.id = b.guest_player_id);
  RAISE NOTICE 'bookings -> missing guest: %', n;

  SELECT count(*) INTO n FROM public.bookings b
    WHERE b.player_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = b.player_id);
  RAISE NOTICE 'bookings -> missing profile: %', n;

  SELECT count(*) INTO n FROM public.bookings b
    WHERE b.slot_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.availability_slots s WHERE s.id = b.slot_id);
  RAISE NOTICE 'bookings -> missing slot: %', n;

  SELECT count(*) INTO n FROM public.invoices i
    WHERE i.guest_player_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.guest_players g WHERE g.id = i.guest_player_id);
  RAISE NOTICE 'invoices -> missing guest: %', n;

  SELECT count(*) INTO n FROM public.invoices i
    WHERE i.player_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = i.player_id);
  RAISE NOTICE 'invoices -> missing profile: %', n;

  SELECT count(*) INTO n FROM public.guest_players g
    WHERE g.linked_profile_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = g.linked_profile_id);
  RAISE NOTICE 'guests -> dangling linked_profile_id: %', n;

  SELECT count(*) INTO n FROM public.intake_requests i
    WHERE NOT EXISTS (SELECT 1 FROM public.cycles c WHERE c.id = i.cycle_id);
  RAISE NOTICE 'intake_requests -> missing cycle: %', n;

  SELECT count(*) INTO n FROM public.availability_slots s
    WHERE s.trainer_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.trainer_profiles t WHERE t.id = s.trainer_id);
  RAISE NOTICE 'slots -> missing trainer: %', n;

  -- 2. Money consistency
  SELECT count(*) INTO n FROM public.invoices i
    WHERE abs(coalesce(i.subtotal,0) + coalesce(i.vat_amount,0) - coalesce(i.total,0)) > 0.02;
  RAISE NOTICE 'invoices: subtotal+vat <> total (>2ct): %', n;

  SELECT count(*) INTO n FROM (
    SELECT i.id
    FROM public.invoices i
    WHERE jsonb_typeof(i.line_items) = 'array'
    GROUP BY i.id, i.subtotal, i.total
    HAVING (
      SELECT abs(coalesce(sum((li->>'amount')::numeric), 0) - i.total) > 0.02
         AND abs(coalesce(sum((li->>'amount')::numeric), 0) - i.subtotal) > 0.02
      FROM jsonb_array_elements(i.line_items) li
      WHERE (li->>'amount') ~ '^-?[0-9.]+$'
    )
  ) sub;
  RAISE NOTICE 'invoices: line-item sum matches NEITHER total NOR subtotal (>2ct): %', n;

  SELECT count(*) INTO n FROM public.invoices i WHERE coalesce(i.total,0) < 0 OR coalesce(i.subtotal,0) < 0;
  RAISE NOTICE 'invoices: negative totals: %', n;

  SELECT count(*) INTO n FROM public.invoices i
    WHERE i.paid_at IS NOT NULL AND lower(i.status) NOT IN ('paid');
  RAISE NOTICE 'invoices: paid_at set but status <> paid: %', n;

  SELECT count(*) INTO n FROM public.invoices i
    WHERE lower(i.status) = 'paid' AND i.paid_at IS NULL;
  RAISE NOTICE 'invoices: status=paid but paid_at null: %', n;

  -- duplicate invoice numbers within an owner scope (numbering race evidence)
  SELECT count(*) INTO n FROM (
    SELECT i.invoice_number FROM public.invoices i
    WHERE i.academy_profile_id IS NOT NULL
    GROUP BY i.academy_profile_id, i.invoice_number HAVING count(*) > 1
  ) d;
  RAISE NOTICE 'invoices: duplicate invoice_number within an academy: %', n;

  SELECT count(*) INTO n FROM (
    SELECT i.invoice_number FROM public.invoices i
    WHERE i.academy_profile_id IS NULL AND i.trainer_id IS NOT NULL
    GROUP BY i.trainer_id, i.invoice_number HAVING count(*) > 1
  ) d;
  RAISE NOTICE 'invoices: duplicate invoice_number within a trainer: %', n;

  -- 3. Booking sanity
  SELECT count(*) INTO n FROM (
    SELECT b.slot_id FROM public.bookings b
    WHERE b.status IN ('confirmed','completed') AND b.player_id IS NOT NULL
    GROUP BY b.slot_id, b.player_id HAVING count(*) > 1
  ) d;
  RAISE NOTICE 'duplicate active bookings (slot+registered player): %', n;

  SELECT count(*) INTO n FROM (
    SELECT b.slot_id FROM public.bookings b
    WHERE b.status IN ('confirmed','completed') AND b.guest_player_id IS NOT NULL
    GROUP BY b.slot_id, b.guest_player_id HAVING count(*) > 1
  ) d;
  RAISE NOTICE 'duplicate active bookings (slot+guest): %', n;

  SELECT count(*) INTO n FROM public.bookings b
    WHERE b.player_id IS NOT NULL AND b.guest_player_id IS NOT NULL;
  RAISE NOTICE 'bookings with BOTH player_id and guest_player_id: %', n;

  -- 4. Identity sanity
  SELECT count(*) INTO n FROM (
    SELECT g.linked_profile_id FROM public.guest_players g
    WHERE g.linked_profile_id IS NOT NULL
    GROUP BY g.linked_profile_id,
             coalesce(g.trainer_id::text, 'a:' || g.academy_profile_id::text)
    HAVING count(*) > 1
  ) d;
  RAISE NOTICE 'same profile linked to >1 guest within one owner scope: %', n;

  SELECT count(*) INTO n FROM public.guest_players g
    WHERE g.trainer_id IS NULL AND g.academy_profile_id IS NULL;
  RAISE NOTICE 'guests with NO owner (violates intent): %', n;

  -- 5. Removed-but-active anomalies
  SELECT count(*) INTO n FROM public.academy_player_metadata m
    JOIN public.bookings b ON b.guest_player_id = m.guest_player_id
    JOIN public.availability_slots s ON s.id = b.slot_id
    WHERE m.removed_at IS NOT NULL
      AND b.status IN ('confirmed')
      AND s.start_time > now();
  RAISE NOTICE 'removed players with FUTURE confirmed bookings: %', n;

  -- 6. Cycle/slot temporal sanity
  SELECT count(*) INTO n FROM public.cycles c
    WHERE c.start_date IS NOT NULL AND c.end_date IS NOT NULL AND c.end_date < c.start_date;
  RAISE NOTICE 'cycles ending before they start: %', n;

  SELECT count(*) INTO n FROM public.availability_slots s
    WHERE s.start_time IS NOT NULL AND s.end_time IS NOT NULL AND s.end_time <= s.start_time;
  RAISE NOTICE 'slots ending at/before start: %', n;

  RAISE NOTICE '=== end data invariants audit ===';
EXCEPTION WHEN others THEN
  -- Never fail a deploy over the audit itself; report and continue.
  RAISE NOTICE 'data invariants audit aborted: %', SQLERRM;
END $$;
