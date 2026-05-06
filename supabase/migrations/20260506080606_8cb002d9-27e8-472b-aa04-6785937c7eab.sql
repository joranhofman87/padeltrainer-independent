
-- Add priority window columns to availability_slots
ALTER TABLE public.availability_slots
  ADD COLUMN IF NOT EXISTS priority_window_starts_at timestamptz,
  ADD COLUMN IF NOT EXISTS priority_window_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS priority_source_slot_id uuid REFERENCES public.availability_slots(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_availability_slots_priority_window_ends
  ON public.availability_slots(priority_window_ends_at)
  WHERE priority_window_ends_at IS NOT NULL;

-- slot_priority_claims table
CREATE TABLE IF NOT EXISTS public.slot_priority_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id uuid NOT NULL REFERENCES public.availability_slots(id) ON DELETE CASCADE,
  player_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  guest_player_id uuid REFERENCES public.guest_players(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','claimed','declined','expired','released')),
  claim_token text NOT NULL UNIQUE DEFAULT (encode(gen_random_bytes(24), 'hex')),
  invited_at timestamptz,
  responded_at timestamptz,
  decline_reason text,
  source_slot_id uuid REFERENCES public.availability_slots(id) ON DELETE SET NULL,
  booking_id uuid REFERENCES public.bookings(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slot_priority_claims_player_or_guest
    CHECK ((player_id IS NOT NULL) OR (guest_player_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_slot_priority_claims_slot_player
  ON public.slot_priority_claims(slot_id, player_id) WHERE player_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_slot_priority_claims_slot_guest
  ON public.slot_priority_claims(slot_id, guest_player_id) WHERE guest_player_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_slot_priority_claims_slot ON public.slot_priority_claims(slot_id);
CREATE INDEX IF NOT EXISTS idx_slot_priority_claims_player ON public.slot_priority_claims(player_id);
CREATE INDEX IF NOT EXISTS idx_slot_priority_claims_status ON public.slot_priority_claims(status);

CREATE TRIGGER trg_slot_priority_claims_updated
  BEFORE UPDATE ON public.slot_priority_claims
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.slot_priority_claims ENABLE ROW LEVEL SECURITY;

-- Trainer/academy/club managers who own the slot can manage claims
CREATE POLICY "Slot owners manage priority claims"
  ON public.slot_priority_claims
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.availability_slots s
      LEFT JOIN public.trainer_profiles tp ON tp.id = s.trainer_id
      WHERE s.id = slot_priority_claims.slot_id
        AND (
          tp.user_id = auth.uid()
          OR (s.academy_profile_id IS NOT NULL
              AND s.academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid())))
          OR (s.location_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM public.club_profiles cp
                WHERE cp.location_id = s.location_id
                  AND cp.id IN (SELECT public.get_user_club_ids(auth.uid()))
              ))
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.availability_slots s
      LEFT JOIN public.trainer_profiles tp ON tp.id = s.trainer_id
      WHERE s.id = slot_priority_claims.slot_id
        AND (
          tp.user_id = auth.uid()
          OR (s.academy_profile_id IS NOT NULL
              AND s.academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid())))
          OR (s.location_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM public.club_profiles cp
                WHERE cp.location_id = s.location_id
                  AND cp.id IN (SELECT public.get_user_club_ids(auth.uid()))
              ))
        )
    )
  );

-- Players can read their own claims
CREATE POLICY "Players read own priority claims"
  ON public.slot_priority_claims
  FOR SELECT
  TO authenticated
  USING (
    player_id = public.get_profile_id_for_user(auth.uid())
  );

-- Public claim lookup by token
CREATE OR REPLACE FUNCTION public.get_priority_claim_by_token(_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'claim', to_jsonb(c.*),
    'slot', jsonb_build_object(
      'id', s.id,
      'start_time', s.start_time,
      'end_time', s.end_time,
      'cyclus_id', s.cyclus_id,
      'cyclus_name', s.cyclus_name,
      'location_id', s.location_id,
      'price_per_session', s.price_per_session,
      'total_price', s.total_price,
      'max_participants', s.max_participants,
      'priority_window_ends_at', s.priority_window_ends_at,
      'trainer_id', s.trainer_id,
      'academy_profile_id', s.academy_profile_id
    ),
    'player_name', COALESCE(p.full_name, gp.full_name),
    'player_email', COALESCE(p.email, gp.email)
  )
  INTO result
  FROM public.slot_priority_claims c
  JOIN public.availability_slots s ON s.id = c.slot_id
  LEFT JOIN public.profiles p ON p.id = c.player_id
  LEFT JOIN public.guest_players gp ON gp.id = c.guest_player_id
  WHERE c.claim_token = _token
  LIMIT 1;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_priority_claim_by_token(text) TO anon, authenticated;

-- Public decline endpoint
CREATE OR REPLACE FUNCTION public.respond_to_priority_claim(_token text, _action text, _reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.slot_priority_claims;
  s public.availability_slots;
BEGIN
  IF _action NOT IN ('decline') THEN
    RAISE EXCEPTION 'Unsupported action: %', _action;
  END IF;

  SELECT * INTO c FROM public.slot_priority_claims WHERE claim_token = _token FOR UPDATE;
  IF c.id IS NULL THEN
    RAISE EXCEPTION 'Claim not found';
  END IF;

  SELECT * INTO s FROM public.availability_slots WHERE id = c.slot_id;

  IF c.status NOT IN ('pending') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_responded', 'status', c.status);
  END IF;

  IF s.priority_window_ends_at IS NOT NULL AND s.priority_window_ends_at < now() THEN
    UPDATE public.slot_priority_claims
      SET status = 'expired', responded_at = now()
      WHERE id = c.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'window_expired');
  END IF;

  UPDATE public.slot_priority_claims
    SET status = 'declined',
        responded_at = now(),
        decline_reason = _reason
    WHERE id = c.id;

  RETURN jsonb_build_object('ok', true, 'status', 'declined');
END;
$$;

GRANT EXECUTE ON FUNCTION public.respond_to_priority_claim(text, text, text) TO anon, authenticated;
