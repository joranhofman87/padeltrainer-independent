# CYCLE SERIES SPLIT — runbook

One-time, owner-run cleanup that splits 3 legacy "mega-cycles" (each bundling a
whole season of many weekly series into one row) into one `type='cyclus'` cycle
per weekly series. The migration is `docs/CYCLE_SERIES_SPLIT.sql`. It is
**invoice-safe** (0 invoices reference these cycles; bookings link to slots by
`slot_id`, which never changes), **idempotent**, and **reversible**.

The 3 targets (academy-owned, status `open`):

| id | name | slots | series → new cycles | bookings | intakes |
|----|------|------:|--------------------:|---------:|--------:|
| `1e40f602-…` | Padeltrainingen zomer 2026 | 322 | 23 | 1009 | 77 |
| `2aa741a2-…` | Tennistrainingen zomer 2026 | 44 | 6 | 0 | 15 |
| `69f60dbe-…` | Volgende ronde 2026 | 18 | 2 | 0 | 0 |

Expected result: **31 new `cyclus` cycles**, **384 slots re-pointed**, the 3
parents left as empty (0-slot) shells that still back their registration form.

---

## 0. GO gate

- The split changes only `availability_slots.cyclus_id`/`cyclus_name` and INSERTs
  new cycles. It does **not** touch bookings, invoices, or the parent rows.
- Frontend needs **no** deploy for the migration itself. (Optional fast-follow:
  hide the now-empty parent shells from the cycles overview — see §5.)
- Take a fresh DB snapshot / confirm PITR is available before applying (standard
  backstop; the migration also self-rolls-back on any anomaly).

---

## 1. Pre-flight (READ-ONLY — run each, record the result)

All four are read-only. Timezone is `Europe/Amsterdam` (the academy default).

**(A) Sizing — expect 23 / 6 / 2 (sum 31).** Confirms the series count per parent.
```sql
WITH parents(id) AS (VALUES
  ('1e40f602-21eb-4ef1-ae31-f1616897f4c8'::uuid),
  ('2aa741a2-f0e6-435b-a3cb-998df8b6c005'::uuid),
  ('69f60dbe-9a7c-4c19-a794-e68e13915fc2'::uuid))
SELECT s.cyclus_id AS parent_id, count(*) AS slots,
       count(DISTINCT (
         COALESCE(s.trainer_id::text,'∅')||'|'||EXTRACT(ISODOW FROM s.start_time AT TIME ZONE 'Europe/Amsterdam')::int
         ||'|'||to_char(s.start_time AT TIME ZONE 'Europe/Amsterdam','HH24:MI')
         ||'|'||to_char(s.end_time   AT TIME ZONE 'Europe/Amsterdam','HH24:MI')
         ||'|'||COALESCE(s.location_id::text,'∅'))) AS distinct_series
FROM availability_slots s JOIN parents p ON p.id = s.cyclus_id
GROUP BY s.cyclus_id;
```

**(B) Registration backing.** Confirms each parent backs a registration form (so
the empty shell must be retained; explains the "edit → Registrations" routing).
```sql
SELECT id, source_cycle_id, format, status FROM registrations
 WHERE source_cycle_id IN (
   '1e40f602-21eb-4ef1-ae31-f1616897f4c8',
   '2aa741a2-f0e6-435b-a3cb-998df8b6c005',
   '69f60dbe-9a7c-4c19-a794-e68e13915fc2');
```

**(C) Intake-status GATE.** The proposal/intake-flow rework is deferred. After the
split a parent owns 0 slots, so `generate-proposals` (which finds slots by
`cyclus_id`) would return none for it. That is fine **only if** these seasons are
already assigned. If any intake is still `new` or `proposed`, **STOP** and decide
before applying.
```sql
SELECT cycle_id, status, count(*) FROM intake_requests
 WHERE cycle_id IN (
   '1e40f602-21eb-4ef1-ae31-f1616897f4c8',
   '2aa741a2-f0e6-435b-a3cb-998df8b6c005',
   '69f60dbe-9a7c-4c19-a794-e68e13915fc2')
 GROUP BY cycle_id, status ORDER BY 1,2;
```

**(F) Baseline fingerprint** (compare against §3 post-commit):
```sql
SELECT (SELECT count(*) FROM availability_slots) AS slots,
       (SELECT count(*) FROM bookings)           AS bookings,
       (SELECT count(*) FROM invoices)           AS invoices,
       (SELECT md5(coalesce(string_agg(id::text, ',' ORDER BY id),'')) FROM bookings) AS bookings_ck,
       (SELECT count(*) FROM cycles)             AS cycles;
```

---

## 2. Apply

1. **Dry-run first.** Open `docs/CYCLE_SERIES_SPLIT.sql`, change the final
   `COMMIT;` to `ROLLBACK;`, run it. You should see the `NOTICE`:
   `cycle series split OK: 31 split cycles own 384 slots (384 moved this run); parents now empty; bookings + invoices unchanged.`
   and **no** `EXCEPTION`. Nothing is written (rolled back).
2. **Apply for real.** Restore the final `ROLLBACK;` back to `COMMIT;` and run it.
   Any anomaly raises an exception and the whole transaction rolls back — fix the
   cause and re-run (it is idempotent).

---

## 3. Post-commit verification (READ-ONLY)

```sql
-- (1) total slots unchanged; bookings/invoices unchanged vs the §1F baseline
SELECT (SELECT count(*) FROM availability_slots) AS slots,
       (SELECT count(*) FROM bookings)           AS bookings,
       (SELECT count(*) FROM invoices)           AS invoices,
       (SELECT md5(coalesce(string_agg(id::text, ',' ORDER BY id),'')) FROM bookings) AS bookings_ck;

-- (2) 31 new split cycles exist
SELECT count(*) FROM cycles WHERE settings->>'split_migration' = 'CYCLE_SERIES_SPLIT_v1';   -- 31

-- (3) each parent now owns 0 slots
SELECT cyclus_id, count(*) FROM availability_slots
 WHERE cyclus_id IN (
   '1e40f602-21eb-4ef1-ae31-f1616897f4c8',
   '2aa741a2-f0e6-435b-a3cb-998df8b6c005',
   '69f60dbe-9a7c-4c19-a794-e68e13915fc2')
 GROUP BY cyclus_id;                                                                          -- 0 rows

-- (4) per-parent: new cycle count + slots conserved
SELECT nc.settings->>'split_from_cycle_id' AS parent,
       count(DISTINCT nc.id) AS new_cycles, count(s.id) AS slots
FROM cycles nc JOIN availability_slots s ON s.cyclus_id = nc.id
WHERE nc.settings->>'split_migration' = 'CYCLE_SERIES_SPLIT_v1'
GROUP BY 1;            -- new_cycles per parent = 23 / 6 / 2; slots per parent = 322 / 44 / 18
```

Then spot-check in the app: the Cycles list now shows per-series cycles (e.g.
"Maandag 18:00 - <trainer>"), each editable without bouncing to Registrations;
the 3 forms still live under Registrations.

---

## 4. Rollback (one transaction; idempotent; never touches bookings/invoices)

```sql
BEGIN;
UPDATE public.availability_slots s
   SET cyclus_id   = (nc.settings->>'split_from_cycle_id')::uuid,
       cyclus_name = NULL
  FROM public.cycles nc
 WHERE nc.id = s.cyclus_id
   AND nc.settings->>'split_migration' = 'CYCLE_SERIES_SPLIT_v1';

DELETE FROM public.cycles nc
 WHERE nc.settings->>'split_migration' = 'CYCLE_SERIES_SPLIT_v1'
   AND NOT EXISTS (SELECT 1 FROM public.availability_slots s WHERE s.cyclus_id = nc.id);
COMMIT;
```
After rollback: all 384 slots are back on their parents with `cyclus_name = NULL`,
the 31 split cycles are gone, bookings + invoices are byte-identical. (Re-running
the rollback is a no-op.) PITR/snapshot stays the catastrophic backstop.

---

## 5. Optional fast-follow (frontend; auto-deploys via Vercel)

After the split, the empty parent shells (`type='cyclus'`, 0 slots) still appear
in the cycles overview with a "No Sessions" badge (`get_academy_cyclus_groups`
emits 0-slot non-registration cycles). To finish "form ≠ cycle", hide split-parent
shells — those whose `settings->>'split_migration'` is set, or that have a backing
`registrations` row — from `AcademyCyclusOverview` so they live only under
Registrations. The new per-series cycles already display + edit correctly.

---

## Verification (this repo)

`scripts/db/rehearse-cycle-series-split.ts` runs this exact SQL file against real
Postgres (PGlite) with the edge cases (multi-court → one cycle, NULL-location,
DST-spanning, untouched bookings/invoice) and asserts the split, idempotent
re-run, and rollback. Run via `node scripts/db/run-all-rehearsals.mjs` (auto-
discovered) or `npx tsx scripts/db/rehearse-cycle-series-split.ts`.
