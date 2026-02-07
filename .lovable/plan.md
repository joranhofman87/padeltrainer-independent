

# Move Setup Checklist to Dedicated Page

## Current State
`TrainerDashboard.tsx` is 1,009 lines. It contains the setup checklist logic inline: the `SetupStatus` interface, `setupStatus` state, `setupLoading` state, `isSetupExpanded` + localStorage persistence, the `fetchSetupStatus` function (~70 lines of DB queries), and the conditional rendering block. All of this runs on every dashboard load even after setup is complete.

## Changes

### 1. New Page: `src/pages/TrainerGetStarted.tsx`
A standalone page at `/trainer/get-started` that:
- Contains the `fetchSetupStatus` logic (currently in TrainerDashboard lines 469-538)
- Renders the `TrainerSetupChecklist` component full-width (always expanded, no collapsible wrapper needed)
- Shows a congratulations/completion state when all steps are done, with a "Go to Dashboard" button
- Lightweight page -- just the checklist, no calendar or stats

### 2. Update `TrainerSidebar.tsx`
Add a "Get Started" nav item (with a rocket or flag icon) between "Dashboard" and "Players":
- Only visible when setup is NOT fully complete (query the same setup status)
- Hidden automatically once all 5 steps are done
- Uses an orange/highlight badge or dot to draw attention

To determine visibility without re-fetching on every render, the sidebar will check setup completion via a lightweight query (count-based checks) cached in component state.

### 3. Simplify `TrainerDashboard.tsx`
Remove from the dashboard:
- `SetupStatus` interface (move to shared types or the new page)
- `setupStatus`, `setupLoading`, `isSetupExpanded` state variables
- `fetchSetupStatus` function (~70 lines)
- localStorage get/set for `trainer_setup_expanded`
- The `TrainerSetupChecklist` import and rendering block
- The `useEffect` call for `fetchSetupStatus`

This removes ~90 lines and one full data-fetching flow from the dashboard.

### 4. Add Route
Register `/trainer/get-started` in the router config, wrapped in `TrainerLayout`.

### 5. Translation Keys
Add `nav.getStarted` to `trainer.json` (en: "Get Started", nl: "Aan de slag").

## Technical Details

| File | Change |
|------|--------|
| `src/pages/TrainerGetStarted.tsx` | New page with setup status fetching + checklist rendering |
| `src/components/trainer/TrainerSidebar.tsx` | Add conditional "Get Started" nav item |
| `src/pages/TrainerDashboard.tsx` | Remove all setup-related state, logic, and rendering (~90 lines) |
| `src/App.tsx` | Add `/trainer/get-started` route |
| `src/i18n/locales/en/trainer.json` | Add `nav.getStarted` |
| `src/i18n/locales/nl/trainer.json` | Add `nav.getStarted` |

