

# Fix: Overview page should fetch its own data

## Problem
The overview page relies entirely on route state (`location.state.slots`) passed during navigation. If `scheduleSlots` hasn't finished loading yet (e.g. user quickly clicks "Continue"), the overview receives an empty array and shows nothing.

## Solution
Make `ProposalOverviewPage` self-sufficient: pass the `cycleId` via route state (or URL param), and have the overview page call `getAvailableSlotsForCycle()` itself if `slots` from state is empty.

## Changes

### 1. `ProposalOverviewPage.tsx`
- Accept `cycleId` from route state alongside `slots`
- Add a `useEffect` that calls `getAvailableSlotsForCycle(cycleId)` when the component mounts if `slots` is empty (or always, to ensure fresh data)
- Add a loading spinner while fetching

### 2. `AcademyIntakeRequests.tsx` and `TrainerIntakeRequests.tsx`
- Pass `cycleId: selectedCycleId` in the route state alongside `slots` and `backPath`
- This way the overview can always fetch fresh data independently

This makes the overview page resilient -- it works whether data was pre-loaded or not, and always shows up-to-date information.

