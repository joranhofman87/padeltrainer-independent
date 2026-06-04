# Ficwb production data integrity audit

**Project:** `ficwbdrzefmblkbkomzw` (PadelTrainer production)  
**Audit date:** 2026-06-03  
**Method:** Read-only SQL via `scripts/migration/ficwb_data_integrity_audit.sql` + targeted samples  
**Re-run:** `python3 scripts/migration/ficwb_data_integrity_audit.py`

---

## Executive summary

Production data is **mostly referentially sound** (no missing booking slots, no orphan invoice players, no duplicate Stripe customers, no users without profiles). The main risks are **migration-era directory data**, **calendar/slot hygiene**, and **invoice/booking reconciliation gaps** — not widespread auth corruption.

| Severity | Count | Theme |
|----------|------:|-------|
| **Critical** | 1 | ~3,710 scraped academy profiles with no `academy_managers` (pipeline/import artifacts) |
| **High** | 4 | Paid bookings without invoices (31); overbooked slots (83); multi-role users (3); trainer profile without role (1) |
| **Medium** | 6 | Trainers missing onboarding rows (11); past public slots (116); overlapping slots (25); invoice line/total drift (5); subscription edge cases (6); club/academy manager gaps |
| **Low** | 3 | Duplicate player/slot booking (1); orphan invoice booking UUID (1); club profiles without managers (2) |

**Not found (good):** `auth.users` without `profiles`; bookings without player/guest; bookings pointing at deleted slots; invoices with missing trainer/player FK targets; negative invoice totals; paid invoices without `paid_at`; duplicate invoice rows per booking set; duplicate Stripe customer IDs across trainers/academies.

---

## How to use this document

Each finding includes: problem → user impact → severity → fix SQL → rollback.  
**Always** run fixes in a transaction on a staging clone first; export row IDs before `UPDATE`/`DELETE`.

---

## AUTH & ROLES

### A1 — Users with multiple roles (3 users)

| | |
|--|--|
| **Count** | 3 |
| **Severity** | **High** |

**Problem**  
One `user_id` has more than one row in `user_roles` (e.g. `player` + `trainer`). App routing uses a priority order (`admin` > `trainer` > `club` > `player`) but RLS and UX can behave unpredictably.

**User impact**  
Wrong dashboard after login; wrong RLS on invoices/bookings; support confusion (“I’m a trainer but I see the player app”).

**Detect**

```sql
SELECT ur.user_id, u.email, array_agg(ur.role ORDER BY ur.role) AS roles
FROM public.user_roles ur
JOIN auth.users u ON u.id = ur.user_id
GROUP BY ur.user_id, u.email
HAVING COUNT(DISTINCT ur.role) > 1;
```

**Sample (2026-06-03 CLI follow-up)** — two of three users are `player` + `admin` (likely intentional ops accounts):

| `user_id` | Roles |
|-----------|--------|
| `9bcc1c6f-7978-49bb-aa06-6f1be4135fc7` | admin, player |
| `d3f3ced7-25bf-4ae6-a2f1-820da140355e` | admin, player |

Resolve emails in Supabase SQL editor (`auth.users` join) if needed; third multi-role user timed out in CLI.

**Fix (per user — keep intended role only)**

```sql
-- Example: remove player role when trainer is canonical
-- BEGIN;
-- DELETE FROM public.user_roles
-- WHERE user_id = '<USER_UUID>'::uuid AND role = 'player';
-- COMMIT;
```

**Rollback**  
Re-insert deleted `user_roles` rows from backup export.

---

### A2 — Trainer profile without `trainer` role (1)

| | |
|--|--|
| **Count** | 1 (`info@padeltrainer.ai` / slug `padel-trainer-admin`) |
| **Severity** | **High** (operational; likely intentional admin test account) |

**Problem**  
`trainer_profiles` exists but no `user_roles.role = 'trainer'` for that `user_id`.

**User impact**  
Trainer UI may fail role gates; edge functions that check `user_roles` may 403 while profile exists.

**Detect**

```sql
SELECT tp.id, tp.slug, u.email
FROM public.trainer_profiles tp
JOIN auth.users u ON u.id = tp.user_id
WHERE NOT EXISTS (
  SELECT 1 FROM public.user_roles ur
  WHERE ur.user_id = tp.user_id AND ur.role = 'trainer'
);
```

**Fix**

```sql
INSERT INTO public.user_roles (user_id, role)
SELECT tp.user_id, 'trainer'::public.app_role
FROM public.trainer_profiles tp
WHERE tp.slug = 'padel-trainer-admin'
  AND NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = tp.user_id AND ur.role = 'trainer'
  );
```

**Rollback**  
`DELETE FROM public.user_roles WHERE user_id = '<USER_UUID>' AND role = 'trainer';`

---

### A3 — Club role without `club_managers` row (1)

| | |
|--|--|
| **Count** | 1 |
| **Severity** | **Medium** |

**Problem**  
`user_roles.role IN ('club','club_manager')` but no `club_managers` membership.

**User impact**  
Club dashboard 403 / empty club context.

**Detect**

```sql
SELECT ur.user_id, u.email, ur.role
FROM public.user_roles ur
JOIN auth.users u ON u.id = ur.user_id
WHERE ur.role IN ('club', 'club_manager')
  AND NOT EXISTS (SELECT 1 FROM public.club_managers cm WHERE cm.user_id = ur.user_id);
```

**Fix**  
Create `club_managers` for the correct `club_profile_id`, or remove erroneous `user_roles` row after confirming with user.

**Rollback**  
Restore deleted role or manager row from export.

---

### A4 — Users with no role (0)

| | |
|--|--|
| **Count** | 0 (was 3 pre-cleanup in earlier ficwb check) |
| **Severity** | — |

No action unless count rises after new signups.

---

## ONBOARDING

### O1 — Trainers without `trainer_onboarding` row (11)

| | |
|--|--|
| **Count** | 11 |
| **Severity** | **Medium** |

**Problem**  
`trainer_profiles` exist (often migrated or role-assigned outside onboarding) with no `trainer_onboarding` tracking row.

**User impact**  
`isTrainerOnboardingComplete` may send users to onboarding unexpectedly or skip progress tracking; analytics skewed.

**Detect**

```sql
SELECT tp.id, tp.slug, u.email, tp.created_at::date
FROM public.trainer_profiles tp
JOIN auth.users u ON u.id = tp.user_id
WHERE NOT EXISTS (
  SELECT 1 FROM public.trainer_onboarding tob WHERE tob.user_id = tp.user_id
);
```

**Fix (backfill completed onboarding for active trainers)**

```sql
INSERT INTO public.trainer_onboarding (user_id, current_step, completed_at)
SELECT tp.user_id, 2, NOW()
FROM public.trainer_profiles tp
WHERE tp.slug IS NOT NULL AND btrim(tp.slug) <> ''
  AND NOT EXISTS (SELECT 1 FROM public.trainer_onboarding tob WHERE tob.user_id = tp.user_id);
```

**Rollback**  
`DELETE FROM public.trainer_onboarding WHERE user_id IN (...);`

---

### O2 — Completed onboarding but empty slug (0)

No rows at audit time.

### O3 — Onboarding rows for deleted users (0)

No rows at audit time.

---

## PAYMENTS & SUBSCRIPTIONS

### P1 — Active subscription without Stripe customer ID (5 trainers)

| | |
|--|--|
| **Count** | 5 |
| **Severity** | **Medium** |

**Problem**  
`trainer_profiles.subscription_status = 'active'` but `stripe_customer_id` is null/empty — inconsistent with Stripe-backed billing.

**User impact**  
Customer portal and webhook renewal may break; false “active” access.

**Detect**

```sql
SELECT id, slug, subscription_status, stripe_customer_id, subscription_id
FROM public.trainer_profiles
WHERE subscription_status = 'active'
  AND COALESCE(stripe_customer_id, '') = '';
```

**Fix**  
Reconcile each row against Stripe Dashboard; set `stripe_customer_id` / `subscription_id` from Stripe, or set `subscription_status = 'inactive'` if no paid sub exists.

**Rollback**  
Restore prior column values from CSV export.

---

### P2 — Trial past `trial_ends_at` but still `trial` (1)

| | |
|--|--|
| **Count** | 1 |
| **Severity** | **Medium** |

**Problem**  
Expired trial not moved to `inactive` / `active`.

**User impact**  
Extended free access or blocked paid features incorrectly.

**Detect**

```sql
SELECT id, slug, trial_ends_at, subscription_status
FROM public.trainer_profiles
WHERE subscription_status = 'trial'
  AND trial_ends_at < NOW();
```

**Fix**

```sql
UPDATE public.trainer_profiles
SET subscription_status = 'inactive'
WHERE subscription_status = 'trial'
  AND trial_ends_at < NOW()
  AND id IN (SELECT id FROM ...); -- scope to verified IDs
```

**Rollback**  
Revert `subscription_status` and `trial_ends_at` from backup.

---

### P3 — Duplicate Stripe customer IDs (0 trainers, 0 academies)

Clean at audit time.

---

## BOOKINGS

### B1 — Paid bookings with no non-cancelled invoice (31)

| | |
|--|--|
| **Count** | 31 |
| **Severity** | **High** |

**Problem**  
`bookings.payment_status = 'paid'` but no `invoices` row where `booking_ids` contains that booking (excluding `cancelled` invoices).

**User impact**  
Booking success PDF / player invoice history missing; accounting gaps; support “I paid but no invoice”.

**Notes from sample**  
Cluster on trainer `rene-lindenbergh`, dates around **2026-03-25** (migration window). May be split-cycle bookings invoiced in aggregate, manual invoicing, or failed `auto-create-invoice`.

**Detect**

```sql
SELECT b.id, b.created_at, tp.slug, b.status
FROM public.bookings b
JOIN public.availability_slots s ON s.id = b.slot_id
JOIN public.trainer_profiles tp ON tp.id = s.trainer_id
WHERE b.payment_status = 'paid'
  AND NOT EXISTS (
    SELECT 1 FROM public.invoices i
    WHERE i.booking_ids @> ARRAY[b.id]::uuid[]
      AND i.status <> 'cancelled'
  )
ORDER BY b.created_at DESC;
```

**Fix (preferred — backfill via edge function per trainer batch)**

Run `auto-create-invoice` for distinct `booking_ids` arrays (dev script), **or** insert invoices only after verifying trainer `use_manual_invoicing` flag:

```sql
-- Do NOT blind-insert; use auto-create-invoice or manual review.
-- For confirmed single-booking gaps only:
-- SELECT id FROM bookings WHERE ... ;
-- invoke auto-create-invoice with body {"bookingIds": ["..."]}
```

**Rollback**  
Delete backfilled invoices only if `status = 'draft'` and created in same maintenance window (keep audit log).

---

### B2 — Invoice references missing booking UUID (1)

| | |
|--|--|
| **Count** | 1 |
| **Severity** | **Low** |

**Problem**  
`invoices.booking_ids` array contains a UUID not present in `bookings` (deleted booking or bad migration).

**User impact**  
Invoice PDF / line items may reference missing sessions; reconcile reports wrong.

**Detect**

```sql
SELECT i.id, i.invoice_number, bid.booking_id
FROM public.invoices i
CROSS JOIN LATERAL unnest(COALESCE(i.booking_ids, ARRAY[]::uuid[])) AS bid(booking_id)
LEFT JOIN public.bookings b ON b.id = bid.booking_id
WHERE b.id IS NULL;
```

**Fix**

```sql
UPDATE public.invoices i
SET booking_ids = ARRAY(
  SELECT x FROM unnest(i.booking_ids) x
  WHERE EXISTS (SELECT 1 FROM public.bookings b WHERE b.id = x)
)
WHERE i.id = '<INVOICE_UUID>'::uuid;
```

**Rollback**  
Restore `booking_ids` from export.

---

### B3 — Duplicate active booking same player + slot (1)

| | |
|--|--|
| **Count** | 1 |
| **Severity** | **Low** |

**Problem**  
Two non-cancelled bookings share `slot_id` and same `player_id` or `guest_player_id`.

**User impact**  
Double charge risk; capacity wrong.

**Detect**

```sql
SELECT b.slot_id, COALESCE(b.player_id::text, b.guest_player_id::text) AS player_key,
       array_agg(b.id) AS booking_ids, COUNT(*) AS c
FROM public.bookings b
WHERE b.status NOT IN ('cancelled', 'canceled')
  AND COALESCE(b.player_id, b.guest_player_id) IS NOT NULL
GROUP BY b.slot_id, COALESCE(b.player_id, b.guest_player_id)
HAVING COUNT(*) > 1;
```

**Fix**  
Cancel duplicate with refund policy; keep booking tied to successful Mollie payment.

**Rollback**  
Restore cancelled booking row from backup.

---

### B4 — Invalid `payment_status` / missing slots / missing players (0 each)

Clean at audit time.

---

## INVOICES

### I1 — Invoice line items sum ≠ `total` (5)

| | |
|--|--|
| **Count** | 5 |
| **Severity** | **Medium** |

**Problem**  
Sum of `line_items[].amount` differs from `invoices.total` by > €0.02 (VAT rounding, manual edits, or migration).

**User impact**  
Wrong amount on PDF and Mollie pay link; accounting distrust.

**Detect**

```sql
SELECT i.id, i.invoice_number, i.total,
  (SELECT SUM((elem->>'amount')::numeric)
   FROM jsonb_array_elements(i.line_items) elem WHERE elem ? 'amount') AS line_sum
FROM public.invoices i
WHERE i.line_items IS NOT NULL AND jsonb_typeof(i.line_items) = 'array'
  AND ABS(i.total - COALESCE((
    SELECT SUM((elem->>'amount')::numeric)
    FROM jsonb_array_elements(i.line_items) elem WHERE elem ? 'amount'
  ), i.total)) > 0.02;
```

**Fix**  
Re-run `generate-invoice` after correcting `subtotal`/`vat_amount`/`total` from line items, or invoke `recalculate-invoices` for scoped IDs.

**Rollback**  
Restore invoice financial columns from export.

---

### I2 — Paid status / paid_at consistency (0 issues)

No `paid` without `paid_at` or unpaid with `paid_at` at audit time.

### I3 — Duplicate invoices same booking set (0)

Clean at audit time.

---

## AVAILABILITY

### V1 — Slots over max participants

| | |
|--|--|
| **Count (2026-06-03 pre-cleanup)** | 83 slots (audit used default 1; false positives) |
| **Count (post P1-A cleanup)** | 0 expected |
| **Severity** | **High** when count is above zero after cleanup |

**Problem**  
Count of non-cancelled bookings on a slot exceeds effective capacity. Effective max = `COALESCE(NULLIF(max_participants, 0), 4)` — matches UI `max_participants \|\| 4`. Historical noise came from cyclus slots with `max_participants` NULL stored while group lessons had 2–4 players.

**User impact**  
If unintended: overbooking, court conflicts, wrong pricing.

**Detect**

```sql
SELECT s.id, s.start_time, tp.slug, s.max_participants, COUNT(b.id) AS booking_count
FROM public.availability_slots s
JOIN public.bookings b ON b.slot_id = s.id AND b.status NOT IN ('cancelled', 'canceled')
JOIN public.trainer_profiles tp ON tp.id = s.trainer_id
GROUP BY s.id, s.start_time, tp.slug, s.max_participants
HAVING COUNT(*) > COALESCE(NULLIF(s.max_participants, 0), 4)
ORDER BY booking_count DESC
LIMIT 50;
```

**Fix**  
Backfill NULL cyclus `max_participants` to 4; cancel true duplicate same-player/same-slot rows. Do not delete bookings for valid group lessons. DB capacity trigger is a separate step (not yet deployed).

**Rollback**  
Per-booking status restoration from export.

---

### V2 — Past slots still `is_public = true` (116)

| | |
|--|--|
| **Count** | 116 |
| **Severity** | **Medium** (hygiene / SEO book page noise) |

**Problem**  
Ended slots remain publicly visible (`is_public = true`).

**User impact**  
Stale slots on public book page; confused players; not usually a payment bug.

**Detect**

```sql
SELECT id, trainer_id, start_time, end_time
FROM public.availability_slots
WHERE end_time < NOW() AND is_public = true
ORDER BY end_time DESC
LIMIT 20;
```

**Fix**

```sql
BEGIN;
UPDATE public.availability_slots
SET is_public = false
WHERE end_time < NOW() - INTERVAL '1 day'
  AND is_public = true;
-- Review row count before COMMIT;
COMMIT;
```

**Rollback**

```sql
UPDATE public.availability_slots SET is_public = true WHERE id IN (...);
```

---

### V3 — Overlapping slots same trainer (25 pairs)

| | |
|--|--|
| **Count** | 25 overlapping pairs |
| **Severity** | **Medium** |

**Problem**  
Two `availability_slots` for same `trainer_id` with intersecting time ranges.

**User impact**  
Double booking at same time; calendar chaos.

**Detect**

```sql
SELECT a.id AS slot_a, b.id AS slot_b, a.trainer_id, a.start_time, a.end_time
FROM public.availability_slots a
JOIN public.availability_slots b
  ON a.trainer_id = b.trainer_id AND a.id < b.id
 AND a.start_time < b.end_time AND b.start_time < a.end_time
LIMIT 30;
```

**Fix**  
Merge or cancel redundant slot after trainer confirmation; do not auto-delete if bookings exist.

**Rollback**  
Re-insert cancelled slots from backup (unlikely).

---

### V4 — Invalid start/end (0); missing trainer (0)

Clean at audit time.

---

## ACADEMIES & CLUBS

### C1 — Academy profiles without any manager (3,710)

| | |
|--|--|
| **Count** | 3,710 |
| **Severity** | **Critical** (data hygiene / migration artifact) |

**Problem**  
`academy_profiles` rows have **no** `academy_managers` child row. Samples show duplicate scraped names (“Zidane Five Club”, slug variants `zidane-five-club-*`) from **import pipeline**, not live customer academies.

**User impact**  
No one can log into academy dashboard for those rows; SEO pages may 404 or show junk; DB bloat; confused admin search.

**Detect**

```sql
SELECT COUNT(*) AS orphan_academies
FROM public.academy_profiles ap
WHERE NOT EXISTS (
  SELECT 1 FROM public.academy_managers am WHERE am.academy_profile_id = ap.id
);

-- Likely migration/import (no owner):
SELECT COUNT(*) FROM public.academy_profiles
WHERE created_by IS NULL;
```

**Fix (phased — do NOT delete live customer academies)**

1. Export IDs: `SELECT id, name, slug, created_at, created_by FROM academy_profiles WHERE NOT EXISTS (...);`
2. **Phase A:** Archive/delete only rows matching import heuristics, e.g. `created_by IS NULL` AND `created_at < '2026-04-01'` AND no `academy_trainers`, no `cycles`, no `invoices`.
3. **Phase B:** For real academies missing manager, insert `academy_managers` for `created_by` user.

```sql
-- Example Phase A (review count first):
-- DELETE FROM public.academy_profiles ap
-- WHERE ap.created_by IS NULL
--   AND NOT EXISTS (SELECT 1 FROM public.academy_managers am WHERE am.academy_profile_id = ap.id)
--   AND NOT EXISTS (SELECT 1 FROM public.academy_trainers at WHERE at.academy_profile_id = ap.id)
--   AND NOT EXISTS (SELECT 1 FROM public.cycles c WHERE c.owner_type = 'academy' AND c.owner_id = ap.id);
```

**Rollback**  
Restore from `pg_dump` table-level export or Supabase PITR — **mandatory** before bulk delete.

---

### C2 — Club profiles without managers (2)

| | |
|--|--|
| **Count** | 2 |
| **Severity** | **Low** |

**Problem**  
`club_profiles` with no `club_managers`.

**User impact**  
Club app unusable for those profiles.

**Detect**

```sql
SELECT cp.id, cp.name, cp.slug FROM public.club_profiles cp
WHERE NOT EXISTS (SELECT 1 FROM public.club_managers cm WHERE cm.club_profile_id = cp.id);
```

**Fix**  
Attach manager from `created_by` or delete orphan test clubs.

**Rollback**  
Restore rows from export.

---

### C3 — Orphan `academy_trainers` / `trainer_locations` (0)

FK integrity intact at audit time.

---

## EMAIL & NOTIFICATIONS

### E1 — Onboarding email queue (0 failed, 0 orphan users, 0 stale pending >7d)

Queues healthy at audit time.

### E2 — Notification queue / notifications orphan users (0)

Clean at audit time.

---

## STORAGE (manual check — not run against bucket)

Storage object existence was **not** bulk-verified (requires Storage API or `storage.objects` listing).

**Recommended manual procedure**

1. Supabase Dashboard → Storage → `avatars`, `logos`, `invoices`.
2. Sample 20 `profiles.avatar_url` / `trainer_profiles` / `academy_profiles.logo_url` paths → HEAD request each public URL.
3. Record 404s; fix by re-upload or null URL in DB.

**Detect (DB paths only)**

```sql
SELECT id, avatar_url FROM public.profiles
WHERE avatar_url IS NOT NULL AND avatar_url <> ''
LIMIT 50;
```

**Fix**  
`UPDATE profiles SET avatar_url = NULL WHERE id = ...` for broken paths.

**Rollback**  
Restore URL from export.

---

## Prioritized remediation plan

### Phase 0 — Immediate (no destructive SQL)

| # | Action | Owner |
|---|--------|-------|
| 0.1 | Export CSV of all findings above | Dev |
| 0.2 | Review **3** multi-role users + **1** trainer-without-role | Support |
| 0.3 | Review **31** paid-without-invoice (expect migration cluster) | Finance |

### Phase 1 — High impact, low risk (1–2 days)

| # | Action | SQL / tool |
|---|--------|------------|
| 1.1 | Backfill **11** `trainer_onboarding` rows | O1 fix SQL |
| 1.2 | Reconcile **5** active-without-Stripe trainers | P1 manual + Stripe |
| 1.3 | Fix **1** expired trial status | P2 SQL |
| 1.4 | Fix **5** invoice line/total mismatches | `recalculate-invoices` / manual |
| 1.5 | Remove orphan booking UUID from **1** invoice | B2 SQL |

### Phase 2 — Product integrity (1 week)

| # | Action |
|---|--------|
| 2.1 | Backfill or explain **31** paid bookings without invoices |
| 2.2 | Audit **83** overbooked slots (split-payment vs bug) |
| 2.3 | Close **116** past public slots (`is_public = false`) |
| 2.4 | Resolve **25** overlapping trainer slots |
| 2.5 | Investigate **1** duplicate player/slot booking |

### Phase 3 — Migration cleanup (planned window)

| # | Action |
|---|--------|
| 3.1 | Archive/delete **~3,710** import academies with no managers (heuristic-based) |
| 3.2 | Dedupe scraped academy slugs (`zidane-five-club-*` pattern) |
| 3.3 | Remove remaining `migration_exports/` usage from ops; document “no re-import without dedupe” |

### Phase 4 — Prevent recurrence

| # | Action |
|---|--------|
| 4.1 | Deploy DB capacity guard (booking over-cap) — PR-8 |
| 4.2 | Scheduled job: past slots → `is_public = false` |
| 4.3 | Cron: `invoice-health-check` + alert on paid booking / invoice gap |
| 4.4 | Signup guard: always insert `trainer_onboarding` + `user_roles` in one transaction |
| 4.5 | Monthly re-run `ficwb_data_integrity_audit.py` |

---

## Target “clean” state

- [ ] Zero multi-role users unless explicitly documented (admin service accounts)
- [ ] Every live trainer: `user_roles.trainer` + `trainer_onboarding` + `trainer_profiles.slug`
- [ ] Zero paid bookings (last 90 days) without invoice or documented manual-invoicing flag
- [ ] Zero import academies without managers in **public** search indexes
- [ ] No past public slots; no unintended over-cap slots
- [ ] Stripe `subscription_status` matches Stripe Dashboard for all paying trainers/academies
- [ ] Migration import tables/scripts not re-run on production without dedupe

---

## Appendix — audit script

- SQL: `scripts/migration/ficwb_data_integrity_audit.sql`
- Runner: `scripts/migration/ficwb_data_integrity_audit.py`
- Related: `docs/P0_PR1_PR4_NOTES.md`, `TEST_RUNBOOK.md`

---

*This audit is point-in-time. Re-run after bulk fixes or major releases.*
