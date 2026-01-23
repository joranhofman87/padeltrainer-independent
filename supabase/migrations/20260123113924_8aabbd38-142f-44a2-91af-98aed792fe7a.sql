-- Add performance indexes for frequently queried columns

-- Index for availability_slots.start_time (critical for calendar queries)
CREATE INDEX IF NOT EXISTS idx_availability_slots_start_time 
ON public.availability_slots (start_time);

-- Composite index for trainer + start_time queries (common in calendar views)
CREATE INDEX IF NOT EXISTS idx_availability_slots_trainer_start 
ON public.availability_slots (trainer_id, start_time);

-- Index for bookings.slot_id (used in joins)
CREATE INDEX IF NOT EXISTS idx_bookings_slot_id 
ON public.bookings (slot_id);

-- Index for bookings by player (used in player dashboard)
CREATE INDEX IF NOT EXISTS idx_bookings_player_id 
ON public.bookings (player_id);

-- Composite index for bookings status filtering
CREATE INDEX IF NOT EXISTS idx_bookings_status 
ON public.bookings (status);

-- Index for lessons by trainer
CREATE INDEX IF NOT EXISTS idx_lessons_trainer_id 
ON public.lessons (trainer_id);

-- Index for lessons active status
CREATE INDEX IF NOT EXISTS idx_lessons_active 
ON public.lessons (is_active) WHERE is_active = true;

-- Index for cycles by owner
CREATE INDEX IF NOT EXISTS idx_cycles_owner 
ON public.cycles (owner_type, owner_id);

-- Index for intake_requests by cycle
CREATE INDEX IF NOT EXISTS idx_intake_requests_cycle 
ON public.intake_requests (cycle_id);

-- Index for intake_requests by player
CREATE INDEX IF NOT EXISTS idx_intake_requests_player 
ON public.intake_requests (player_id);

-- Index for profiles by user_id (common lookup)
CREATE INDEX IF NOT EXISTS idx_profiles_user_id 
ON public.profiles (user_id);

-- Index for trainer_profiles by user_id
CREATE INDEX IF NOT EXISTS idx_trainer_profiles_user_id 
ON public.trainer_profiles (user_id);

-- Index for guest_players by trainer
CREATE INDEX IF NOT EXISTS idx_guest_players_trainer 
ON public.guest_players (trainer_id);

-- Index for reviews by trainer
CREATE INDEX IF NOT EXISTS idx_reviews_trainer 
ON public.reviews (trainer_id);

-- Index for invoices by trainer
CREATE INDEX IF NOT EXISTS idx_invoices_trainer 
ON public.invoices (trainer_id);