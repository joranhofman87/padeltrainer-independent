
-- Add public_token column to invoices
ALTER TABLE public.invoices ADD COLUMN public_token uuid DEFAULT gen_random_uuid() NOT NULL;

-- Backfill existing invoices
UPDATE public.invoices SET public_token = gen_random_uuid() WHERE public_token IS NULL;

-- Add unique index
CREATE UNIQUE INDEX idx_invoices_public_token ON public.invoices (public_token);

-- Trigger to link guest player invoices when a new profile is created
CREATE OR REPLACE FUNCTION public.link_guest_invoices_on_signup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Update invoices where guest_player has matching email
  UPDATE invoices i
  SET player_id = NEW.user_id
  FROM guest_players gp
  WHERE i.guest_player_id = gp.id
    AND lower(gp.email) = lower(NEW.email)
    AND i.player_id IS NULL;
  
  -- Also link the guest_player record itself
  UPDATE guest_players
  SET linked_profile_id = NEW.user_id
  WHERE lower(email) = lower(NEW.email)
    AND linked_profile_id IS NULL;
  
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_profile_created_link_guests
  AFTER INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.link_guest_invoices_on_signup();
