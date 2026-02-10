
## Add "Create Slots First" Reminder Dialog Before Generating Proposals

### Overview
When a trainer or academy clicks "Generate Proposals", show an informational AlertDialog reminding them that slots/cycles must exist in the calendar first for matching to work. The dialog has two CTAs: "Go to Calendar" (navigates to the calendar page) and "Continue" (proceeds to open the existing ScoringWeightsDialog).

### Changes

**New Component: `src/components/cycles/GenerateProposalsGuard.tsx`**
- An AlertDialog with an info/warning message explaining that slots must be created in the calendar first
- Props: `open`, `onOpenChange`, `onContinue`, `calendarPath`
- "Go to Calendar" button (outline) navigates to the provided calendar path
- "Continue" button (primary) closes this dialog and triggers `onContinue` (which opens the ScoringWeightsDialog)
- Uses existing AlertDialog UI components

**`src/pages/TrainerIntakeRequests.tsx`**
- Add state `showGuardDialog` (boolean)
- Change the "Generate Proposals" button `onClick` from `setShowWeightsDialog(true)` to `setShowGuardDialog(true)`
- Render `GenerateProposalsGuard` with `calendarPath="/app/trainer/calendar"` and `onContinue` that closes guard and opens weights dialog

**`src/pages/academy/AcademyIntakeRequests.tsx`**
- Same pattern with `calendarPath="/app/academy/calendar"`

**Translation keys** (EN and NL, in `cycles` namespace):
- `proposals.guard.title` -- e.g. "Important"
- `proposals.guard.description` -- e.g. "For the system to generate proposals, you need to create slots or training cycles in your calendar first. Once slots are created, we can match players based on their availability and preferences."
- `proposals.guard.goToCalendar` -- "Go to Calendar"
- `proposals.guard.continue` -- "Continue"

### Technical Details
- The guard dialog is a simple AlertDialog (not a full Dialog) since it's a short confirmation message
- The "Go to Calendar" button uses `useNavigate()` to route to the appropriate calendar page
- The "Continue" button chains into the existing `setShowWeightsDialog(true)` flow, so no changes to the scoring/generation logic are needed
- Both Trainer and Academy intake request pages get the same treatment with only the calendar path differing
