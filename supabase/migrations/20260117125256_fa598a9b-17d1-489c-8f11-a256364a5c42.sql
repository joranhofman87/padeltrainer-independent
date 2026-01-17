-- Add unique constraint to prevent duplicate emails per trainer
ALTER TABLE guest_players 
ADD CONSTRAINT unique_trainer_email UNIQUE (trainer_id, email);