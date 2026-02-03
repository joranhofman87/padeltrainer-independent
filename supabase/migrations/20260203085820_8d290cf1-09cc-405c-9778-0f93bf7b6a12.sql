-- Add location and pricing to cycles table
ALTER TABLE cycles
ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS price_per_session NUMERIC(10,2),
ADD COLUMN IF NOT EXISTS total_price NUMERIC(10,2),
ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'EUR';

-- Create index for faster location lookups
CREATE INDEX IF NOT EXISTS idx_cycles_location_id ON cycles(location_id);

-- Create index for owner lookups (commonly filtered)
CREATE INDEX IF NOT EXISTS idx_cycles_owner ON cycles(owner_type, owner_id);