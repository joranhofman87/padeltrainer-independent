# Test baseline (Vitest)

Snapshot taken before manual Trainer QA and Playwright work. Use this to tell **pre-existing** unit-test failures from regressions introduced later.

## How to reproduce

```bash
cd padeltrainer
npm test
```

| Metric | Value |
|--------|-------|
| **Command** | `npm test` (`vitest run`) |
| **Date captured** | 2026-05-30 |
| **Git context** | After commit `0f3b5382` (pre-QA dead-code cleanup) |
| **Test files** | 29 total — **23 passed**, **6 failed** |
| **Tests** | **343 passed**, **18 failed** (361 total) |
| **Duration** | ~5–6s |

Related checks (all passing at baseline): `npm run build`, `npx tsc --noEmit`.

---

## Summary by category

| Category | Failures | Pre-QA cleanup related? |
|----------|----------|-------------------------|
| Stale test expectations (app changed, tests not updated) | 8 | No |
| Test setup — i18n not initialized in RTL | 9 | No |
| Test setup — incomplete Supabase mocks | 2 | No |
| Test setup — auth error shape assertion | 1 | No |
| Component/DOM — Radix Slider a11y attributes | 1 | No (slider wrapper was **not** removed) |

**None of the 18 failures appear caused by the pre-QA cleanup** (removed Lovable docs, unused shadcn wrappers, `lovable-tagger`, stale `config.toml` entries). Deleted UI files (`carousel`, `drawer`, etc.) have no failing tests.

---

## Failed test files (detail)

### 1. `src/lib/auth.test.ts` (3 failures)

| Test name | Error summary | Category | Cleanup related? |
|-----------|---------------|----------|------------------|
| `Auth module > signInWithEmail > returns error on invalid credentials` | `expect(result.error).toEqual(mockError)` — received extra fields (`name: 'AuthError'`, `code`, `status`) on top of `message: 'Invalid login credentials'` | Stale assertion — Supabase/auth error object shape | **No** |
| `Auth module > setUserRole > inserts role and creates trainer profile for trainer role` | `TypeError: supabase.from(...).select is not a function` in `ensureTrainerProfile` (`auth.ts:294`) | Incomplete Supabase chain mock | **No** |
| `Auth module > getProfile > returns profile for user` | `supabase.from` called with `'profiles_owner'`, test expects `'profiles'` | Stale assertion — view renamed to `profiles_owner` | **No** |

---

### 2. `src/lib/validation.test.ts` (2 failures)

| Test name | Error summary | Category | Cleanup related? |
|-----------|---------------|----------|------------------|
| `calculatePasswordStrength > returns fair for 6+ lowercase only` | `result.checks.minLength` expected `true` for `'abcdef'` (6 chars), got `false` | Stale expectations — `calculatePasswordStrength` uses **min length 8** (`validation.ts:100`) | **No** |
| `calculatePasswordStrength > returns good for mixed case + number` | `result.score` expected `>= 3`, received `2` | Stale expectations — scoring thresholds changed vs test | **No** |

---

### 3. `src/pages/TrainerSignup.test.tsx` (3 failures)

| Test name | Error summary | Category | Cleanup related? |
|-----------|---------------|----------|------------------|
| `TrainerSignup > validates password length` | `Unable to find` text `'Password must be at least 6 characters'` | Stale expectations — `TrainerSignup` Zod schema requires **8** characters (`TrainerSignup.tsx:24`) | **No** |
| `TrainerSignup > calls signUpWithEmail on valid submission` | Mock called with 6 args; test expected 5 — extra arg `'trainer'` at end | Stale expectations — trainer role passed on signup | **No** |
| `TrainerSignup > calls signInWithGoogle when Google button is clicked` | `signInWithGoogle` mock **never called** after click | Test setup / selector — likely i18n key `social.google` vs rendered label, or wrong mock wiring | **No** (relevant to Trainer QA area, not cleanup) |

---

### 4. `src/components/booking/BookingConfirmation.test.tsx` (4 failures)

| Test name | Error summary | Category | Cleanup related? |
|-----------|---------------|----------|------------------|
| `BookingConfirmation > renders request_sent variant with trainer name` | `Unable to find` `'Request Sent!'` — DOM shows `bookingConfirmation.requestSentTitle` | i18n not loaded in test render | **No** |
| `BookingConfirmation > renders booked variant with confirmation` | `Unable to find` `'Booking Confirmed!'` — raw i18n keys in DOM | i18n not loaded in test render | **No** |
| `BookingConfirmation > shows manual invoicing notice when enabled` | Hardcoded English copy not found (i18n keys rendered) | i18n not loaded in test render | **No** |
| `BookingConfirmation > has navigation buttons` | Button labels not found (i18n keys e.g. `bookingConfirmation.viewMyBookings`) | i18n not loaded in test render | **No** |

---

### 5. `src/components/booking/SlotList.test.tsx` (5 failures)

| Test name | Error summary | Category | Cleanup related? |
|-----------|---------------|----------|------------------|
| `SlotList > renders slot date, time, and location` | `Unable to find` `/10:00/` (and related time/location strings) — heading shows `booking.availableTimeSlots` | i18n not loaded; possible locale/time formatting mismatch | **No** |
| `SlotList > shows "Available Time Slots" heading when no cycles` | Expected `'Available Time Slots'`, got `booking.availableTimeSlots` | i18n not loaded in test render | **No** |
| `SlotList > shows "Individual Sessions" heading when cycles exist` | Expected `'Individual Sessions'`, got i18n key | i18n not loaded in test render | **No** |
| `SlotList > shows empty state when no slots and no cycles` | Expected `'No available slots at the moment'`, got i18n key | i18n not loaded in test render | **No** |
| `SlotList > shows alternative empty text when no slots but cycles exist` | Expected `'No individual sessions available'`, got i18n key | i18n not loaded in test render | **No** |

---

### 6. `src/components/ui/slider.test.tsx` (1 failure)

| Test name | Error summary | Category | Cleanup related? |
|-----------|---------------|----------|------------------|
| `Slider > supports min and max props` | `container.firstChild` missing `aria-valuemin="0"` / `aria-valuemax="10"` (received `null`) | Radix Slider DOM structure — a11y attrs may live on thumb/root child, not firstChild | **No** (`slider.tsx` retained in cleanup) |

---

## Passing context (for QA planning)

- **23/29** test files fully green, including edge-function unit tests under `supabase/functions/**` and most lib/hooks coverage.
- Failures are concentrated in **booking UI tests** (i18n), **TrainerSignup tests** (stale mocks/copy), **auth/validation libs** (stale mocks/rules), and one **Slider** DOM assertion.
- Fixing these is **out of scope** for the pre-QA cleanup commit; track fixes separately so Trainer manual QA / Playwright are not blocked by unrelated Vitest debt.

---

## When to update this doc

Re-run `npm test` and refresh counts after:

- Trainer signup/onboarding P0+P1 deploy
- i18n test harness changes
- Intentional Vitest repair PRs

Do not treat `npm test` exit code 0 as a gate until this baseline is addressed or explicitly waived.
