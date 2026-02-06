
-- Allow players to view invoices addressed to them
CREATE POLICY "Players can view their own invoices"
ON public.invoices
FOR SELECT
USING (
  player_id IS NOT NULL
  AND player_id = (SELECT id FROM profiles WHERE user_id = auth.uid())
);

-- Allow players to update billing fields on their own invoices
CREATE POLICY "Players can update billing details on their own invoices"
ON public.invoices
FOR UPDATE
USING (
  player_id IS NOT NULL
  AND player_id = (SELECT id FROM profiles WHERE user_id = auth.uid())
)
WITH CHECK (
  player_id IS NOT NULL
  AND player_id = (SELECT id FROM profiles WHERE user_id = auth.uid())
);
