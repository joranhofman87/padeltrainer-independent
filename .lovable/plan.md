

# Redesign: Registration Detail Page (Academy)

## Overview
Create a new tabbed detail page at `/app/academy/cycles/:cycleId` that consolidates everything related to a single registration into one view. The sidebar simplifies to a single "Registrations" link. Clicking a row in the registrations list navigates to this detail page instead of the edit form.

## What stays the same
- Player-facing pages: no changes
- Database: no changes
- Trainer/Club flows: untouched in this phase (can be applied later)
- `CycleFormPage` still works for `/cycles/new` and as a standalone fallback
- `CycleForm.tsx` component already exists and is reusable — no extraction needed

## New file: `src/pages/academy/AcademyCycleDetail.tsx`

Route: `/app/academy/cycles/:cycleId`

**Structure:**
- Fetch cycle by ID, intake requests for that cycle, player links, schedule slots
- Header: cycle name, status badge, share link button, period dates, edit/duplicate dropdown
- `Tabs` with URL search param persistence (`?tab=registrations`):
  1. **Registrations** (default) — `IntakeRequestsTable` + `IntakeRequestDetailSheet`, scoped to this cycle. Includes status filter tabs, add manual button, CSV export, list/schedule view toggle — essentially the content from `AcademyIntakeRequests` but without the cycle selector
  2. **Proposals** — `ProposalWorkflowSteps` (without step 1 cycle selector) + `GenerateProposalsWizard` rendered inline (not in a Dialog) + `ProposalScheduleGrid`. The wizard state persists because it's a real page section, not a modal
  3. **Settings** — Embeds `CycleForm` component directly with the loaded cycle, same as the edit page but inline
  4. **Waiting List** — `WaitingListTable` filtered for this cycle

## Changes to existing files

| File | Change |
|------|--------|
| `src/pages/academy/AcademyCycleDetail.tsx` | **New** — tabbed detail page |
| `src/pages/academy/AcademyCycles.tsx` | Row click → `/app/academy/cycles/:cycleId` instead of `/edit` |
| `src/components/DomainRouter.tsx` | Add route `cycles/:cycleId` → `AcademyCycleDetail` (before `cycles/:cycleId/edit`) |
| `src/components/academy/AcademySidebar.tsx` | Replace Registration submenu (3 items) with single "Registrations" link to `/app/academy/cycles` |
| `src/components/cycles/GenerateProposalsWizard.tsx` | Add `inline?: boolean` prop — when true, render content directly without `Dialog` wrapper |
| `src/components/cycles/ProposalWorkflowSteps.tsx` | Add `hideCycleSelector?: boolean` prop — when true, skip rendering the cycle dropdown (step 1 becomes implicit) |

## Technical details

- Tab state stored in URL: `useSearchParams` to read/write `?tab=registrations|proposals|settings|waitinglist`
- The detail page fetches all data once on mount and exposes `refreshData` for silent updates
- `GenerateProposalsWizard` inline mode: when `inline={true}`, renders a `Card` instead of `Dialog`/`DialogContent` — same internal step logic, just different wrapper
- `CyclesTable` `onEdit` callback changes from navigating to `/edit` to navigating to the detail page
- Old `/cycles/:cycleId/edit` route stays as fallback (or redirects to `?tab=settings`)

