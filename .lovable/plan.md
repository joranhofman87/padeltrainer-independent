

# Translation Audit: Hardcoded Strings Still in the App

## Findings

After scanning the entire codebase, there are **hundreds of hardcoded English (and some Dutch) strings** that bypass the i18n system. Here's the breakdown by severity:

### Critical — User-facing pages with hardcoded text

| Page/Component | Hardcoded strings | Examples |
|---|---|---|
| **TrainerBookings.tsx** | ~20 strings | "Manage Bookings", "All caught up!", "No upcoming lessons", "Cancel Booking", "No Charge", "Due After", "Payment Pending" |
| **TrainerEarnings.tsx** | ~10 strings | "Mollie Connected!", "Payment Recorded", "All caught up!", "No pending payments" |
| **TrainerAnalytics.tsx** | ~8 strings | "Quick Insights", "Key performance indicators", "Number of Reviews" |
| **TrainerProfile.tsx** | ~4 strings | "Publish profile", "Upgrade to publish" |
| **TrainerSetupChecklist.tsx** | 5 strings | "Add your first time slots", "Complete your profile details", "Publish your profile" |
| **MollieCallback.tsx** | ~6 strings | "Connecting your Mollie account...", "Successfully connected!", "Connection failed" |
| **CalendarSettings.tsx** | ~4 strings | "Calendar Connected!", "Connection Failed" |
| **PublicRatingCard.tsx** | 2 strings | "Rating not found", "Go to homepage" |

### Medium — Hardcoded Dutch text (wrong language for non-NL users)

| Page | Hardcoded Dutch | Should be |
|---|---|---|
| **AcademyEditInvoice.tsx** | "Factuur niet gevonden", "Terug naar facturen", "Factuur bewerken", "Prijzen zijn inclusief BTW" | Translation keys |
| **TrainerEditInvoice.tsx** | Same Dutch strings | Translation keys |

### Low — Toast messages (many pages)

~50+ toast calls across TrainerBookings, TrainerEarnings, TrainerScheduleOverview, AcademyTrainerDetail, ClubSettings with hardcoded titles like "Error", "Booking Confirmed", "Lesson Cancelled", "Avatar updated".

### Low — Admin pages (internal, but still)

AdminUsers, AdminClubs, AdminAcademies, AdminTrainers — all have hardcoded English. Lower priority since only admins see these.

### Low — Onboarding & form placeholders

OnboardingStep1Goal labels ("Fill empty slots", "Get more new players"), OnboardingStep1Profile placeholder ("Your full name"), AddSlotDialog/DuplicateCyclusDialog ("Pick a date").

---

## Plan

### Phase 1 — Fix hardcoded Dutch (highest priority — currently broken for non-NL users)
- **AcademyEditInvoice.tsx** + **TrainerEditInvoice.tsx**: Replace Dutch strings with `t()` calls using existing invoice translation keys

### Phase 2 — Trainer-facing pages
- **TrainerBookings.tsx**: Add ~20 keys to `trainer.json` (all 5 locales), replace hardcoded strings
- **TrainerEarnings.tsx**: Add ~10 keys, replace strings
- **TrainerAnalytics.tsx**: Add ~8 keys, replace strings
- **TrainerProfile.tsx**: Add ~4 keys, replace strings
- **TrainerSetupChecklist.tsx**: Add 5 keys, replace labels

### Phase 3 — Shared/utility pages
- **MollieCallback.tsx**: Add ~6 keys to `common.json`
- **CalendarSettings.tsx**: Add ~4 keys to `trainer.json`
- **PublicRatingCard.tsx**: Add 2 keys to `common.json`

### Phase 4 — Toast messages
- Sweep all toast calls in trainer/academy pages, replace with `t()` calls
- Add corresponding keys to locale files

### Phase 5 — Onboarding & form placeholders
- OnboardingStep1Goal, OnboardingStep1Profile, OnboardingStep2Profile: replace labels/placeholders
- AddSlotDialog, DuplicateCyclusDialog: "Pick a date" → `t()` call

### Phase 6 — Admin pages (optional, low priority)
- AdminUsers, AdminClubs, AdminAcademies, AdminTrainers: replace if desired

## File summary

| File | Change |
|------|--------|
| `src/pages/academy/AcademyEditInvoice.tsx` | Replace hardcoded Dutch with `t()` |
| `src/pages/trainer/TrainerEditInvoice.tsx` | Replace hardcoded Dutch with `t()` |
| `src/pages/TrainerBookings.tsx` | Replace ~20 hardcoded strings |
| `src/pages/TrainerEarnings.tsx` | Replace ~10 hardcoded strings |
| `src/pages/TrainerAnalytics.tsx` | Replace ~8 hardcoded strings |
| `src/pages/TrainerProfile.tsx` | Replace ~4 hardcoded strings |
| `src/components/trainer/TrainerSetupChecklist.tsx` | Replace 5 hardcoded labels |
| `src/pages/MollieCallback.tsx` | Replace ~6 hardcoded strings |
| `src/pages/CalendarSettings.tsx` | Replace ~4 hardcoded strings |
| `src/pages/marketing/PublicRatingCard.tsx` | Replace 2 hardcoded strings |
| `src/components/trainer/onboarding/OnboardingStep1Goal.tsx` | Replace 5 labels |
| `src/components/trainer/onboarding/OnboardingStep1Profile.tsx` | Replace placeholder |
| `src/components/trainer/onboarding/OnboardingStep2Profile.tsx` | Replace placeholder |
| `src/components/trainer/AddSlotDialog.tsx` | Replace "Pick a date" |
| `src/components/trainer/DuplicateCyclusDialog.tsx` | Replace "Pick a date" |
| `src/i18n/locales/{en,nl,de,es,fr}/trainer.json` | Add ~40 new keys |
| `src/i18n/locales/{en,nl,de,es,fr}/common.json` | Add ~10 new keys |

Estimated: ~100 new translation keys across 5 locale files each, touching ~15 component files.

