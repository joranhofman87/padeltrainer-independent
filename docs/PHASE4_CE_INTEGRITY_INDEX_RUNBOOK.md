# Phase 4 · C + E — cyclus_id FK + booking_ids GIN index (owner runbook)

Two additive, non-destructive migrations that harden the slots/cycles foundation.
Neither auto-deploys — apply them to the live project `ficwbdrzefmblkbkomzw` after
the PR merges. Both are idempotent (safe to re-run).

| Item | File | What it does | Risk |
|------|------|--------------|------|
| **C** | `20260630120000_phase4_C_cyclus_id_fk.sql` | Adds FK `availability_slots.cyclus_id → cycles.id` **NOT VALID**, `ON DELETE SET NULL`. Stops any NEW orphan slot group from being created. | Very low — brief metadata lock, no table scan, cannot fail on existing data. |
| **E** | `20260630120100_phase4_E_invoices_booking_ids_gin.sql` | GIN index on `invoices.booking_ids` so the invoice-sync `.overlaps()` lookups stop sequential-scanning. | Very low — sub-second build at current volume. |

## Apply (both)

```
supabase db push --project-ref ficwbdrzefmblkbkomzw
```

…or paste each file into the Supabase SQL editor. After applying, **regenerate types**
(C adds a FK relationship, so `src/integrations/supabase/types.ts` will otherwise drift):

```
supabase gen types typescript --project-ref ficwbdrzefmblkbkomzw > src/integrations/supabase/types.ts
```

> The PR already hand-adds the matching relationship entry, so the committed `types.ts`
> should match the generator and the CI drift gate should stay green. Regenerating is the
> belt-and-braces confirmation.

## C — STEP 2: clean up historical orphans + promote to VALID (do when ready)

C only *prevents new* orphans. Existing ones are left intact (non-destructive). To clean
them up and make the guarantee cover all rows, run these by hand once you're ready —
this is deliberately NOT in a migration because the repair touches real data:

1. **Pre-flight (read-only)** — how many orphan slot groups exist?
   ```sql
   SELECT count(DISTINCT s.cyclus_id) AS orphan_cycle_count,
          count(*)                    AS orphan_slot_count
   FROM public.availability_slots s
   WHERE s.cyclus_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.cycles c WHERE c.id = s.cyclus_id);
   ```
2. **Repair** — if `orphan_cycle_count > 0`, run the prepared, owner-approved, idempotent
   backfill that mints a real `cycles` row for each orphan, then re-run step 1 and confirm `0`:
   `supabase/migrations/20260612230000_rebook01_backfill_calendar_cycles.sql`
3. **Validate** — once step 1 returns `0`:
   ```sql
   ALTER TABLE public.availability_slots
     VALIDATE CONSTRAINT availability_slots_cyclus_id_fkey;
   ```

If you skip STEP 2, that's fine — C still blocks all new orphans; only the cleanup of the
old ones is deferred.

## E — zero-downtime alternative (only if invoices is large)

The migration uses a plain `CREATE INDEX` (transaction-safe, so CI and `db push` apply it
cleanly). If the production invoices table is big enough that a brief write-lock matters,
build it without a lock FIRST (must run on its own, outside a transaction), then apply the
migration (its `IF NOT EXISTS` no-ops):

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoices_booking_ids_gin
  ON public.invoices USING gin (booking_ids);
```
