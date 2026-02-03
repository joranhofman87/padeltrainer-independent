
# Remove Legacy Routes and Simplify Navigation

Since the app hasn't gone live yet, there's no need for backwards compatibility redirects. This cleanup will remove all legacy route handling and update navigation to use proper namespaced paths.

---

## Changes Overview

### 1. Remove Legacy Route Redirects from DomainRouter.tsx

**Remove these redirect blocks entirely:**

**In `AppRoutes()` function (lines 205-217):**
```tsx
{/* Legacy route redirects */}
<Route path="/profile/edit" element={<Navigate to="/player/profile" replace />} />
<Route path="/lessons" element={<Navigate to="/trainer" replace />} />
<Route path="/availability" element={<Navigate to="/trainer/calendar" replace />} />
<Route path="/schedule" element={<Navigate to="/trainer/calendar" replace />} />
<Route path="/bookings" element={<Navigate to="/player/bookings" replace />} />
<Route path="/trainer-bookings" element={<Navigate to="/trainer" replace />} />
<Route path="/earnings" element={<Navigate to="/trainer" replace />} />
<Route path="/subscription" element={<Navigate to="/trainer" replace />} />
<Route path="/analytics" element={<Navigate to="/trainer" replace />} />
<Route path="/settings/notifications" element={<Navigate to="/player/settings/notifications" replace />} />
<Route path="/settings/calendar" element={<Navigate to="/player/settings/calendar" replace />} />
```

**In `CombinedRoutes()` function (lines 313-325):**
Same block to be removed.

**In `MarketingRoutes()` function (lines 121-130):**
Remove these app-path redirects:
```tsx
<Route path="/lessons" element={<RedirectToAppDomain path="/lessons" />} />
<Route path="/bookings" element={<RedirectToAppDomain path="/bookings" />} />
<Route path="/earnings" element={<RedirectToAppDomain path="/earnings" />} />
<Route path="/subscription" element={<RedirectToAppDomain path="/subscription" />} />
<Route path="/analytics" element={<RedirectToAppDomain path="/analytics" />} />
<Route path="/availability" element={<RedirectToAppDomain path="/availability" />} />
<Route path="/schedule" element={<RedirectToAppDomain path="/schedule" />} />
<Route path="/trainer-bookings" element={<RedirectToAppDomain path="/trainer-bookings" />} />
```

Also remove the `ManageLessons` import since it's no longer used.

---

### 2. Update TrainerSidebar.tsx to Use Proper Paths

**Update navigation links:**

| Current Path | New Path |
|--------------|----------|
| `/profile/edit` | `/trainer/profile` |
| `/subscription` | `/trainer/subscription` |
| `/earnings` | `/trainer/earnings` |

**Update path checks for `businessOpen` state:**
```tsx
// Line 82-86: Change from
location.pathname.startsWith("/subscription") ||
location.pathname.startsWith("/earnings")

// To
location.pathname.startsWith("/trainer/subscription") ||
location.pathname.startsWith("/trainer/earnings")
```

---

### 3. Update PlayerDashboard.tsx to Use Proper Paths

| Current Path | New Path |
|--------------|----------|
| `/bookings` (line 398, 480) | `/player/bookings` |
| `/profile/edit` (line 499) | `/player/profile` |

---

### 4. Update TrainerSettings.tsx to Use Proper Path

| Current Path | New Path |
|--------------|----------|
| `/profile/edit` (line 122) | `/trainer/profile` |

---

### 5. Update TrainerDashboard.tsx Setup Steps

| Current Path | New Path |
|--------------|----------|
| `/profile/edit` (line 1066) | `/trainer/profile` |
| `/lessons` (line 1067) | `/trainer/calendar` |

---

### 6. Add Missing Trainer Routes to DomainRouter.tsx

Add these routes inside the `/trainer` layout:

```tsx
<Route path="profile" element={<EditProfile />} />
<Route path="subscription" element={<TrainerSubscription />} />
<Route path="earnings" element={<TrainerEarnings />} />
<Route path="analytics" element={<TrainerAnalytics />} />
<Route path="bookings" element={<TrainerBookings />} />
```

---

### 7. Delete Unused Pages

These pages are no longer accessible or needed:

| File | Reason |
|------|--------|
| `src/pages/ManageSchedule.tsx` | Replaced by TrainerCalendar |
| `src/pages/ManageAvailability.tsx` | Replaced by TrainerCalendar |
| `src/pages/ManageLessons.tsx` | Functionality merged into TrainerCalendar |

---

## Summary of Files to Modify

| File | Changes |
|------|---------|
| `src/components/DomainRouter.tsx` | Remove legacy redirects, add proper trainer routes, remove ManageLessons import |
| `src/components/trainer/TrainerSidebar.tsx` | Update paths from legacy to `/trainer/*` namespace |
| `src/pages/PlayerDashboard.tsx` | Update `/bookings` → `/player/bookings`, `/profile/edit` → `/player/profile` |
| `src/pages/TrainerSettings.tsx` | Update `/profile/edit` → `/trainer/profile` |
| `src/pages/TrainerDashboard.tsx` | Update setup step paths to proper routes |

## Files to Delete

| File | Reason |
|------|--------|
| `src/pages/ManageSchedule.tsx` | Unused - replaced by TrainerCalendar |
| `src/pages/ManageAvailability.tsx` | Unused - replaced by TrainerCalendar |
| `src/pages/ManageLessons.tsx` | Unused - no longer in routes |

---

## Route Structure After Cleanup

**Trainer Routes (`/trainer/*`):**
- `/trainer` → Dashboard
- `/trainer/profile` → Edit Profile
- `/trainer/settings` → Settings
- `/trainer/settings/bookings` → Booking Settings
- `/trainer/calendar` → Calendar
- `/trainer/players` → Players
- `/trainer/subscription` → Subscription
- `/trainer/earnings` → Earnings
- `/trainer/analytics` → Analytics
- `/trainer/bookings` → Bookings
- `/trainer/cyclus` → Cyclus
- `/trainer/cycles` → Cycles
- `/trainer/intake-requests` → Intake Requests
- `/trainer/open-slots` → Open Slots

**Player Routes (`/player/*`):**
- `/player` → Dashboard
- `/player/bookings` → Bookings
- `/player/following` → Following
- `/player/profile` → Edit Profile
- `/player/settings` → Settings
- `/player/settings/notifications` → Notification Settings
- `/player/settings/calendar` → Calendar Settings
