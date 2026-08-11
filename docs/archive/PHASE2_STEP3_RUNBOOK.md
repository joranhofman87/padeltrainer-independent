# Phase 2 Step 3 — Cutover backfill runbook (owner-run)

The cutover SQL lives in [`PHASE2_STEP3_CUTOVER.sql`](PHASE2_STEP3_CUTOVER.sql). It is intentionally **NOT** a tracked migration — run it by hand, once, after the gate below. It is non-destructive, idempotent, re-runnable, and self-rolls-back on any anomaly. Hardened by a 6-lens adversarial review (no P0; all P1s folded in).

## Hard ordering (operator-enforced — nothing technical blocks an out-of-order run)

```
PR #110 dual-read frontend LIVE  →  submit-guest-intake + create-registration-invoice REDEPLOYED  →  this cutover
```

Running the cutover **before** that deploy means, during the gap, every `/register/:cycleId` link for the 2 flipped cycles falls to the legacy `getCycle` path (now `type='cyclus'`) → the form mis-renders **and** the payment guard (`type==='event'||'registration'`) is false → **paid registrations silently stop charging**. Do not proceed until the GO gate is green.

## GO gate — do NOT proceed until ALL true

1. Migrations `20260628100000` (registrations table) + `20260628100100` (start/end dates) already applied.
2. **PR #110 deployed.** Verify in a browser: a live `/register/:<source_cycle_id>` link loads the form (after backfill it will also redirect to the canonical `/register/<registration_id>` — pre-backfill it just renders).
3. **`submit-guest-intake` + `create-registration-invoice` redeployed.** Verify: a test online registration still mints an invoice with a working `/pay/:token`. (The shipped edge fns already pass `registration.id` to the minter — confirm the deploy landed.)

## Procedure

1. **Backup.** Fresh PITR checkpoint / snapshot (Dashboard → Database → Backups). Catastrophic-only backstop — the script self-rolls-back on any anomaly.
2. **Pre-flight (read-only — section below).** Required results:
   - **A** `cycles_that_will_flip_to_cyclus = 2`.
   - **B** lists exactly *"Padeltrainingen zomer 2026"* (~322 slots / ~1009 bookings) + *"Tennistrainingen zomer 2026"* (~44 slots / 0 bookings).
   - **C returns ZERO rows** (NULL-named slot-owners — would hard-abort; name them first).
   - **D returns ZERO rows** (`price_per_session`-only paid forms — **STOP if any**, see Open questions).
   - **E** is the expected event set (informational).
   - Record **F** (counts + `bookings_ck` / `slots_ck`).
3. **Dry-run (recommended).** Open `PHASE2_STEP3_CUTOVER.sql`, change the final `COMMIT;` to `ROLLBACK;`, run it on prod. You get the `NOTICE` / `EXCEPTION` arithmetic with **zero** writes. Confirm `NOTICE: registrations backfill OK: +N …` with the expected numbers.
4. **Apply.** Run `PHASE2_STEP3_CUTOVER.sql` as-is (final `COMMIT;`). Success → the same `NOTICE`. Any anomaly → `RAISE EXCEPTION`, full rollback, zero rows changed → fix the cause and re-run (idempotent + re-run-safe).
5. **Post-commit verification.** Re-run pre-flight **F** and compare to the recorded baseline:
   - `bookings`, `availability_slots`, `bookings_ck`, `slots_ck`, `cycles` → **UNCHANGED**.
   - **`invoices_sum_total`, `invoices_sum_subtotal`, `invoices_sum_vat`, `invoices_total_ck` → IDENTICAL** (the no-amount-change guarantee; the cutover's check (1c) already hard-rolls-back if any per-invoice amount moved, so this is a second human-visible confirmation).
   - `cycles_cyclus` → **+2**; `cycles_registration` + `cycles_event` combined → **−2**.
   - `intake_requests`, `invoices` → unchanged or grown (never dropped).
   - Spot-check: a paid registration invoice's `/pay/:token` still shows paid and its row now has a non-null `registration_id`; a legacy `/register/:cycleId` link resolves + redirects to canonical; the academy agenda now shows the 2 cycles as trainer-grouped cyclus entries.
6. **Re-share links / QR.** After verifying, re-share the new canonical links / regenerate QR for the live forms (old ones keep working via resolve-and-redirect).

## Rollback (only if needed post-commit)

The flip is the only behavioural change and is reversible:

```sql
UPDATE cycles SET type = 'registration'
WHERE id IN ('<padeltrainingen-id>','<tennistrainingen-id>') AND type = 'cyclus';
```

The `registrations` rows + additive `registration_id` columns are harmless to leave (the dual-read dedupes them). Full clean revert if desired: `UPDATE intake_requests SET registration_id = NULL; UPDATE invoices SET registration_id = NULL; DELETE FROM registrations;`. Snapshot restore is the last resort (loses the write-window) and should not be needed.

## Open questions (resolve before applying)

1. **`price_per_session`-only paid registrations (canary D).** Does ANY live registration/event cycle price per-lesson **solely** via `cycles.price_per_session` — no `price_table`, no `cyclus_options` — with online/both payment enabled? `registrations` has **no `price_per_session` column**, so after cutover such a form would mint **€0 / no invoice** while the confirmation email still quotes a price. The NON-DESTRUCTIVE / additive-only decision puts the fix (add a `price_per_session` column + carry it + pass it in both minters) **out of scope for this cutover**. **If canary D returns rows: do NOT apply** — first move those cycles' pricing into `price_table`, or land a follow-up schema PR. *(Prod-data fact only the owner can confirm.)*
2. **NULL-named slot-owning cycles (canary C / check 10).** Should be empty. If any surface, the script hard-aborts by design — name them before backfilling.
3. **Public badge change.** The 2 flipped cycles stop showing an "Event" badge / flat-price line on the public academy profile (gated on `type==='event'`). They are registration (not event) cycles, so the badge wasn't showing anyway — confirm this is the intended end state.

---

## Optional: export outstanding invoices (extra before/after double-check)

Belt-and-suspenders on top of the in-transaction amount guard (check 1c). Run in the Supabase SQL editor and **Download CSV**, once BEFORE the cutover and once AFTER — every amount must match; only `registration_id` changes (NULL → filled).

```sql
-- (1) the invoices the cutover actually touches (outstanding registration/event invoices).
--     NOTE: invoices has NO currency column (currency lives on cycles) — do not select i.currency.
SELECT
  i.invoice_number, i.status,
  i.total, i.subtotal, i.vat_amount, i.vat_rate, i.prices_include_vat,
  i.invoice_date, i.due_date, i.player_name,
  i.cycle_id, c.name AS cycle_name, c.type AS cycle_type,
  i.registration_id, i.id AS invoice_id
FROM invoices i
JOIN cycles c ON c.id = i.cycle_id
WHERE i.cycle_id IS NOT NULL
  AND c.type IN ('registration','event')
  AND i.status NOT IN ('paid','cancelled')
ORDER BY i.invoice_number;

-- (2) ALL outstanding invoices (broader AR snapshot)
SELECT
  i.invoice_number, i.status, i.total, i.subtotal, i.vat_amount, i.vat_rate,
  i.prices_include_vat, i.invoice_date, i.due_date, i.player_name,
  i.cycle_id, i.registration_id, i.id AS invoice_id
FROM invoices i
WHERE i.status NOT IN ('paid','cancelled')
ORDER BY i.invoice_number;

-- (3) one-line totals — fastest before/after compare
SELECT count(*) AS outstanding_count, sum(total) AS sum_total,
       sum(subtotal) AS sum_subtotal, sum(vat_amount) AS sum_vat
FROM invoices WHERE status NOT IN ('paid','cancelled');
```

(Drop the `status NOT IN ('paid','cancelled')` filter to capture the full ledger incl. paid — the cutover guard locks every invoice's amount regardless of status.)

---

## PRE-FLIGHT SQL (read-only — run FIRST, writes nothing)

```sql
-- A) Sizing: what the backfill will do (all guards mirror the cutover).
SELECT
  (SELECT count(*) FROM cycles WHERE type IN ('registration','event'))                              AS registration_event_cycles_total,
  (SELECT count(*) FROM cycles c WHERE c.type IN ('registration','event') AND c.name IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM registrations r WHERE r.source_cycle_id = c.id))                 AS registrations_to_create,
  (SELECT count(*) FROM intake_requests ir WHERE ir.registration_id IS NULL
     AND EXISTS (SELECT 1 FROM cycles c WHERE c.id = ir.cycle_id
                  AND c.type IN ('registration','event') AND c.name IS NOT NULL))                   AS intakes_to_link,
  (SELECT count(*) FROM invoices i WHERE i.registration_id IS NULL AND i.cycle_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM cycles c WHERE c.id = i.cycle_id
                  AND c.type IN ('registration','event') AND c.name IS NOT NULL))                   AS invoices_to_link,
  (SELECT count(*) FROM cycles c WHERE c.type IN ('registration','event') AND c.name IS NOT NULL
     AND EXISTS (SELECT 1 FROM availability_slots s WHERE s.cyclus_id = c.id))                       AS cycles_that_will_flip_to_cyclus,
  (SELECT count(*) FROM registrations)                                                              AS registrations_existing_now;

-- B) Per-cycle preview of the FLIP set — sanity-check it is exactly the 2 expected training cycles.
SELECT c.id, c.name, c.type, c.owner_type,
       (SELECT count(*) FROM availability_slots s WHERE s.cyclus_id = c.id) AS slots,
       (SELECT count(*) FROM bookings b JOIN availability_slots s ON s.id = b.slot_id WHERE s.cyclus_id = c.id) AS bookings,
       (SELECT count(*) FROM intake_requests ir WHERE ir.cycle_id = c.id) AS intakes
FROM cycles c
WHERE c.type IN ('registration','event') AND c.name IS NOT NULL
  AND EXISTS (SELECT 1 FROM availability_slots s WHERE s.cyclus_id = c.id)
ORDER BY slots DESC;

-- C) BLOCKER CANARY #1 — NULL-named cycles that OWN a slot will HARD-ABORT the cutover (check 10).
--    Expect ZERO. If rows: NAME them first.
SELECT c.id, c.type, c.owner_type, c.owner_id, c.status, c.created_at,
       (SELECT count(*) FROM availability_slots s WHERE s.cyclus_id = c.id) AS owns_slots
FROM cycles c
WHERE c.type IN ('registration','event') AND c.name IS NULL
  AND NOT EXISTS (SELECT 1 FROM registrations r WHERE r.source_cycle_id = c.id)
ORDER BY owns_slots DESC;

-- D) BLOCKER CANARY #2 — per-lesson registrations priced ONLY via cycles.price_per_session (no
--    price_table, no cyclus_options) with online payment. After cutover the minter reads the
--    registrations row (no price_per_session column) → would mint €0 while the email quotes a price.
--    Expect ZERO. If rows: DO NOT APPLY — see open question 1.
SELECT c.id, c.name, c.owner_type, c.price_per_session, c.price_table,
       (c.settings->>'payment_methods') AS payment_methods
FROM cycles c
WHERE c.type IN ('registration','event')
  AND c.price_per_session IS NOT NULL
  AND (c.price_table IS NULL OR jsonb_typeof(c.price_table) <> 'array' OR jsonb_array_length(c.price_table) = 0)
  AND NOT (c.settings ? 'cyclus_options')
  AND (c.settings->>'payment_methods') IN ('online','both');

-- E) AWARENESS — event cycles with invoices but ZERO slots. Correctly STAY type='event' (form shadow,
--    not flipped). Eyeball that the set is expected. Not a blocker.
SELECT c.id, c.name,
       (SELECT count(*) FROM invoices i WHERE i.cycle_id = c.id) AS invoices
FROM cycles c
WHERE c.type = 'event'
  AND NOT EXISTS (SELECT 1 FROM availability_slots s WHERE s.cyclus_id = c.id)
  AND EXISTS (SELECT 1 FROM invoices i WHERE i.cycle_id = c.id)
ORDER BY invoices DESC;

-- F) BASELINE counts + content fingerprints to record and compare post-commit.
SELECT
  (SELECT count(*) FROM bookings)                                                           AS bookings,
  (SELECT count(*) FROM availability_slots)                                                 AS availability_slots,
  (SELECT md5(coalesce(string_agg(id::text, ',' ORDER BY id), '')) FROM bookings)           AS bookings_ck,
  (SELECT md5(coalesce(string_agg(id::text, ',' ORDER BY id), '')) FROM availability_slots) AS slots_ck,
  (SELECT count(*) FROM intake_requests)                                                    AS intake_requests,
  (SELECT count(*) FROM invoices)                                                           AS invoices,
  -- invoice money totals — these MUST be identical post-commit (the migration only adds
  -- registration_id; check (1c) in the cutover hard-rolls-back if any amount moved):
  (SELECT coalesce(sum(total), 0)      FROM invoices)                                       AS invoices_sum_total,
  (SELECT coalesce(sum(subtotal), 0)   FROM invoices)                                       AS invoices_sum_subtotal,
  (SELECT coalesce(sum(vat_amount), 0) FROM invoices)                                       AS invoices_sum_vat,
  (SELECT md5(coalesce(string_agg(id::text || '|' || coalesce(total::text,''), ',' ORDER BY id), ''))
     FROM invoices)                                                                         AS invoices_total_ck,
  (SELECT count(*) FROM cycles)                                                             AS cycles,
  (SELECT count(*) FROM cycles WHERE type='cyclus')                                         AS cycles_cyclus,
  (SELECT count(*) FROM cycles WHERE type='registration')                                   AS cycles_registration,
  (SELECT count(*) FROM cycles WHERE type='event')                                          AS cycles_event;
```
