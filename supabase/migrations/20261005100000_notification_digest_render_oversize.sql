-- PR 10c-a3 (worker prerequisites) — TWO coupled forward-only changes the worker needs, both still INERT:
--
-- (A) FROZEN-REQUEST v2 — freeze the sender identity. The 10c-a2 allow-list was exactly {to,subject,html}; the
--     'from' was injected by the adapter from a runtime default, so a deploy that changed it during the 23-hour
--     idempotency window would alter the outgoing request WITHOUT changing frozen_request/request_hash (same
--     dg:v1 key, different parameters). We add 'from' to the allow-list so the COMPLETE provider request is
--     frozen + hashed. The one validator is SPLIT so the byte ceiling is separable: notif_digest_validate_
--     frozen_request_shape (object + {from,to,subject,html} allow-list + non-empty + to↔fingerprint, NO byte
--     cap) and notif_digest_validate_frozen_request (= shape + ≤90 KB, unchanged behaviour for store/guard).
--
-- (B) HARDENED oversize finalizer. The round-1 version terminalized any single-item prepared/request_ready
--     group on the worker's say-so — it never PROVED the render was oversize, and allowing request_ready could
--     abandon reservations a prior ambiguous attempt retained. The worker now passes the authoritative rendered
--     request; the RPC proves it server-side: exactly-'prepared', exactly one surviving member, a valid
--     schema+destination (shape), and octet_length(jsonb::text) > 92160. Small / multi-item / zero-item /
--     request_ready calls all fail. This runs AFTER 20261004100000 (deployed) and BEFORE the hash-fix
--     migration (20261005110000), whose store/guard re-declarations call the 4-key validator by name.
--
-- No worker is scheduled, no digest event is enabled — nothing here sends.

-- ── (A) shape validator (no byte cap) — the {from,to,subject,html} allow-list + destination proof ──────────
CREATE OR REPLACE FUNCTION public.notif_digest_validate_frozen_request_shape(
    p_frozen jsonb, p_destination_fingerprint text)
  RETURNS void LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_frozen IS NULL OR jsonb_typeof(p_frozen) <> 'object'
     OR jsonb_typeof(p_frozen->'from') <> 'string' OR length(p_frozen->>'from') = 0
     OR jsonb_typeof(p_frozen->'to') <> 'string' OR length(p_frozen->>'to') = 0
     OR jsonb_typeof(p_frozen->'subject') <> 'string' OR length(p_frozen->>'subject') = 0
     OR jsonb_typeof(p_frozen->'html') <> 'string' OR length(p_frozen->>'html') = 0 THEN
    RAISE EXCEPTION 'frozen request malformed (need an object with non-empty from/to/subject/html)';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_frozen) AS k(key) WHERE k.key NOT IN ('from','to','subject','html')) THEN
    RAISE EXCEPTION 'frozen request carries a key outside the from/to/subject/html allow-list';
  END IF;
  IF notif_digest_destination_fingerprint(p_frozen->>'to') <> p_destination_fingerprint THEN
    RAISE EXCEPTION 'frozen request destination does not match the group fingerprint';
  END IF;
END $$;

-- the byte-bounded validator store + the send-identity guard call: shape + the 90 KB store budget.
CREATE OR REPLACE FUNCTION public.notif_digest_validate_frozen_request(p_frozen jsonb, p_destination_fingerprint text)
  RETURNS void LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  PERFORM notif_digest_validate_frozen_request_shape(p_frozen, p_destination_fingerprint);
  IF octet_length(p_frozen::text) > 92160 THEN
    RAISE EXCEPTION 'frozen request exceeds the 90 KB budget (% bytes)', octet_length(p_frozen::text);
  END IF;
END $$;

-- helpers run only inside SECURITY DEFINER RPCs (owner context) — no API role needs EXECUTE (matches §13).
REVOKE ALL ON FUNCTION public.notif_digest_validate_frozen_request_shape(jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.notif_digest_validate_frozen_request(jsonb, text) FROM PUBLIC, anon, authenticated, service_role;

-- ── (B) hardened oversize finalizer — proves oversize server-side from the authoritative rendered request ──
-- The round-1 signature (no frozen request) is superseded; drop it so only the proving version exists.
DROP FUNCTION IF EXISTS public.finalize_notification_digest_render_oversize(uuid, uuid, text, timestamptz);

CREATE OR REPLACE FUNCTION public.finalize_notification_digest_render_oversize(
    p_run_id uuid, p_group_id uuid, p_worker text, p_frozen_request jsonb, p_now timestamptz)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE g record;
BEGIN
  -- exactly 'prepared' (NOT request_ready — a retried group can hold reservations that terminalizing would
  -- strand), owned by this worker+run. A request_ready / leased / terminal / unowned group is rejected.
  SELECT * INTO g FROM public.notification_digest_groups
   WHERE id = p_group_id AND state = 'prepared' AND locked_by = p_worker AND worker_run_id = p_run_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'render_oversize: group % not owned/prepared by % (run %)', p_group_id, p_worker, p_run_id;
  END IF;
  PERFORM notif_digest_assert_run(p_run_id, 'dispatch', g.channel);
  -- exactly one surviving member — a multi-item group is reducible and MUST split, never terminalize.
  IF g.item_count <> 1 THEN
    RAISE EXCEPTION 'render_oversize: group % has % members; only a single item may terminalize (else split)', p_group_id, g.item_count;
  END IF;
  -- PROVE the render is genuinely oversize + well-formed + correctly addressed, server-side. This is the
  -- authoritative rendered request the worker just built; validate its schema/destination (no byte cap) then
  -- require it to exceed the 90 KB store budget. A tiny or forged request cannot terminalize a group here.
  PERFORM notif_digest_validate_frozen_request_shape(p_frozen_request, g.destination_fingerprint);
  IF octet_length(p_frozen_request::text) <= 92160 THEN
    RAISE EXCEPTION 'render_oversize: request is % bytes (<= 90 KB) — not oversize, must not terminalize', octet_length(p_frozen_request::text);
  END IF;
  PERFORM notif_digest_finalize_group(p_group_id, 'oversize_failed', 'render_oversize', p_now);
  PERFORM notif_digest_ledger(p_run_id, p_group_id, NULL, 'oversize_failed', 0);
END $$;

-- ACL: operational entrypoint — service_role EXECUTE only.
REVOKE ALL ON FUNCTION public.finalize_notification_digest_render_oversize(uuid, uuid, text, jsonb, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_notification_digest_render_oversize(uuid, uuid, text, jsonb, timestamptz)
  TO service_role;
