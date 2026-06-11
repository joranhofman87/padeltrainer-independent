-- AUDIT (read-only) drill-down: classify the 159 line-item-sum mismatches and
-- confirm the both-ids bookings are the designed account-link flow.
-- Counts/buckets only — no PII, never mutates, never fails.

DO $$
DECLARE
  n integer;
  r record;
BEGIN
  RAISE NOTICE '=== drill-down: invoice line-item mismatches ===';

  -- bucket by how the sum relates to totals
  FOR r IN
    WITH sums AS (
      SELECT i.id, i.total, i.subtotal, i.vat_amount, i.prices_include_vat,
             i.academy_profile_id IS NOT NULL AS is_academy,
             i.created_at::date AS d,
             (SELECT coalesce(sum((li->>'amount')::numeric), 0)
              FROM jsonb_array_elements(i.line_items) li
              WHERE (li->>'amount') ~ '^-?[0-9.]+$') AS li_sum,
             (SELECT count(*) FROM jsonb_array_elements(i.line_items) li
              WHERE li ? 'amount' IS FALSE) AS items_missing_amount
      FROM public.invoices i
      WHERE jsonb_typeof(i.line_items) = 'array'
    ),
    mismatched AS (
      SELECT * FROM sums
      WHERE abs(li_sum - total) > 0.02 AND abs(li_sum - subtotal) > 0.02
    )
    SELECT
      CASE
        WHEN items_missing_amount > 0 THEN 'line items missing amount field'
        WHEN abs(li_sum - (total - vat_amount)) <= 0.02 THEN 'sum = total - vat (excl-vat amounts)'
        WHEN abs(li_sum * 1.21 - total) <= 0.02 THEN 'sum*1.21 = total (amounts excl, 21pct)'
        WHEN li_sum = 0 THEN 'line amounts all zero/absent'
        WHEN li_sum > total THEN 'sum ABOVE total'
        ELSE 'sum BELOW total (other)'
      END AS bucket,
      count(*) AS cnt,
      min(d) AS first_seen, max(d) AS last_seen,
      sum(CASE WHEN is_academy THEN 1 ELSE 0 END) AS academy_cnt
    FROM mismatched
    GROUP BY 1 ORDER BY cnt DESC
  LOOP
    RAISE NOTICE 'bucket "%": % invoices (academy: %), % .. %',
      r.bucket, r.cnt, r.academy_cnt, r.first_seen, r.last_seen;
  END LOOP;

  RAISE NOTICE '=== drill-down: both-ids bookings ===';
  -- expected: guest bookings later linked to a profile (claim flow keeps both)
  SELECT count(*) INTO n
  FROM public.bookings b
  JOIN public.guest_players g ON g.id = b.guest_player_id
  WHERE b.player_id IS NOT NULL
    AND g.linked_profile_id = b.player_id;
  RAISE NOTICE 'both-ids bookings where player_id = guest''s linked profile (designed claim flow): %', n;

  SELECT count(*) INTO n
  FROM public.bookings b
  JOIN public.guest_players g ON g.id = b.guest_player_id
  WHERE b.player_id IS NOT NULL
    AND (g.linked_profile_id IS NULL OR g.linked_profile_id <> b.player_id);
  RAISE NOTICE 'both-ids bookings where player_id does NOT match guest link (anomaly): %', n;

  RAISE NOTICE '=== end drill-down ===';
EXCEPTION WHEN others THEN
  RAISE NOTICE 'drill-down aborted: %', SQLERRM;
END $$;
