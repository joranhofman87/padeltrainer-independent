

## Make Cycle Selection More Prominent on Intake Requests Page

### Problem
The cycle selector dropdown blends into the toolbar. Users don't realize they need to select a specific cycle before they can take actions like "Generate Proposals." The disabled state of the Generate button isn't enough of a hint.

### Solution
When no specific cycle is selected (`selectedCycleId === 'all'`), show a subtle **alert/banner** below the controls prompting the user to select a cycle. Also visually highlight the cycle selector itself (e.g. a ring/pulse) when it's still on "all."

### Changes

**Files: `src/pages/academy/AcademyIntakeRequests.tsx` and `src/pages/TrainerIntakeRequests.tsx`**

1. Import `Alert, AlertDescription` from `@/components/ui/alert` and `Info` icon from lucide
2. Add a conditional banner when `selectedCycleId === 'all'` and there are cycles available:
   ```
   <Alert variant="default" className="bg-muted/50 border-dashed">
     <Info />
     <AlertDescription>Select a specific registration above to generate proposals or take actions.</AlertDescription>
   </Alert>
   ```
   Placed right after the controls row, before the status filter tabs.

3. Style the `SelectTrigger` with a visual cue when on "all": add `border-primary ring-1 ring-primary/30` classes when `selectedCycleId === 'all'` and cycles exist, drawing attention to it.

**Localization: `src/i18n/locales/[en/nl/de/fr/es]/cycles.json`**
- Add key `intakeRequests.selectCycleHint`: "Select a specific registration above to generate proposals or take actions."

~15 lines changed per page file, plus translation keys. No new dependencies.

