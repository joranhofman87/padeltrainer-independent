
-- Add academy manager RLS policies for proposed_assignments
CREATE POLICY "Academy managers can view proposals for academy cycles"
  ON public.proposed_assignments FOR SELECT
  USING (
    intake_request_id IN (
      SELECT ir.id FROM public.intake_requests ir
      JOIN public.cycles c ON c.id = ir.cycle_id
      WHERE c.owner_type = 'academy'
        AND public.is_academy_manager(auth.uid(), c.owner_id::uuid)
    )
  );

CREATE POLICY "Academy managers can manage proposals for academy cycles"
  ON public.proposed_assignments FOR ALL
  USING (
    intake_request_id IN (
      SELECT ir.id FROM public.intake_requests ir
      JOIN public.cycles c ON c.id = ir.cycle_id
      WHERE c.owner_type = 'academy'
        AND public.is_academy_manager(auth.uid(), c.owner_id::uuid)
    )
  );

-- One-time cleanup: delete stale proposed_assignments linked to intake_requests with status='new'
DELETE FROM public.proposed_assignments
WHERE intake_request_id IN (
  SELECT id FROM public.intake_requests WHERE status = 'new'
);
