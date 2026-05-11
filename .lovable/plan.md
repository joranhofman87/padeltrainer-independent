# Enable strictNullChecks (#10) — phased rollout

## Goal

Flip `strictNullChecks: true` in `tsconfig.json` and `tsconfig.app.json` to catch null/undefined bugs at compile time. Currently 88 errors across 42 files block this. Fix in focused waves so each commit is reviewable and revertable, then enable the flag in the final wave.

## Strategy

- Keep `strictNullChecks: false` until the very last step. Do **not** flip it incrementally per file (TS doesn't allow per-file overrides without project references, and turning it on with errors breaks dev/CI).
- After each wave, re-run `npx tsc -p tsconfig.app.json --noEmit --strictNullChecks` to confirm the error count drops as expected.
- Fix patterns (in order of preference):
  1. **Tighten the type at the source** — if a query/helper returns `string | null` but logically can't be null after a guard, narrow with an `if (!x) return` early exit.
  2. **Optional chaining + nullish coalescing** (`x?.y ?? fallback`) for display-only paths.
  3. **Non-null assertion `!`** only when there's a runtime invariant the type system can't see, with a `// reason: …` comment.
  4. **Update generated types** are off-limits (`src/integrations/supabase/types.ts`). Wrap call sites instead.

## Waves

### Wave 1 — Library/util layer (clean foundation, 14 errors, 6 files)

Fix shared helpers first so downstream pages get free wins.

- `src/lib/certifications.ts` (9)
- `src/lib/academy.ts` (2)
- `src/lib/club.ts` (1)
- `src/lib/priorityClaims.ts` (1)
- `src/hooks/useAdminData.ts` (1)

### Wave 2 — Public marketing/profile pages (28 errors, 6 files)

Read-heavy, low risk.

- `src/pages/LocationDetail.tsx` (9)
- `src/pages/marketing/BlogPost.tsx` (6)
- `src/pages/AcademyPublicProfile.tsx` (6)
- `src/pages/TrainerProfile.tsx` (4)
- `src/components/home/HomeFeaturedSections.tsx` (4)
- `src/pages/TrainersCity.tsx` (2)

### Wave 3 — Invoices (10 errors, 7 files)

Cluster — same null-handling patterns repeat across trainer + academy parity.

- `src/pages/trainer/TrainerInvoices.tsx` (3)
- `src/pages/academy/AcademyInvoices.tsx` (3)
- `src/pages/trainer/TrainerEditInvoice.tsx` (1)
- `src/pages/trainer/TrainerCreateInvoice.tsx` (1)
- `src/pages/academy/AcademyEditInvoice.tsx` (1)
- `src/pages/academy/AcademyCreateInvoice.tsx` (1)
- `src/components/invoices/EditInvoiceDialog.tsx` (1)
- `src/components/invoices/CreateCustomInvoiceDialog.tsx` (1)
- `src/components/trainer/InvoiceList.tsx` (1)

### Wave 4 — Slots, cycles, calendars (16 errors, 11 files)

Higher complexity — interactive scheduling code. Touch each file in parity (trainer + academy).

- `src/pages/academy/AcademySlotDetail.tsx` (3)
- `src/components/trainer/AddSlotDialog.tsx` (3)
- `src/pages/trainer/TrainerSlotDetail.tsx` (2)
- `src/pages/CycleRegistration.tsx` (2)
- `src/components/academy/SlotDetailDialog.tsx` (1)
- `src/components/cycles/CycleForm.tsx` (1)
- `src/components/cycles/IntakeRequestDetailSheet.tsx` (1)
- `src/pages/club/ClubCalendar.tsx` (1)
- `src/pages/club/ClubCycles.tsx` (1)
- `src/pages/academy/AcademyCalendar.tsx` (1)
- `src/pages/TrainerScheduleOverview.tsx` (1)
- `src/pages/OpenSlots.tsx` (1)

### Wave 5 — Onboarding, invitations, misc (10 errors, 9 files)

Long tail.

- `src/pages/club/ClubTrainerInvitation.tsx` (2)
- `src/pages/academy/AcademyTrainerInvitation.tsx` (2)
- `src/pages/club/ClubSettings.tsx` (1)
- `src/pages/academy/AcademyPlayerDetail.tsx` (1)
- `src/pages/academy/AcademyIntakeRequests.tsx` (1)
- `src/pages/TrainerIntakeRequests.tsx` (1)
- `src/components/trainer/onboarding/OnboardingStep3Schedule.tsx` (1)
- `src/components/reviews/TrainerReviews.tsx` (1)
- `src/components/profiles/VideoManager.tsx` (1)
- `src/components/profiles/VideoGallery.tsx` (1)

### Wave 6 — Flip the flag

After waves 1-5 reduce the count to 0:

- `tsconfig.json`: `"strictNullChecks": true`
- `tsconfig.app.json`: `"strictNullChecks": true`
- Final verification: `npx tsc -p tsconfig.app.json --noEmit` clean.
- No revert path needed because all callsites are now safe.

## This message scope

Execute **Wave 1 only** (library/util layer, ~14 errors across 6 files). Stop and report the new error count so the next wave can be picked up in a fresh message — keeps each round reviewable. Subsequent waves (2-6) will each be their own message.
