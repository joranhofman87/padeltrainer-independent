

# Replace Full-Screen Overlay with Redirect to Subscription Page

## Current Behavior
The `SubscriptionOverlay` is a `fixed inset-0 z-50` modal that covers the entire screen, blocking all interaction — sidebar, logout, everything. Users feel trapped.

## New Behavior
When the trial/subscription expires, instead of rendering a blocking overlay, **redirect the user to the subscription page** and **lock all other navigation**. The sidebar remains visible (they can log out, see where they are), but clicking any non-subscription link redirects them back to the subscription page.

## Changes

### 1. Remove `SubscriptionOverlay` usage from all 3 layouts
- `TrainerLayout.tsx` — remove the overlay render block (lines 118-131)
- `AcademyLayout.tsx` — remove the overlay render block
- `ClubLayout.tsx` — remove the overlay render block

### 2. Add auto-redirect logic in each layout
When `isSubscriptionExpired && !isOnSubscriptionPage`, call `navigate(subscriptionPath)` in a `useEffect`. This pushes them to the subscription/plans page automatically.

### 3. Lock navigation in the sidebar when expired
Pass `isSubscriptionExpired` to each sidebar component (`TrainerSidebar`, `ClubSidebar`, `AcademySidebar`). When true, all nav links except "Subscription" and "Log out" become disabled (greyed out, `pointer-events-none`, no navigation). This lets users see the app structure but not access anything.

### 4. Add a banner on the subscription page
Instead of the overlay, show an inline alert/banner at the top of the subscription page saying "Your trial has expired — choose a plan to continue." This is less aggressive and keeps users oriented.

### 5. Optionally delete `SubscriptionOverlay.tsx`
If no longer used anywhere, remove the component file.

### Files to modify
| File | Change |
|------|--------|
| `src/components/trainer/TrainerLayout.tsx` | Remove overlay, add redirect useEffect |
| `src/components/academy/AcademyLayout.tsx` | Same |
| `src/components/club/ClubLayout.tsx` | Same |
| `src/components/trainer/TrainerSidebar.tsx` | Accept `isExpired` prop, disable non-subscription links |
| `src/components/academy/AcademySidebar.tsx` | Same |
| `src/components/club/ClubSidebar.tsx` | Same |
| `src/components/shared/SubscriptionOverlay.tsx` | Delete or keep as unused |

