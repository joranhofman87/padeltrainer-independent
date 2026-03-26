
-- Make player_id nullable on intake_requests
ALTER TABLE public.intake_requests ALTER COLUMN player_id DROP NOT NULL;

-- Add guest_player_id column
ALTER TABLE public.intake_requests 
  ADD COLUMN guest_player_id uuid REFERENCES public.guest_players(id);

-- Add validation trigger: at least one of player_id or guest_player_id must be set
CREATE OR REPLACE FUNCTION public.validate_intake_request_player()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.player_id IS NULL AND NEW.guest_player_id IS NULL THEN
    RAISE EXCEPTION 'Either player_id or guest_player_id must be set';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_intake_request_player
  BEFORE INSERT OR UPDATE ON public.intake_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_intake_request_player();

-- Add RLS policy for guest_player_id lookups
CREATE POLICY "Service role can manage intake requests with guest players"
  ON public.intake_requests
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
