

## Critical Pre-Launch Fixes (Excluding Cookie Consent)

Four items to implement:

### 1. Global Unhandled Error/Rejection Catching (`src/main.tsx`)
Add `window.addEventListener('error')` and `window.addEventListener('unhandledrejection')` before `createRoot`, piping to `logger.error`. This catches silent promise failures on flaky mobile networks.

### 2. Offline/Network-Down Banner
Create a new `src/components/OfflineBanner.tsx` component that listens to `window.online`/`offline` events and shows a fixed banner at the top of the screen when connectivity drops. Add it to `App.tsx` inside the providers.

### 3. Migrate `console.error` → `logger.error` in Client Files
There are ~525 `console.error` calls across 48 client-side files (excluding `supabase/functions/` which correctly uses `console.error` for Deno). Each will be replaced with `logger.error(message, error, { component })`, adding the import where missing. This is the bulk of the work — covers components like `ReassignPlayerDialog`, `RatingHistoryChart`, `ClubSlotDetailSheet`, `EditPlayerDialog`, `certifications.ts`, `AdminTrainerReviewsTab`, `ImportLocationsDialog`, `AddAcademyDialog`, `EditAcademyTrainerDialog`, `RequestLocationDialog`, etc.

### 4. Split BookLesson.tsx into Sub-Components
The 1,201-line file handles the most critical user flow (payment). Split into:
- `src/components/booking/BookingTrainerCard.tsx` — trainer info card (lines 780-810)
- `src/components/booking/CycleBundleList.tsx` — cycle bundle selection cards (lines 812-868)
- `src/components/booking/SlotList.tsx` — individual slot selection cards (lines 870-981)
- `src/components/booking/BookingSummary.tsx` — summary sidebar with notes, terms, price, and book button (lines 984-1194)
- `src/components/booking/BookingConfirmation.tsx` — success/request-sent states (lines 697-751)
- `src/pages/BookLesson.tsx` — orchestrator with state, data fetching, and `handleBook` logic (~350 lines)

### Files to Create
- `src/components/OfflineBanner.tsx`
- `src/components/booking/BookingTrainerCard.tsx`
- `src/components/booking/CycleBundleList.tsx`
- `src/components/booking/SlotList.tsx`
- `src/components/booking/BookingSummary.tsx`
- `src/components/booking/BookingConfirmation.tsx`

### Files to Edit
- `src/main.tsx` — add global error listeners
- `src/App.tsx` — add `OfflineBanner`
- `src/pages/BookLesson.tsx` — refactor to use sub-components
- ~48 client-side files — `console.error` → `logger.error` migration

