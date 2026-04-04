
-- Merge is_marked_full into is_public: set is_public = false wherever is_marked_full = true
UPDATE availability_slots
SET is_public = false
WHERE is_marked_full = true AND is_public = true;

-- Drop the redundant column
ALTER TABLE availability_slots DROP COLUMN is_marked_full;
