-- Add recurring lesson fields and payment timing to lessons table
ALTER TABLE public.lessons
ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS recurrence_type TEXT, -- 'daily', 'weekly', 'monthly'
ADD COLUMN IF NOT EXISTS recurrence_day INTEGER, -- 0-6 for day of week (0 = Sunday), 1-31 for day of month
ADD COLUMN IF NOT EXISTS recurrence_time TIME, -- Time of day for recurring lessons
ADD COLUMN IF NOT EXISTS recurrence_count INTEGER, -- Number of recurring sessions
ADD COLUMN IF NOT EXISTS recurrence_end_date DATE, -- Optional end date for recurrence
ADD COLUMN IF NOT EXISTS payment_timing TEXT NOT NULL DEFAULT 'upfront'; -- 'upfront' or 'after'

-- Add constraint for payment_timing
ALTER TABLE public.lessons
ADD CONSTRAINT lessons_payment_timing_check 
CHECK (payment_timing IN ('upfront', 'after'));

-- Add constraint for recurrence_type
ALTER TABLE public.lessons
ADD CONSTRAINT lessons_recurrence_type_check 
CHECK (recurrence_type IS NULL OR recurrence_type IN ('daily', 'weekly', 'monthly'));

-- Add payment_status to bookings to track whether payment has been made
ALTER TABLE public.bookings
ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS payment_amount NUMERIC,
ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP WITH TIME ZONE;

-- Add constraint for payment_status
ALTER TABLE public.bookings
ADD CONSTRAINT bookings_payment_status_check 
CHECK (payment_status IN ('pending', 'paid', 'refunded', 'waived'));