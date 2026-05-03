CREATE OR REPLACE FUNCTION public.invoice_booking_set_key(_ids uuid[])
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT md5(array_to_string(
    (SELECT array_agg(x ORDER BY x) FROM unnest(_ids) AS x),
    ','
  ))
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoice_active_player_bookings
  ON public.invoices (
    trainer_id,
    player_id,
    public.invoice_booking_set_key(booking_ids)
  )
  WHERE status <> 'cancelled'
    AND player_id IS NOT NULL
    AND array_length(booking_ids, 1) > 0;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoice_active_guest_bookings
  ON public.invoices (
    trainer_id,
    guest_player_id,
    public.invoice_booking_set_key(booking_ids)
  )
  WHERE status <> 'cancelled'
    AND guest_player_id IS NOT NULL
    AND array_length(booking_ids, 1) > 0;