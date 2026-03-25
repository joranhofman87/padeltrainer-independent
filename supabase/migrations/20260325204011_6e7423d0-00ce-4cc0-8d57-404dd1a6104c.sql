CREATE OR REPLACE FUNCTION public.link_guest_invoices_on_signup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Update invoices where guest_player has matching email
  -- Use NEW.id (profiles PK) since invoices.player_id references profiles(id)
  UPDATE invoices i
  SET player_id = NEW.id
  FROM guest_players gp
  WHERE i.guest_player_id = gp.id
    AND lower(gp.email) = lower(NEW.email)
    AND i.player_id IS NULL;
  
  -- Link bookings to the new profile
  UPDATE bookings b
  SET player_id = NEW.id
  FROM guest_players gp
  WHERE b.guest_player_id = gp.id
    AND lower(gp.email) = lower(NEW.email)
    AND b.player_id IS NULL;
  
  -- Also link the guest_player record itself
  UPDATE guest_players
  SET linked_profile_id = NEW.id
  WHERE lower(email) = lower(NEW.email)
    AND linked_profile_id IS NULL;
  
  RETURN NEW;
END;
$function$;