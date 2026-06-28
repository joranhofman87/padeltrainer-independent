-- ============================================================================
-- RECONCILIATION — TSO cycle-edit invoice bugs (READ-ONLY, no writes)
-- ============================================================================
-- Sizes live exposure from the P0 bugs documented in
--   docs/audits/TSO_INVOICE_WRITES_AUDIT.md
-- Run in the Supabase SQL editor on Padeltrainer-production (it runs as a
-- privileged role, so it sees all academies' invoices). Every statement is a
-- pure SELECT — safe to run, changes nothing.
--
-- Scope: only UNPAID invoices (draft/sent/overdue) on cyclus-type cycles can be
-- touched by the buggy writes; paid/cancelled invoices are excluded everywhere.
-- ----------------------------------------------------------------------------

-- Q0. HEADLINE — one row sizing the whole exposure.
WITH unpaid AS (
  SELECT i.*
  FROM invoices i
  JOIN cycles c ON c.id = i.cycle_id AND c.type = 'cyclus'
  WHERE i.status IN ('draft','sent','overdue')
),
a1 AS ( -- A1: non-split invoice whose booking_ids span >1 distinct player
  SELECT u.id
  FROM unpaid u
  LEFT JOIN LATERAL unnest(u.booking_ids) AS bid(id) ON true
  LEFT JOIN bookings b ON b.id = bid.id AND b.status <> 'cancelled'
  WHERE COALESCE(u.split_count, 1) = 1
  GROUP BY u.id
  HAVING count(DISTINCT COALESCE(b.player_id::text, b.guest_player_id::text)) > 1
),
b2 AS ( -- B2: split invoice (split_count>1) with no "(1/N)" marker in any line
  SELECT u.id
  FROM unpaid u
  WHERE COALESCE(u.split_count, 1) > 1
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(u.line_items::jsonb) li
      WHERE (li->>'description') ~ '\(1/[0-9]+\)'
    )
),
b3 AS ( -- B3: total must equal subtotal + vat_amount
  SELECT u.id FROM unpaid u
  WHERE abs(u.total - (u.subtotal + u.vat_amount)) > 0.005
)
SELECT
  (SELECT count(*) FROM unpaid)                                   AS unpaid_cyclus_invoices,
  (SELECT count(*) FROM a1)                                       AS a1_multiplayer_single_invoices,
  (SELECT count(*) FROM b2)                                       AS b2_split_missing_marker,
  (SELECT count(*) FROM b3)                                       AS b3_total_not_subtotal_plus_vat,
  (SELECT count(DISTINCT id) FROM (
     SELECT id FROM a1 UNION SELECT id FROM b2 UNION SELECT id FROM b3) z) AS distinct_affected_invoices;

-- Q1. Population by status (the at-risk set).
SELECT i.status, count(*) AS n, round(sum(i.total)::numeric, 2) AS total_eur
FROM invoices i
JOIN cycles c ON c.id = i.cycle_id AND c.type = 'cyclus'
WHERE i.status IN ('draft','sent','overdue')
GROUP BY i.status
ORDER BY i.status;

-- Q2. BUG A1 (P0) — misrouted booking_ids. A NON-split invoice should bill ONE
--     player; >1 distinct player means the broken matcher merged another
--     player's new bookings in (that customer overcharged; the other unbilled).
--     These are concrete re-bill/refund candidates.
SELECT i.id, i.invoice_number, i.status, i.trainer_id, i.academy_profile_id,
       count(DISTINCT COALESCE(b.player_id::text, b.guest_player_id::text)) AS distinct_players,
       coalesce(array_length(i.booking_ids,1),0) AS n_booking_ids,
       i.total, i.updated_at
FROM invoices i
JOIN cycles c ON c.id = i.cycle_id AND c.type = 'cyclus'
LEFT JOIN LATERAL unnest(i.booking_ids) AS bid(id) ON true
LEFT JOIN bookings b ON b.id = bid.id AND b.status <> 'cancelled'
WHERE i.status IN ('draft','sent','overdue')
  AND COALESCE(i.split_count, 1) = 1
GROUP BY i.id
HAVING count(DISTINCT COALESCE(b.player_id::text, b.guest_player_id::text)) > 1
ORDER BY i.total DESC
LIMIT 200;

-- Q3. BUG B2 (P0) — split invoice re-priced at FULL (N× overcharge). split_count
--     > 1 but no "(1/N)" marker in any line item → if Write B re-derived it, the
--     session line was priced at the unsplit amount.
SELECT i.id, i.invoice_number, i.status, i.split_count, i.total,
       i.trainer_id, i.academy_profile_id, i.updated_at
FROM invoices i
JOIN cycles c ON c.id = i.cycle_id AND c.type = 'cyclus'
WHERE i.status IN ('draft','sent','overdue')
  AND COALESCE(i.split_count, 1) > 1
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(i.line_items::jsonb) li
    WHERE (li->>'description') ~ '\(1/[0-9]+\)'
  )
ORDER BY i.total DESC
LIMIT 200;

-- Q4. BUG B3 (P0/P1) — internally inconsistent total. total MUST equal
--     subtotal + vat_amount; any failure is a definitively corrupted invoice.
SELECT i.id, i.invoice_number, i.status, i.trainer_id, i.academy_profile_id,
       i.subtotal, i.vat_amount, i.total,
       round((i.total - (i.subtotal + i.vat_amount))::numeric, 2) AS drift_eur,
       i.updated_at
FROM invoices i
JOIN cycles c ON c.id = i.cycle_id AND c.type = 'cyclus'
WHERE i.status IN ('draft','sent','overdue')
  AND abs(i.total - (i.subtotal + i.vat_amount)) > 0.005
ORDER BY abs(i.total - (i.subtotal + i.vat_amount)) DESC
LIMIT 200;

-- NOTE — what this does NOT catch: A1/B1 corruptions that produce a
-- *self-consistent* but wrong total (e.g. line_items[1..n] dropped, leaving
-- total = subtotal + vat yet under-billed). Detecting those requires recomputing
-- the canonical total per invoice (buildCycleLineItems + calculateVatTotals) and
-- comparing — a follow-up Node reconciliation that needs a service-role key
-- (the local .env only has the publishable/anon key, which is RLS-gated).
