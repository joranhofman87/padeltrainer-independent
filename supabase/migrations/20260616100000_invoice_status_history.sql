-- Invoice status audit trail (data quality): WHO changed an invoice's status, WHEN,
-- from→to, and an optional WHY. Captured CENTRALLY by a trigger so it can't be bypassed —
-- invoice status is set in ~30 cancel + ~50 paid code paths (UI, bulk, edge fns), so
-- per-call-site tracking would inevitably miss one. changed_by = auth.uid() (NULL = system,
-- e.g. the Mollie webhook / send flow under service_role). Reason is annotated by the
-- deliberate cancel/mark-paid UI right after the change.

CREATE TABLE public.invoice_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  old_status text,                 -- NULL on creation
  new_status text,
  changed_by uuid,                 -- auth.uid(); NULL = system / service_role action
  changed_at timestamptz NOT NULL DEFAULT now(),
  reason text
);
CREATE INDEX invoice_status_history_by_invoice ON public.invoice_status_history (invoice_id, changed_at DESC);

ALTER TABLE public.invoice_status_history ENABLE ROW LEVEL SECURITY;
-- No direct client access: the trigger (definer) writes, reads go through the definer RPC.
REVOKE ALL ON public.invoice_status_history FROM PUBLIC, anon, authenticated;

-- ── the trigger: log every status transition, from any path ──────────────────────
CREATE OR REPLACE FUNCTION public.log_invoice_status_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.invoice_status_history (invoice_id, old_status, new_status, changed_by)
    VALUES (NEW.id, NULL, NEW.status, auth.uid());
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.invoice_status_history (invoice_id, old_status, new_status, changed_by)
    VALUES (NEW.id, OLD.status, NEW.status, auth.uid());
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_log_invoice_status_change_ins
  AFTER INSERT ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.log_invoice_status_change();
CREATE TRIGGER trg_log_invoice_status_change_upd
  AFTER UPDATE OF status ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.log_invoice_status_change();

-- ── read: the timeline for an invoice (manager / owning trainer / admin) ──────────
CREATE OR REPLACE FUNCTION public.get_invoice_status_history(p_invoice_id uuid)
RETURNS TABLE (old_status text, new_status text, changed_by uuid, changed_by_name text, changed_at timestamptz, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_acad uuid; v_trainer uuid;
BEGIN
  SELECT i.academy_profile_id, i.trainer_id INTO v_acad, v_trainer FROM public.invoices i WHERE i.id = p_invoice_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT (
    (v_acad IS NOT NULL AND public.is_academy_manager(auth.uid(), v_acad))
    OR (v_trainer IS NOT NULL AND EXISTS (SELECT 1 FROM public.trainer_profiles tp WHERE tp.id = v_trainer AND tp.user_id = auth.uid()))
    OR public.is_admin(auth.uid())
  ) THEN
    RAISE EXCEPTION 'not authorized for invoice %', p_invoice_id USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT h.old_status, h.new_status, h.changed_by,
         (SELECT p.full_name FROM public.profiles p WHERE p.user_id = h.changed_by) AS changed_by_name,
         h.changed_at, h.reason
  FROM public.invoice_status_history h
  WHERE h.invoice_id = p_invoice_id
  ORDER BY h.changed_at ASC, h.id ASC;
END;
$$;
REVOKE ALL ON FUNCTION public.get_invoice_status_history(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_invoice_status_history(uuid) TO authenticated;

-- ── annotate: attach a reason to the caller's most-recent transition (last 30s) ──
CREATE OR REPLACE FUNCTION public.annotate_invoice_status_reason(p_invoice_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_acad uuid; v_trainer uuid;
BEGIN
  SELECT i.academy_profile_id, i.trainer_id INTO v_acad, v_trainer FROM public.invoices i WHERE i.id = p_invoice_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT (
    (v_acad IS NOT NULL AND public.is_academy_manager(auth.uid(), v_acad))
    OR (v_trainer IS NOT NULL AND EXISTS (SELECT 1 FROM public.trainer_profiles tp WHERE tp.id = v_trainer AND tp.user_id = auth.uid()))
    OR public.is_admin(auth.uid())
  ) THEN
    RAISE EXCEPTION 'not authorized for invoice %', p_invoice_id USING ERRCODE = '42501';
  END IF;

  UPDATE public.invoice_status_history h
     SET reason = nullif(btrim(p_reason), '')
   WHERE h.id = (
     SELECT h2.id FROM public.invoice_status_history h2
     WHERE h2.invoice_id = p_invoice_id
       AND h2.reason IS NULL
       AND h2.changed_by = auth.uid()
       AND h2.changed_at > now() - interval '30 seconds'
     ORDER BY h2.changed_at DESC, h2.id DESC
     LIMIT 1);
END;
$$;
REVOKE ALL ON FUNCTION public.annotate_invoice_status_reason(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.annotate_invoice_status_reason(uuid, text) TO authenticated;
