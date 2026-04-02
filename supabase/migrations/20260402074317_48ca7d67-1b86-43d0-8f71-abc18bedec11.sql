
CREATE OR REPLACE FUNCTION public.link_guest_invoices_on_signup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _linked boolean := false;
BEGIN
  -- Update invoices where guest_player has matching email
  UPDATE invoices i
  SET player_id = NEW.id
  FROM guest_players gp
  WHERE i.guest_player_id = gp.id
    AND lower(gp.email) = lower(NEW.email)
    AND i.player_id IS NULL;
  
  IF FOUND THEN _linked := true; END IF;

  -- Link bookings to the new profile
  UPDATE bookings b
  SET player_id = NEW.id
  FROM guest_players gp
  WHERE b.guest_player_id = gp.id
    AND lower(gp.email) = lower(NEW.email)
    AND b.player_id IS NULL;

  IF FOUND THEN _linked := true; END IF;

  -- Also link the guest_player record itself
  UPDATE guest_players
  SET linked_profile_id = NEW.id
  WHERE lower(email) = lower(NEW.email)
    AND linked_profile_id IS NULL;

  IF FOUND THEN _linked := true; END IF;

  -- Auto-assign player role if any guest data was linked
  IF _linked THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.user_id, 'player')
    ON CONFLICT (user_id, role) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$function$;
