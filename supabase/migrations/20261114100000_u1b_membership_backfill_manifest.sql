-- U1b — the EMPTY additive backfill manifest: the logbook a future membership backfill writes into.
-- Foundation programme slice U1b (docs branch: FOUNDATION_EXECUTION_PLAN.md §U1b; owner approval
-- 2026-08-08 for "the small, additive manifest/checkpoint database object needed for the rehearsal").
--
-- WHY THIS EXISTS AT ALL. U1a pinned `academy_player_memberships` to exactly five columns, so a
-- backfill cannot record its own provenance there. Without provenance the U1c rollback ("delete only
-- the rows this backfill wrote", never TRUNCATE — later units may legitimately own membership rows)
-- has nothing to aim at, and a resumed run cannot tell "I already wrote this" from "someone else did".
-- These two tables are that record: planned size + hashes + status on the run, and one durable line
-- per canonical pair the run touched.
--
-- INERT IN U1b. Nothing populates these tables outside the local PGlite/CI rehearsal. No reader, no
-- writer, no scheduled job. The real production backfill is a separate owner gate (U1c).
--
-- Access: default-deny from creation, identical idiom to U1a — RLS ENABLED with ZERO policies (the
-- absence of a policy IS the control), plus a named-role REVOKE, which is load-bearing here because
-- this project's ALTER DEFAULT PRIVILEGES auto-grants table privileges to anon/authenticated/
-- service_role BY NAME and service_role additionally carries BYPASSRLS. A bare REVOKE FROM PUBLIC
-- would leave all three grants in place. `supabase/seed.sql` re-grants after every reset, so the
-- deny-list entries appended there are part of this lockdown, not an optimisation.

CREATE TABLE public.membership_backfill_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The plan this run is pinned to. A resume recomputes the plan from the live data and REFUSES
  -- unless the hash still matches, so an interrupted run can never silently finish against a
  -- different candidate set than it started from.
  plan_hash text NOT NULL,
  -- Output-shape version of the inventory that produced the plan. Comparing hashes across shapes is
  -- meaningless, so the shape travels with the hash.
  inventory_version text NOT NULL,
  -- The inventory's fixed snapshot parameter — never now(). Two runs at the same as_of over unchanged
  -- sources must produce the same plan_hash.
  as_of timestamptz NOT NULL,

  planned_row_count integer NOT NULL CHECK (planned_row_count >= 0),
  batch_size integer NOT NULL CHECK (batch_size > 0),

  status text NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'completed', 'aborted')),

  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- A terminal run must record when it stopped; a live one must not pretend it has.
  CONSTRAINT membership_backfill_runs_completion_consistent
    CHECK ((status = 'in_progress') = (completed_at IS NULL))
);

CREATE TABLE public.membership_backfill_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  run_id uuid NOT NULL
    REFERENCES public.membership_backfill_runs(id) ON DELETE CASCADE,

  -- The canonical pair, recorded as plain columns. Deliberately NO foreign keys to academy_profiles /
  -- persons / academy_player_memberships: this is a LOG, and a log that cascades away with the row it
  -- describes cannot serve as the rollback record. `membership_id` is likewise an unenforced pointer —
  -- after a rollback deletes the membership row, the line documenting that it existed must survive.
  academy_profile_id uuid NOT NULL,
  person_id uuid NOT NULL,
  membership_id uuid,

  batch_seq integer NOT NULL CHECK (batch_seq >= 0),

  -- 'inserted'       — this run created the membership row, so this run owns it for rollback.
  -- 'already_present'— the pair already existed (an earlier run, or a later unit). Recorded so the
  --                    reconciliation adds up, and NEVER deleted by this run's rollback.
  outcome text NOT NULL CHECK (outcome IN ('inserted', 'already_present')),

  created_at timestamptz NOT NULL DEFAULT now(),

  -- Exactly-once per run: the applier's insert of the item is what makes a pair "done", so this
  -- constraint is the double-processing guard, not merely a tidiness rule.
  CONSTRAINT membership_backfill_items_run_pair_key
    UNIQUE (run_id, academy_profile_id, person_id),

  -- An inserted row must say WHICH row it inserted, or rollback cannot find it. An already-present
  -- line may also carry the id it found, so only the 'inserted' direction is constrained.
  CONSTRAINT membership_backfill_items_inserted_has_membership
    CHECK (outcome <> 'inserted' OR membership_id IS NOT NULL)
);

-- Resume reads "every item of this run" on every hop; without this it degrades to a full scan of the
-- log as the run progresses.
CREATE INDEX idx_membership_backfill_items_run
  ON public.membership_backfill_items (run_id, batch_seq);

-- Rollback and reconciliation both enter by the canonical pair.
CREATE INDEX idx_membership_backfill_items_pair
  ON public.membership_backfill_items (academy_profile_id, person_id);

CREATE TRIGGER update_membership_backfill_runs_updated_at
  BEFORE UPDATE ON public.membership_backfill_runs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.membership_backfill_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_backfill_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.membership_backfill_runs FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.membership_backfill_items FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.membership_backfill_runs IS
  'U1b backfill logbook (run level): one row per membership-backfill run, pinned to the plan_hash it started from so a resume refuses a drifted plan. EMPTY and inert outside the local/CI rehearsal; the production backfill is the separately gated U1c. Default-deny: RLS on, zero policies, all named-role privileges revoked.';

COMMENT ON TABLE public.membership_backfill_items IS
  'U1b backfill logbook (row level): one durable line per canonical (academy, person) pair a run touched, recording whether the run INSERTED the membership row (and therefore owns it for rollback) or found it already present. Intentionally FK-free to academy_player_memberships so the log outlives the rows it describes. EMPTY and inert outside the local/CI rehearsal.';
