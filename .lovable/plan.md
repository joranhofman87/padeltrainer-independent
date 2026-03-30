

# Testability Audit & Preparation

## Overview
PadelTrainer.ai is a multi-role padel sports platform (React + Vite + Supabase) with 5 user roles: player, trainer, admin, club, academy. The app already has email/password auth, a top-level error boundary, and a 404 catch-all. The main gaps are: almost no `data-testid` attributes and no test accounts.

## Step 1: Authentication — No Changes Needed
The app already supports email/password login at `/app/auth` alongside Google OAuth. The signup pages (`/app/signup/player`, `/app/signup/trainer`, etc.) also use email/password. No auth changes required.

## Step 2: Create Test Accounts
Use the `signup-user` edge function (which the app's `signUpWithEmail` calls) to create pre-confirmed accounts for each role. Then assign roles via `user_roles` table inserts, and create the required profile records (trainer_profiles, etc.) where needed.

Accounts to create:
- `lisa-test-player@test.com` → player role
- `lisa-test-trainer@test.com` → trainer role + trainer_profiles row
- `lisa-test-admin@test.com` → admin role
- `lisa-test-club@test.com` → club role (will need a club_profiles + club_managers link)
- `lisa-test-academy@test.com` → academy role (will need academy_profiles + academy_managers link)

All with password `LisaLoops-Test-2024!`. Created via the edge function (auto-confirms email) + direct DB inserts for roles/profiles.

Write `test-accounts.json` to project root with results.

## Step 3: Add `data-testid` Attributes
Currently only ~10 testids exist (auth page + 4 nav items). Add testids to these key areas:

| Area | Files | Elements to Tag |
|------|-------|-----------------|
| **Auth pages** | `Auth.tsx`, `PlayerSignup.tsx`, `TrainerSignup.tsx`, `ClubSignup.tsx`, `AcademySignup.tsx`, `ForgotPassword.tsx`, `ResetPassword.tsx` | Form containers, inputs, submit buttons, error messages |
| **Signup role picker** | `SignupRolePicker.tsx` | Page container, each role card |
| **Dashboards** | `PlayerDashboard.tsx`, `TrainerDashboard.tsx`, `AcademyDashboard.tsx`, `ClubDashboard.tsx`, `AdminDashboard.tsx` | Page containers, stat cards, empty states |
| **Sidebars/Nav** | `TrainerSidebar.tsx`, `PlayerSidebar.tsx`, `AcademySidebar.tsx`, `ClubSidebar.tsx`, `AdminSidebar.tsx` | All nav items (many already missing testids) |
| **Key feature pages** | `TrainerCalendar.tsx`, `TrainerPlayers.tsx`, `TrainerCycles.tsx`, `AcademyInvoices.tsx`, `AcademyCycles.tsx`, `Locations.tsx`, `Trainers.tsx` | Page containers, primary action buttons, data tables/lists, empty states |
| **Dialogs/Modals** | `CreateCustomInvoiceDialog.tsx`, `EditInvoiceDialog.tsx`, `AddSlotDialog.tsx` | Dialog containers, form inputs, save/cancel buttons |
| **404 page** | `NotFound.tsx` | Add `data-testid="page-not-found"` |
| **Error boundary** | `ErrorBoundary.tsx` | Add `data-testid="error-boundary-fallback"` |
| **Settings pages** | `TrainerSettings.tsx`, `PlayerSettings.tsx`, `AcademySettings.tsx`, `NotificationSettings.tsx` | Page containers, settings cards |

Naming convention: `page-{name}`, `nav-{role}-{item}`, `form-{name}`, `input-{name}`, `btn-{action}`, `dialog-{name}`, `empty-state-{context}`.

## Step 4: Error Boundaries & Empty States
- **Error boundary**: Already exists at top level + `FeatureErrorBoundary` for sections. Add testid to fallback UI.
- **Empty states**: Audit key list/table pages (players, cycles, invoices, bookings) — most likely already have empty states via the query pattern. Add `data-testid="empty-state"` where missing.
- **Loading states**: Already handled via React Query + `PageLoader`. No changes needed.

## Step 5: Route & Navigation
- **404 handler**: Already exists (`<Route path="*" element={<NotFound />} />`). Add testid.
- **Deep-linking**: Routes use URL params and React Query — no in-memory state dependencies found.
- **Dead links**: Calendar settings route is correctly commented out. Settings card was already removed in a prior change.

## Step 6: Console Error Cleanup
- No missing env vars (`.env` is auto-generated).
- No broken imports visible.
- The `src/lib/supabaseClient.ts` duplicates the auto-generated client — not a console error source but worth noting.

## Step 7: Output Files
Create `testability-report.md` and `test-accounts.json` in project root.

## Summary of Changes

| File | Change |
|------|--------|
| ~25 component/page files | Add `data-testid` attributes to interactive elements |
| `NotFound.tsx` | Add `data-testid="page-not-found"` |
| `ErrorBoundary.tsx` | Add `data-testid="error-boundary-fallback"` |
| `testability-report.md` | New file — full audit report |
| `test-accounts.json` | New file — test account credentials |
| Edge function call + DB inserts | Create 5 test accounts with correct roles |

No application behavior or features will be changed. All modifications are additive (testids, report files, test accounts).

