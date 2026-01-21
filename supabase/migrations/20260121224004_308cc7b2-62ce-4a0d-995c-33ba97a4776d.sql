-- Add indoor_courts and outdoor_courts columns to locations table
ALTER TABLE public.locations 
  ADD COLUMN IF NOT EXISTS indoor_courts integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS outdoor_courts integer DEFAULT 0;

-- Add court_type column to availability_slots (indoor, outdoor, or null for "any")
ALTER TABLE public.availability_slots 
  ADD COLUMN IF NOT EXISTS court_type text CHECK (court_type IN ('indoor', 'outdoor'));

-- Add court_type column to bookings to store what the player booked
ALTER TABLE public.bookings 
  ADD COLUMN IF NOT EXISTS court_type text CHECK (court_type IN ('indoor', 'outdoor'));

-- Update existing number_of_courts to split between indoor/outdoor if needed
COMMENT ON COLUMN public.locations.indoor_courts IS 'Number of indoor padel courts at this location';
COMMENT ON COLUMN public.locations.outdoor_courts IS 'Number of outdoor padel courts at this location';