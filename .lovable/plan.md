

# Role Consistency Analysis: Academy / Club / Trainer / Player

## Current State Analysis

After analyzing all four roles, I've identified significant inconsistencies that add unnecessary complexity. Here's a comprehensive comparison:

---

## 1. Layout Architecture Differences

| Aspect | Trainer | Academy | Club | Player |
|--------|---------|---------|------|--------|
| **Navigation Type** | Collapsible Sidebar | Collapsible Sidebar | Horizontal Header Nav | Horizontal Header Nav |
| **Navigation Component** | `TrainerSidebar.tsx` | `AcademySidebar.tsx` | `ClubNavigation.tsx` | `PlayerNavigation.tsx` |
| **Layout Container** | `SidebarProvider` | `SidebarProvider` | Direct container | Direct container |
| **Gradient Background** | Orange gradient | Plain background | Plain background | Blue gradient |

**Recommendation**: Club and Player should switch to sidebar navigation like Trainer/Academy for consistency.

---

## 2. Subscription System Differences

| Aspect | Trainer | Club | Academy | Player |
|--------|---------|------|---------|--------|
| **Subscription Lib** | `subscription.ts` (inline types) | `clubSubscription.ts` | `academySubscription.ts` | N/A |
| **Type Interface** | `SubscriptionInfo` | `ClubSubscriptionInfo` | `AcademySubscriptionInfo` | N/A |
| **Trial Duration** | 7 days | 14 days | 14 days | N/A |
| **Tier Names** | trial/professional/academy | starter/club | starter/academy | N/A |
| **Pricing Model** | Multiple tiers (Starter €10, Pro €39, Academy €99) | Single plan (€199/mo) | Single plan (€199/mo) | N/A |
| **Subscription Page** | Full tier comparison UI | Simple status card | Simple status card | N/A |
| **Context Integration** | Via `useAuth()` | Via `useClubContext()` | Via `useAcademyContext()` | N/A |

**Issues Found**:
- `getTrialDaysRemaining()` is duplicated in all 3 subscription files - should be a shared utility
- Subscription interfaces are slightly different but could be unified
- Trainer subscription uses inconsistent tier naming (`trial` vs `starter`)

---

## 3. Dashboard Layout Differences

| Component | Trainer | Club | Academy | Player |
|-----------|---------|------|---------|--------|
| **Stats Cards** | 5 cards + calendar grid | 3 cards | 4 cards | 4 cards |
| **Trial Banners** | None (soft enforcement) | None | Yes (via context) | N/A |
| **Calendar Embed** | Full calendar on dashboard | No | No | No |
| **Quick Actions** | Complex setup checklist | Simple action cards | Simple action cards | Action cards + trainer list |
| **Page Length** | ~1156 lines | ~156 lines | ~186 lines | ~623 lines |

**Issues Found**:
- Trainer dashboard is overly complex (1156 lines) compared to others
- Club dashboard is missing trial/subscription banners (recently added to Academy)
- Inconsistent "quick actions" patterns

---

## 4. Settings Page Differences

| Feature | Trainer | Club | Academy | Player |
|---------|---------|------|---------|--------|
| **Settings File** | `TrainerSettings.tsx` | `ClubSettings.tsx` | `AcademySettings.tsx` | No dedicated settings page |
| **Visibility Toggle** | Yes (with subscription logic) | No | No | N/A |
| **Mollie Connect** | Separate page | Yes (inline) | No | N/A |
| **Manager Invites** | N/A | Yes | Yes | N/A |
| **Delete Account** | Yes | No | No | No |

**Issues Found**:
- Player has no settings page (only via navigation dropdown)
- Visibility toggle pattern could be useful for Club/Academy
- Delete account option missing from Club/Academy

---

## 5. Subscription Overlay/Paywall Consistency

| Aspect | Trainer | Club | Academy |
|--------|---------|------|---------|
| **Overlay Component** | Uses shared `SubscriptionOverlay` | Uses shared `SubscriptionOverlay` | Uses shared `SubscriptionOverlay` |
| **Features List** | 4 items | 4 items | 4 items |
| **Trial Banner in Dashboard** | No | No | Yes (recently added) |

**Good**: The shared `SubscriptionOverlay` component is now used consistently. But trial banners should be added to Trainer and Club dashboards.

---

## 6. Navigation Structure Differences

| Section | Trainer | Club | Academy |
|---------|---------|------|---------|
| **Dashboard** | Direct link | Direct link | Direct link |
| **Profile** | "My Profile" → /profile/edit | Dropdown under "Club" | Direct "Profile" link |
| **People/Team** | "Players" group (My Players, Intake) | "People" dropdown (Trainers, Players) | "Team" group (Trainers) |
| **Schedule** | "Schedule" group (Calendar, Open Slots) | "Schedule" dropdown (Calendar, Lessons) | "Schedule" group (Calendar, Registrations) |
| **Business** | "Business" group (Settings, Subscription, Earnings) | "Club" dropdown (Profile, Subscription, Settings) | "Business" group (Settings, Subscription, Earnings) |

**Issues Found**:
- Profile navigation inconsistent: Trainer uses /profile/edit, Academy uses /academy/profile, Club uses /club/profile
- Grouping labels differ: "Business" vs "Club" vs "Settings"
- Sidebar nav uses collapsible groups, horizontal nav uses dropdowns

---

## Recommended Unification Plan

### Phase 1: Unified Subscription Infrastructure

1. **Create shared subscription types**:
   - Extract common `SubscriptionInfo` interface to `src/lib/sharedSubscription.ts`
   - Unify tier naming: `starter` | `active` (instead of trial/professional/academy/club)
   - Share `getTrialDaysRemaining()` helper across all roles

2. **Standardize trial configuration**:
   - Consider aligning trial duration (7 days vs 14 days)
   - Use consistent trial banner pattern across all dashboards

### Phase 2: Unified Layout System

1. **Create shared layout components**:
   - Abstract sidebar pattern into reusable `DashboardSidebar` component
   - Convert Club and Player to use sidebar navigation

2. **Standardize visual theming**:
   - Apply consistent gradient backgrounds (or no gradients for all)
   - Unify header/footer patterns

### Phase 3: Feature Parity

1. **Settings pages**:
   - Add visibility toggle to Club/Academy settings
   - Add delete account option to Club/Academy settings
   - Create PlayerSettings.tsx page

2. **Dashboard enhancements**:
   - Add trial banners to Trainer and Club dashboards (like Academy)
   - Consider calendar view for Club dashboard

### Phase 4: Navigation Consistency

1. **Standardize section naming**:
   - Use "Business" across all roles (not "Settings" or role name)
   - Use consistent icon sets

2. **Profile location**:
   - Decide: standalone /profile/edit vs nested /[role]/profile

---

## Summary Table: What Needs Unification

| Item | Current State | Unified Approach |
|------|---------------|------------------|
| Navigation style | Mixed (sidebar/horizontal) | Sidebar for all |
| Subscription interface | 3 separate types | Single shared type |
| `getTrialDaysRemaining` | Duplicated 3x | Single shared function |
| Trial duration | 7 days / 14 days | Align to 14 days |
| Trial banners | Only Academy | All paid roles |
| Settings pages | Inconsistent features | Feature parity |
| Profile route | Mixed patterns | Standardize to /profile/edit |
| Background gradients | Role-specific colors | Unified or none |
| Delete account | Only Trainer | All roles |

---

## Quick Wins (Low Effort, High Impact)

1. **Extract shared `getTrialDaysRemaining` function** - currently duplicated in 3 files
2. **Add trial banners to Club and Trainer dashboards** - copy from Academy pattern
3. **Add delete account to Club and Academy settings** - component already exists
4. **Standardize navigation group labels** - "Business" for all

## Medium Effort

1. **Create unified subscription type interface**
2. **Align trial durations** (requires business decision)
3. **Create PlayerSettings.tsx page**

## High Effort (Consider for Future)

1. **Convert Club/Player to sidebar navigation**
2. **Unify background gradient theming**
3. **Refactor TrainerDashboard.tsx** (currently 1156 lines - needs splitting)

