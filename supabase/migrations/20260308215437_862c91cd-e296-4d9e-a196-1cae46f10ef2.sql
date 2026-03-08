ALTER TABLE availability_slots
  ADD COLUMN rating_system text DEFAULT NULL,
  ADD COLUMN min_rating numeric DEFAULT NULL,
  ADD COLUMN max_rating numeric DEFAULT NULL;

COMMENT ON COLUMN availability_slots.rating_system IS 'Rating system code (e.g. knltb, playtomic)';
COMMENT ON COLUMN availability_slots.min_rating IS 'Minimum player rating for this slot (inclusive)';
COMMENT ON COLUMN availability_slots.max_rating IS 'Maximum player rating for this slot (inclusive)';