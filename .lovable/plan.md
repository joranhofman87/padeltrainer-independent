

## Full Legacy Code Audit and Cleanup Plan

After reviewing the entire codebase against the four core migrations (URL changes, Auth fixes, Lessons removal, Stripe-to-Mollie), here is everything that still needs cleanup.

---

### Migration 1: URL Changes (subdomain to single domain)
**Status: CLEAN** -- No references to `app.padeltrainer.ai` or subdomain routing logic remain. Comments in `DomainRouter.tsx`, `supabaseClient.ts`, and `domains.ts` correctly describe the new single-domain architecture.

### Migration 2: Auth
**Status: CLEAN** -- Auth uses `onAuthStateChange` with safety timeouts, magic link handling is separated from OAuth, and the flow works correctly on the single domain.

---

### Migration 3: Lessons Table Removal -- STILL HAS BREAKING CODE

Despite the previous cleanup rounds, **10 files still have active `lessons(...)` joins that WILL fail at runtime**, and **7+ files render data from `booking.lessons?.xxx` that will always be null**.

#### 3A. Supabase Queries Still Joining Deleted `lessons` Table (RUNTIME ERRORS)

| File | Query joins `lessons(...)` |
|------|---------------------------|
| `src/pages/TrainerBookings.tsx` line 119 | `lessons(id, title, price, duration_minutes, location, payment_timing)` |
| `src/pages/TrainerEarnings.tsx` line 183 | `lessons(title, price, payment_timing)` |
| `src/pages/TrainerAnalytics.tsx` line 101 | `lessons(price)` |
| `src/pages/PlayerBookings.tsx` line 69 | `lessons(title, price, location)` |
| `src/pages/PlayerDashboard.tsx` line 151 | `lessons(title, location)` |
| `src/pages/TrainerCyclus.tsx` line 139 | `lessons(title)` |
| `src/components/trainer/DeleteSlotDialog.tsx` lines 113, 195 | `lessons(title)` in two queries |
| `supabase/functions/auto-create-invoice/index.ts` line 54 | `lessons:lesson_id(id, title, price, duration_minutes)` |

**Fix:** Remove the `lessons(...)` join from each query. Replace with slot-level fields already available (`price_per_session`, `cyclus_name`, `location_id` with `locations(name)`).

#### 3B. TypeScript Interfaces Still Defining `lessons` Property

| File | Interface with `lessons` |
|------|--------------------------|
| `src/pages/TrainerBookings.tsx` lines 48-55 | `lessons: { id, title, price, duration_minutes, location, payment_timing }` |
| `src/pages/TrainerEarnings.tsx` lines 49-53 | `lessons: { title, price, payment_timing }` |
| `src/pages/TrainerCyclus.tsx` line 65 | `lesson_title: string` |
| `src/pages/PlayerDashboard.tsx` line 41 | `lessonTitle: string` in `UpcomingBooking` |

**Fix:** Remove `lessons` from interfaces. Add `price_per_session`, `cyclus_name` where needed.

#### 3C. UI Rendering `booking.lessons?.xxx` (Will Show Null/Fallback)

| File | What it renders |
|------|-----------------|
| `src/pages/TrainerBookings.tsx` lines 540-590 | lesson title, price, location, payment_timing |
| `src/pages/TrainerEarnings.tsx` lines 289-777 | lesson title, price for invoice creation and display |
| `src/pages/PlayerBookings.tsx` lines 227-338 | lesson title, price, location |
| `src/pages/PlayerDashboard.tsx` line 201 | `lessonTitle` for upcoming bookings |
| `src/components/trainer/EditBookingDialog.tsx` line 130 | `booking.lessons?.price` for payment amount |
| `src/components/trainer/CreateInvoiceDialog.tsx` line 26 | `lessonTitle` in BookingData interface |

**Fix:** Replace with `availability_slots.cyclus_name || 'Training Session'` for titles, `availability_slots.price_per_session` for prices, and `availability_slots.locations?.name` for locations.

#### 3D. Dead State Variables (No Functional Impact, Just Clutter)

| File | Dead code |
|------|-----------|
| `src/pages/TrainerDashboard.tsx` line 69 | `const [lessons, setLessons] = useState([])` + `setLessons([])` |
| `src/pages/TrainerCalendar.tsx` line 62 | Same pattern |
| `src/pages/academy/AcademyCalendar.tsx` line 90 | Same pattern |
| `src/pages/TrainerDashboard.tsx` lines 242-243 | `lesson_id: null, lesson_title: null` in slot transforms |
| `src/pages/TrainerCalendar.tsx` lines 245-246 | Same |

**Fix:** Remove dead state and null assignments.

#### 3E. `lesson_id` Still in Insert/Update Payloads

| File | What writes `lesson_id` |
|------|-------------------------|
| `src/components/trainer/BookForPlayerDialog.tsx` lines 252, 314 | `lesson_id: null` in booking inserts |
| `src/pages/OpenSlots.tsx` line 537 | `lesson_id: null` in slot prop |
| `src/pages/Trainers.tsx` line 312 | `.is('lesson_id', null)` filter on availability_slots |
| `supabase/functions/generate-proposals/index.ts` line 63 | `lesson_id` in slot interface |

**Fix:** Remove `lesson_id: null` from inserts (column may still exist in DB but shouldn't be actively written). Remove filter on `lesson_id` from Trainers page.

#### 3F. Edge Functions Still Using Lessons

| Function | Issue |
|----------|-------|
| `auto-create-invoice/index.ts` lines 43-54 | Selects `lesson_id` and joins `lessons:lesson_id(...)` |
| `bulk-cleanup-users/index.ts` line 128 | `from("lessons").delete()` |
| `request-account-deletion/index.ts` line 149 | `from("lessons").delete()` |
| `delete-user/index.ts` line 164 | `from("lessons").delete()` |

**Fix:** Remove lessons join from auto-create-invoice, use `price_per_session` and `cyclus_name` instead. Remove `from("lessons").delete()` from cleanup functions (table no longer exists).

#### 3G. Email Templates Using `lessonTitle`

| File | Issue |
|------|-------|
| `src/lib/email.ts` | `lessonTitle` parameter in `sendBookingConfirmation`, `sendBookingCancellation`, `sendReviewRequest` |
| `supabase/functions/send-email/index.ts` | `lessonTitle` in template data, email subjects like `Booking Confirmed: ${data.lessonTitle}` |

**Fix:** Rename to `sessionTitle` or keep as-is (these are just parameter names, not DB references). The data passed in will just need to come from `cyclus_name` instead of `lessons.title`.

---

### Migration 4: Stripe to Mollie

#### 4A. Database Tables (via types.ts)
The auto-generated `types.ts` still references `academy_stripe_accounts`, `club_stripe_accounts`, and `trainer_stripe_accounts` tables. These tables likely still exist in the database but are unused.

**Fix (DB migration):** Drop these three tables:
- `academy_stripe_accounts`
- `club_stripe_accounts`  
- `trainer_stripe_accounts`

This will auto-update `types.ts` on next sync.

#### 4B. Code References
- `src/lib/subscription.ts` line 7: `productId: string | null` in `SubscriptionInfo` -- always set to `null`
- `src/lib/subscription.ts` line 41: `getTierFromProductId()` -- deprecated, always returns `'trial'`
- `src/hooks/useAuth.tsx` line 118: `productId: null` comment about Stripe
- `src/pages/TrainerSettings.tsx` line 38: `subscription?.productId` check

**Fix:** Remove `productId` from `SubscriptionInfo` interface, remove `getTierFromProductId()`, update `TrainerSettings.tsx` to not check `productId`.

#### 4C. Stale Comments
Several files have "No longer using Stripe" or "legacy check-trainer-subscription" comments that can be cleaned up for clarity.

---

### Migration 5: Subscription Plan Schema Cleanup

- `src/hooks/usePricingPlans.ts` line 17: `max_lessons: number | null` -- lessons don't exist anymore
- `src/pages/admin/AdminPricing.tsx` line 136: Shows "Max Lessons" column in admin pricing table
- `src/components/admin/PlanEditDialog.tsx` line 236: "Max Lessons" input field

**Fix:** Remove `max_lessons` references from the admin UI. Optionally drop the column from `subscription_plans` table via migration.

---

### Summary of Work

| Category | Files | Severity |
|----------|-------|----------|
| Breaking queries (lessons joins) | 8 files + 1 edge function | CRITICAL -- will error at runtime |
| UI rendering null lesson data | 6 files | HIGH -- shows empty/broken UI |
| Dead state / null assignments | 5 files | LOW -- clutter only |
| Edge functions referencing lessons | 4 edge functions | MEDIUM -- errors on cleanup/invoice flows |
| Stripe table remnants | DB migration | LOW -- unused tables |
| `productId` / `getTierFromProductId` | 4 files | LOW -- dead code |
| `max_lessons` admin UI | 3 files | LOW -- misleading UI |
| Email `lessonTitle` naming | 2 files | LOW -- cosmetic |

### Execution Order

1. Fix all breaking `lessons(...)` queries and update interfaces (8 frontend files)
2. Fix UI rendering to use slot-level data instead of `booking.lessons?.xxx` (6 files)
3. Fix edge functions: `auto-create-invoice`, `bulk-cleanup-users`, `delete-user`, `request-account-deletion` (4 functions)
4. Remove dead state, null assignments, and `lesson_id` from inserts (8 files)
5. Remove Stripe leftovers: `productId`, `getTierFromProductId`, stale comments (4 files)
6. Remove `max_lessons` from admin UI (3 files)
7. DB migration: drop `academy_stripe_accounts`, `club_stripe_accounts`, `trainer_stripe_accounts` tables

