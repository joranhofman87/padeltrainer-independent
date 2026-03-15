

# Clean Up Day Tabs & Add Collapsible Trainers

## Changes to `src/components/cycles/ProposalScheduleGrid.tsx`

### 1. Day tabs: show full day names, remove trainer initials
- Change `{day.slice(0, 3)}` to `{day}` for full weekday names
- Remove the trainer initials/count `<span>` entirely (lines 128-132)
- Keep the player count badge

### 2. Collapsible trainer sections
- Import `Collapsible, CollapsibleTrigger, CollapsibleContent` from `@/components/ui/collapsible` and `ChevronDown` from lucide
- Add state: `collapsedTrainers` as a `Set<string>` (default empty = all expanded)
- Wrap each trainer section in a `Collapsible` component
- Make the trainer header row a `CollapsibleTrigger` with a chevron icon that rotates when collapsed
- Wrap the slot cards grid in `CollapsibleContent`

