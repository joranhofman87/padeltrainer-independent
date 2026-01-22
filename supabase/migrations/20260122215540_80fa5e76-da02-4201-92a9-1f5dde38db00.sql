-- Make email nullable in guest_players
ALTER TABLE public.guest_players ALTER COLUMN email DROP NOT NULL;

-- Drop the existing unique constraint on email (if it exists) 
-- and create a partial unique index that only applies to non-null emails
DROP INDEX IF EXISTS guest_players_trainer_id_email_key;
DROP INDEX IF EXISTS idx_guest_players_trainer_email;

-- Create a partial unique index: email must be unique per trainer, but only when email is not null and not empty
CREATE UNIQUE INDEX idx_guest_players_trainer_email_unique 
ON public.guest_players (trainer_id, email) 
WHERE email IS NOT NULL AND email != '';