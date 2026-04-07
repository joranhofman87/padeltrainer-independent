

# Critical Flow Test Coverage — Gap Analysis & Plan

## Current Coverage

| Critical Flow | Unit Tests | Component Tests | E2E Tests | Verdict |
|---|---|---|---|---|
| **Form Registrations** (CycleApplicationForm) | `cycles.test.ts` (submitIntakeRequest logic) | None | `registration.spec.ts` (7 tests, E2E only) | **Component test missing** |
| **Calendar Bookings** (SlotList, BookingSummary) | `calendar.test.ts` (date helpers) | `BookingConfirmation.test.tsx` (confirmation only) | `booking.spec.ts` (shallow, no slot selection) | **Component test missing for slot selection + summary** |
| **Sign Ups** (Player, Trainer, Academy) | `auth.test.ts` (signUpWithEmail, setUserRole — 13 tests) | None | `auth.spec.ts` + `roles.spec.ts` (E2E page loading) | **Component tests missing for form validation** |
| **Login** | `auth.test.ts` (signInWithEmail, signInWithGoogle — 4 tests) | None | `auth.spec.ts` (3 E2E tests) | **Component test missing** |
| **Invoice Creation** (CreateInvoiceDialog) | `invoiceCalc.test.ts` (math — 36 tests) | None | `payments.spec.ts` (public pay page only) | **Component test missing for creation flow** |

## The Gaps

Your **pure logic** is well-tested (auth functions, invoice math, validation). Your **E2E tests** cover page loading but not user interactions. The missing layer is **component tests** that verify form behavior, validation, and state transitions without needing a real backend.

## Plan — 5 Component Test Files

### 1. `src/components/cycles/CycleApplicationForm.test.tsx`
Tests the 1,091-line registration form that guests use to sign up for training cycles:
- Renders all required fields (name, email, phone, lesson type)
- Group-of-4 pre-selected by default
- Phone validation rejects invalid numbers
- Email validation
- Shows price breakdown when lesson type selected
- Submits with correct payload structure (mock `submitIntakeRequest`)

### 2. `src/components/booking/SlotList.test.tsx`
Tests the slot selection component:
- Renders available slots with price, time, location
- Highlights selected slot
- Calls `onSelect` callback with correct slot data
- Shows empty state when no slots available
- Displays "Individual Sessions" label when cycles exist

### 3. `src/pages/TrainerSignup.test.tsx`
Tests the trainer signup page form (same pattern applies to Player/Academy):
- Renders email, password, full name, phone fields
- Validates required fields on submit
- Shows password strength indicator
- Calls `signUpWithEmail` with correct arguments (mocked)
- Shows error toast on failure
- Google OAuth button present and clickable

### 4. `src/pages/Auth.test.tsx`
Tests the login page:
- Renders email and password inputs
- Shows error for empty submission
- Calls `signInWithEmail` on submit (mocked)
- Shows error toast for invalid credentials
- Links to forgot-password, player signup, trainer signup
- Google OAuth button present

### 5. `src/components/trainer/CreateInvoiceDialog.test.tsx`
Tests the invoice creation dialog:
- Renders player name, line items, VAT rate selector
- Pre-fills from booking data when provided
- Adds/removes line items
- Calculates subtotal, VAT, and total correctly
- Validates required fields before submit
- Calls Supabase insert with correct payload (mocked)

## File Summary

| File | Change |
|---|---|
| `src/components/cycles/CycleApplicationForm.test.tsx` | New — registration form validation, defaults, submission |
| `src/components/booking/SlotList.test.tsx` | New — slot rendering, selection, empty states |
| `src/pages/TrainerSignup.test.tsx` | New — signup form validation, submission, OAuth |
| `src/pages/Auth.test.tsx` | New — login form validation, submission, navigation links |
| `src/components/trainer/CreateInvoiceDialog.test.tsx` | New — invoice creation form, line items, VAT calculation |

