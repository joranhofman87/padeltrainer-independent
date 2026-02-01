-- Add RLS policies for admins to manage reviews
CREATE POLICY "Admins can view all reviews"
ON reviews FOR SELECT
USING (is_admin(auth.uid()));

CREATE POLICY "Admins can create reviews"
ON reviews FOR INSERT
WITH CHECK (is_admin(auth.uid()));

CREATE POLICY "Admins can update any review"
ON reviews FOR UPDATE
USING (is_admin(auth.uid()));

CREATE POLICY "Admins can delete any review"
ON reviews FOR DELETE
USING (is_admin(auth.uid()));