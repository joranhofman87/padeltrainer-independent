
CREATE OR REPLACE FUNCTION public.sync_queue_email_on_profile_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.email IS DISTINCT FROM NEW.email THEN
    UPDATE onboarding_email_queue
    SET email = NEW.email
    WHERE user_id = NEW.user_id
      AND status IN ('pending', 'awaiting_confirmation');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sync_queue_email
AFTER UPDATE OF email ON profiles
FOR EACH ROW EXECUTE FUNCTION public.sync_queue_email_on_profile_update();
