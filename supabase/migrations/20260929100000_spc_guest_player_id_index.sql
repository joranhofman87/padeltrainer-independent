-- ============================================================================
-- Partial index: slot_priority_claims(guest_player_id) WHERE guest_player_id IS NOT NULL
-- ============================================================================
-- Codex round-6 #3: guests_have_rebook_contact (20260927100000) probes
--   SELECT ... FROM slot_priority_claims spc ... WHERE spc.guest_player_id = ANY($1)
-- The existing composite idx_slot_priority_claims_slot / the (slot_id, guest_player_id) shapes cannot
-- efficiently serve a GUEST-FIRST lookup (guest_player_id is not their leading column), so the probe
-- falls back to a scan as the claims table grows. This guest-keyed PARTIAL index serves it directly
-- and stays small — only rows that actually carry a guest_player_id are indexed (dual-key + guest
-- claims), never the pure-profile majority. Mirrors the idx_spc_person partial-index pattern.
-- Plain CREATE INDEX (not CONCURRENTLY) to stay inside the migration transaction, consistent with the
-- other slot_priority_claims indexes; the table is small enough that the brief lock is acceptable.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_spc_guest_player_id
  ON public.slot_priority_claims (guest_player_id)
  WHERE guest_player_id IS NOT NULL;
