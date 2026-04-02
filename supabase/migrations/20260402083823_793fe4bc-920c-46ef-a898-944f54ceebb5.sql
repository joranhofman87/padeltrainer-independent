
CREATE OR REPLACE FUNCTION public.link_guest_invoices_on_signup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _linked boolean := false;
  _guest record;
BEGIN
  -- Pass 1: Match by email
  UPDATE invoices i
  SET player_id = NEW.id
  FROM guest_players gp
  WHERE i.guest_player_id = gp.id
    AND lower(gp.email) = lower(NEW.email)
    AND i.player_id IS NULL;
  
  IF FOUND THEN _linked := true; END IF;

  UPDATE bookings b
  SET player_id = NEW.id
  FROM guest_players gp
  WHERE b.guest_player_id = gp.id
    AND lower(gp.email) = lower(NEW.email)
    AND b.player_id IS NULL;

  IF FOUND THEN _linked := true; END IF;

  UPDATE guest_players
  SET linked_profile_id = NEW.id
  WHERE lower(email) = lower(NEW.email)
    AND linked_profile_id IS NULL;

  IF FOUND THEN _linked := true; END IF;

  -- Pass 2: Match by linked_profile_id (for manually linked guests without email)
  UPDATE invoices i
  SET player_id = NEW.id
  FROM guest_players gp
  WHERE i.guest_player_id = gp.id
    AND gp.linked_profile_id = NEW.id
    AND i.player_id IS NULL;

  IF FOUND THEN _linked := true; END IF;

  UPDATE bookings b
  SET player_id = NEW.id
  FROM guest_players gp
  WHERE b.guest_player_id = gp.id
    AND gp.linked_profile_id = NEW.id
    AND b.player_id IS NULL;

  IF FOUND THEN _linked := true; END IF;

  -- Auto-assign player role if any guest data was linked
  IF _linked THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.user_id, 'player')
    ON CONFLICT (user_id, role) DO NOTHING;
  END IF;

  -- Auto-follow trainers for any linked guest players
  FOR _guest IN
    SELECT DISTINCT gp.trainer_id
    FROM guest_players gp
    WHERE gp.linked_profile_id = NEW.id
      AND gp.trainer_id IS NOT NULL
  LOOP
    INSERT INTO trainer_followers (player_id, trainer_id)
    VALUES (NEW.id, _guest.trainer_id)
    ON CONFLICT DO NOTHING;
  END LOOP;

  RETURN NEW;
END;
$function$;
