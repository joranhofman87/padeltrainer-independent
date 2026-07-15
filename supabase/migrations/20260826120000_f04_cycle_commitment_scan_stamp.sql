-- F04 (audit, CRITICAL — scalability ceiling): generate-cycle-commitment-invoices scanned EVERY
-- open/closed cycle platform-wide with no pagination, no order, and no "already processed" cutoff.
-- At scale PostgREST's 1000-row cap silently truncated the list (cycles past row 1000 never
-- invoiced → committed players never billed), and even the visited prefix blew the isolate
-- wall-clock, so the tail was never reached on any day.
--
-- This stamp lets a fully-processed cycle DROP OUT of the daily scan: the job sets it once a cycle
-- has no further deferred commitment-invoicing work (all cycle-start committers drafted with no
-- failed batch, or the cycle is upfront-mode / has no commitments). The scan then filters
-- commitment_invoiced_at IS NULL, so the daily work shrinks to genuinely-new cycles instead of
-- re-walking every cycle ever started. Combined with keyset pagination + a self-reinvoke
-- continuation in the edge function, every due cycle is visited and no committed revenue ages out.
ALTER TABLE public.cycles
  ADD COLUMN IF NOT EXISTS commitment_invoiced_at timestamptz;

COMMENT ON COLUMN public.cycles.commitment_invoiced_at IS
  'F04: stamped by generate-cycle-commitment-invoices once the cycle has no further deferred commitment-invoicing work (all cycle-start committers drafted with no failure, or upfront/no-commitment). The scan skips stamped cycles so it no longer re-walks every started cycle daily. Cleared is NULL = still in scope.';

-- Partial index backing the keyset scan `WHERE commitment_invoiced_at IS NULL ... AND id > cursor
-- ORDER BY id`: only the still-in-scope cycles are indexed, so the scan cost tracks the unprocessed
-- backlog, not the all-time cycle count.
CREATE INDEX IF NOT EXISTS idx_cycles_commitment_scan
  ON public.cycles (id)
  WHERE commitment_invoiced_at IS NULL;
