-- Add discount and pricing columns to bookings table
ALTER TABLE public.bookings
ADD COLUMN IF NOT EXISTS discount_amount NUMERIC DEFAULT 0,
ADD COLUMN IF NOT EXISTS discount_reason TEXT,
ADD COLUMN IF NOT EXISTS original_amount NUMERIC;

-- Add comment for documentation
COMMENT ON COLUMN public.bookings.original_amount IS 'Calculated price before any discount based on hourly rate × duration';
COMMENT ON COLUMN public.bookings.discount_amount IS 'Amount discounted in euros';
COMMENT ON COLUMN public.bookings.discount_reason IS 'Optional reason for the discount';