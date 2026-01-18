-- Add require_booking_approval setting to trainer_profiles
ALTER TABLE public.trainer_profiles
ADD COLUMN IF NOT EXISTS require_booking_approval BOOLEAN DEFAULT false;

-- Update bookings status to include new values
-- First, drop the existing constraint if it exists
ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_status_check;

-- Add the updated constraint with new status values
ALTER TABLE public.bookings ADD CONSTRAINT bookings_status_check 
CHECK (status IN ('pending', 'pending_approval', 'confirmed', 'cancelled', 'completed', 'rejected'));

-- Add index for efficient querying of pending_approval bookings
CREATE INDEX IF NOT EXISTS idx_bookings_status_pending_approval 
ON public.bookings(status) WHERE status = 'pending_approval';