

## 7. Double-Submit Protection & 8. TanStack Query Retry Tuning

### 7 — Double-Submit Protection

Most forms already use a `disabled={isLoading}` or `disabled={saving}` pattern, but not all critical flows are covered consistently. The fix is targeted:

**Critical payment/booking buttons to audit and fix (if missing):**
- `BookingSummary.tsx` — the public-facing "Book" button (`booking` state)
- `QuickBookDialog.tsx` — trainer-side quick book (`isLoading` state — already looks correct)
- `CycleRegistration.tsx` — cycle signup flow
- `CycleApplicationForm.tsx` — intake application submit

**Additional safety net — disable on first click until async completes:**
For each of these, ensure the submit button has `disabled={isSubmitting}` AND the handler has an early return guard (`if (isSubmitting) return;`) at the top to cover rapid double-taps that bypass React's re-render cycle.

**Files to edit:** ~4-6 component files, adding the early-return guard pattern where missing.

---

### 8 — TanStack Query Retry Strategy

**Current config** (`src/App.tsx`):
```
retry: 1, staleTime: 60s, gcTime: 10min, refetchOnWindowFocus: false
```

**Problem:** A single retry with no backoff means one transient network blip = permanent failure until manual refresh. Too aggressive for mobile users.

**New config:**
```typescript
queries: {
  staleTime: 60_000,
  gcTime: 10 * 60 * 1000,
  refetchOnWindowFocus: false,
  retry: 2,
  retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
},
mutations: {
  retry: 0,  // Never auto-retry mutations (payments, bookings, etc.)
},
```

This gives read queries 3 total attempts (initial + 2 retries) with exponential backoff (1s, 2s), while mutations stay at zero retries to prevent duplicate side effects.

**File to edit:** `src/App.tsx` only.

---

### Summary of all file changes
- `src/App.tsx` — update QueryClient retry config
- `src/components/booking/BookingSummary.tsx` — add early-return guard
- `src/components/trainer/QuickBookDialog.tsx` — verify/add early-return guard
- `src/pages/CycleRegistration.tsx` — add early-return guard
- `src/components/cycles/CycleApplicationForm.tsx` — add early-return guard

