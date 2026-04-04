

# Restrict Trainer Dashboard for Academy Members

## Problem
Trainers who belong to an academy currently have a full independent dashboard with settings, billing, registrations, open slots management, etc. This creates confusion and duplication — the academy should own all configuration. Academy trainers should only see their own schedule and players.

## Architecture Decision

**Keep `/app/trainer` as the route** but dynamically strip the sidebar and redirect restricted pages based on whether the trainer belongs to an academy. No new routes needed — we restrict what's shown.

The ProfileSwitcher at the bottom of the sidebar already handles switching to the academy dashboard for managers. Non-manager trainers will only see their limited trainer view.

## Changes

### 1. `src/components/trainer/TrainerSidebar.tsx` — Conditional nav for academy trainers

When `hasAcademy` is true, the sidebar shows ONLY:
- **My Profile** — personal details (name, bio, avatar, coaching style)
- **My Schedule** — single link to `/trainer/calendar` (their slots only)
- **My Players** — their booked players

**Hidden** when `hasAcademy`:
- Dashboard (stats are academy-level)
- Open Slots / Schedule Overview (managed by academy)
- Registrations / Intake / Waiting List (managed by academy)
- Business group (Settings / Subscription / Earnings)
- Get Started checklist

The ProfileSwitcher remains in the footer — academy managers can switch to `/app/academy` for full control.

### 2. `src/components/trainer/TrainerLayout.tsx` — Route guard for academy trainers

Add redirect logic: if `hasAcademy` is true and the current path is a restricted route (settings, subscription, earnings, cycles, intake-requests, waiting-list, schedule-overview, open-slots, get-started), redirect to `/app/trainer/calendar`.

This prevents direct URL access to pages the trainer shouldn't see.

### 3. `src/pages/trainer/TrainerDashboard.tsx` — Redirect for academy trainers

When `hasAcademy`, redirect to `/app/trainer/calendar` instead of showing the stats dashboard. Academy-level stats live in the academy Reports tab.

### 4. Trainer Settings page — scope down for academy trainers

If somehow accessed (belt-and-suspenders), show only personal profile fields (bio, avatar, coaching style). Hide business settings (hourly rate, VAT, invoice settings, locations) — these are academy-managed.

## What stays the same
- Independent trainers (no academy) see everything as before — no changes
- Academy managers can still switch to academy dashboard via ProfileSwitcher
- The trainer calendar at `/app/trainer/calendar` already shows only slots belonging to that trainer
- The trainer players page already shows only their booked players

## Visual: Sidebar comparison

```text
INDEPENDENT TRAINER          ACADEMY TRAINER
─────────────────           ───────────────
My Profile                  My Profile
Dashboard                   My Schedule
Players                     My Players
▸ Schedule                  
  Calendar                  ── footer ──
  Open Slots                ProfileSwitcher
  Overview                  (switch to Academy)
▸ Registrations             Theme / Logout
  Registrations             
  Intake Requests           
  Waiting List              
▸ Business                  
  Settings                  
  Subscription              
  Earnings                  
Get Started                 
                            
── footer ──                
ProfileSwitcher             
View Profile                
Theme / Referral / Logout   
```

## File summary

| File | Change |
|------|--------|
| `src/components/trainer/TrainerSidebar.tsx` | Hide nav sections when `hasAcademy`, show only Profile/Schedule/Players |
| `src/components/trainer/TrainerLayout.tsx` | Add route guard redirecting restricted paths for academy trainers |

