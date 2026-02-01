

# Academy Dashboard Redesign: Sidebar Navigation + Trainer & Location Management

## Overview

This plan implements four key features for academy owners:
1. **Sidebar-based navigation** matching the TrainerSidebar pattern
2. **Create trainers** with full account creation capability
3. **Edit trainer profiles** after creation
4. **Request new locations** with admin approval workflow

---

## 1. Academy Sidebar Navigation

### Current State
The academy layout uses a top navigation bar with dropdown menus (`AcademyNavigation.tsx`), which differs from the sidebar-based navigation used in the trainer dashboard.

### Implementation

#### New Component: `AcademySidebar.tsx`
Create a new sidebar component following the `TrainerSidebar.tsx` pattern:

| Section | Items |
|---------|-------|
| **Header** | Academy logo/name, verification badge |
| **Main Navigation** | Dashboard, Profile |
| **Team** (collapsible) | Trainers, Players (future) |
| **Schedule** (collapsible) | Calendar, Cycles |
| **Business** (collapsible) | Earnings, Subscription, Settings |
| **Locations** | Locations |
| **Footer** | ProfileSwitcher, Logout, Theme toggle |

#### File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/components/academy/AcademySidebar.tsx` | Create | New sidebar component |
| `src/components/academy/AcademyLayout.tsx` | Modify | Replace header/navigation with SidebarProvider + AcademySidebar |
| `src/i18n/locales/en/academy.json` | Modify | Add sidebar navigation keys |
| `src/i18n/locales/nl/academy.json` | Modify | Add Dutch translations |

#### Key Features
- Collapsible sidebar with icon-only mode
- Active route highlighting using NavLink
- ProfileSwitcher in footer for role switching
- Mobile-friendly with overlay mode
- Matches TrainerSidebar visual style

---

## 2. Create Academy Trainers

### Current State
Academies can only **invite** existing trainers via email invitation. There's no way to create new trainer accounts directly.

### Implementation

#### New Component: `CreateAcademyTrainerDialog.tsx`
Similar to `CreateClubTrainerDialog.tsx`, this dialog allows academy managers to:
- Enter trainer details (name, email, phone)
- Create a new user account OR link an existing user
- Automatically link the trainer to the academy
- Show temporary password for new accounts

#### New Edge Function: `create-academy-trainer`
Based on `create-club-trainer/index.ts`:
- Verify caller is an academy manager
- Check if user exists or create new account
- Create trainer profile if needed
- Add to `academy_trainers` table
- Assign trainer role

#### File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/components/academy/CreateAcademyTrainerDialog.tsx` | Create | Dialog for creating trainers |
| `supabase/functions/create-academy-trainer/index.ts` | Create | Edge function for trainer creation |
| `src/pages/academy/AcademyTrainers.tsx` | Modify | Add CreateAcademyTrainerDialog button |
| `src/lib/academy.ts` | Modify | Add helper function |

#### Database Function
Create `is_any_academy_manager` RPC function to check if user manages any academy.

---

## 3. Edit Academy Trainer Profiles

### Current State
The `AcademyTrainers.tsx` page shows trainer cards but only has a "Profile" link to view the public profile. There's no edit functionality.

### Implementation

#### New Component: `EditAcademyTrainerDialog.tsx`
Reuse patterns from `EditClubTrainerDialog.tsx`:
- Fetch trainer profile and user profile data
- Edit: name, phone, bio, avatar
- Edit: hourly rate, experience, certifications, specializations
- Edit: rating system and rating value
- Save updates to both `profiles` and `trainer_profiles` tables

#### File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/components/academy/EditAcademyTrainerDialog.tsx` | Create | Dialog for editing trainer profiles |
| `src/pages/academy/AcademyTrainers.tsx` | Modify | Add edit button that opens dialog |

---

## 4. Request New Locations (Admin Approval Required)

### Current State
The `AddAcademyLocationDialog.tsx` only allows selecting from existing locations via `LocationPicker`. There's no way to request a new location if it doesn't exist on the platform.

### Implementation

#### New Database Table: `location_requests`
Stores pending location submissions for admin review:

```sql
CREATE TABLE public.location_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'NL',
  street_address TEXT,
  postal_code TEXT,
  website_url TEXT,
  phone TEXT,
  email TEXT,
  requested_by UUID REFERENCES auth.users(id) NOT NULL,
  request_context TEXT DEFAULT 'academy', -- 'academy', 'trainer', etc.
  context_id UUID, -- academy_profile_id if from academy
  status TEXT NOT NULL DEFAULT 'pending', -- pending, approved, rejected
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_location_id UUID REFERENCES locations(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### New Component: `RequestLocationDialog.tsx`
A form dialog for submitting new location requests:
- Location name (required)
- City (required)
- Country (dropdown, default: Netherlands)
- Street address
- Postal code
- Website URL
- Phone & email
- Submits to `location_requests` table

#### Admin Panel: Location Requests Tab
Add a new tab in `AdminLocations.tsx` to:
- View pending location requests
- Approve (creates location in `locations` table)
- Reject with reason

#### File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/components/academy/RequestLocationDialog.tsx` | Create | Dialog for requesting new locations |
| `src/pages/academy/AcademyLocations.tsx` | Modify | Add "Request New Location" button |
| `src/pages/admin/AdminLocations.tsx` | Modify | Add Location Requests tab |
| `src/lib/locations.ts` | Modify | Add request/approve functions |
| `src/i18n/locales/en/academy.json` | Modify | Add translation keys |
| `src/i18n/locales/nl/academy.json` | Modify | Add Dutch translations |
| Database migration | Create | Add `location_requests` table with RLS |

---

## Visual Structure

### Academy Sidebar (Desktop - Expanded)

```text
+----------------------------------+
| [Logo] RL Padel Performance      |
| ✓ Verified                       |
+----------------------------------+
| 📊 Dashboard                     |
| 👤 Profile                       |
+----------------------------------+
| 👥 Team                    ▼     |
|   └─ Trainers                    |
+----------------------------------+
| 📅 Schedule                ▼     |
|   ├─ Calendar                    |
|   └─ Cycles                      |
+----------------------------------+
| 📍 Locations                     |
+----------------------------------+
| 💼 Business                ▼     |
|   ├─ Earnings                    |
|   ├─ Subscription                |
|   └─ Settings                    |
+----------------------------------+
| [ProfileSwitcher]                |
| [🌓] [Logout 🚪]                 |
+----------------------------------+
```

### Create Trainer Flow

```text
+----------------------------------+
| Create Trainer Account           |
+----------------------------------+
| Full Name:  [John Trainer      ] |
| Email:      [john@example.com  ] |
| Phone:      [+31 6 12345678    ] |
+----------------------------------+
| [Cancel]        [Create Trainer] |
+----------------------------------+
         ↓ (on success, new user)
+----------------------------------+
| ✅ Trainer Created!              |
+----------------------------------+
| Email: john@example.com          |
| Password: Ab3$kL9m...  [📋]      |
|                                  |
| Share these credentials securely |
+----------------------------------+
|                       [Done]     |
+----------------------------------+
```

### Request Location Flow

```text
Academy Locations Page:
+----------------------------------+
| [Add Location] [Request New]     |
+----------------------------------+

Request New Location Dialog:
+----------------------------------+
| Request New Location             |
| Location not in our database?    |
| Submit it for admin review.      |
+----------------------------------+
| Name:*    [Padel Club Example  ] |
| City:*    [Amsterdam           ] |
| Country:  [Netherlands ▼       ] |
| Address:  [Sportlaan 123       ] |
| Postal:   [1234 AB             ] |
| Website:  [www.example.com     ] |
| Phone:    [020-1234567         ] |
+----------------------------------+
| [Cancel]     [Submit Request]    |
+----------------------------------+
```

---

## Technical Details

### AcademySidebar Structure

```tsx
// Key imports
import { SidebarProvider, Sidebar, SidebarContent, ... } from '@/components/ui/sidebar';
import { ProfileSwitcher } from '@/components/ProfileSwitcher';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';

// Navigation groups
const groups = [
  { key: 'team', icon: Users, items: ['trainers'] },
  { key: 'schedule', icon: Calendar, items: ['calendar', 'cycles'] },
  { key: 'business', icon: CreditCard, items: ['earnings', 'subscription', 'settings'] },
];
```

### Create Academy Trainer Edge Function

```tsx
// Permission check
const { data: isManager } = await supabaseUser.rpc("is_any_academy_manager", {
  _user_id: user.id,
});

// After creating trainer, link to academy
await supabaseAdmin.from('academy_trainers').insert({
  academy_profile_id: academyProfileId,
  trainer_profile_id: trainerId,
  status: 'active',
  invited_by: user.id,
  joined_at: new Date().toISOString(),
});
```

### RLS Policies for `location_requests`

```sql
-- Users can create requests
CREATE POLICY "Users can create location requests"
ON location_requests FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = requested_by);

-- Users can view their own requests
CREATE POLICY "Users can view own requests"
ON location_requests FOR SELECT
TO authenticated
USING (auth.uid() = requested_by);

-- Admins can view and manage all requests
CREATE POLICY "Admins can manage location requests"
ON location_requests FOR ALL
TO authenticated
USING (public.is_admin(auth.uid()));
```

---

## Implementation Order

1. **Phase 1: Sidebar Navigation**
   - Create `AcademySidebar.tsx`
   - Update `AcademyLayout.tsx` to use SidebarProvider
   - Add translations

2. **Phase 2: Create Trainers**
   - Create `is_any_academy_manager` database function
   - Create `create-academy-trainer` edge function
   - Create `CreateAcademyTrainerDialog.tsx`
   - Update `AcademyTrainers.tsx`

3. **Phase 3: Edit Trainers**
   - Create `EditAcademyTrainerDialog.tsx`
   - Update `AcademyTrainers.tsx` with edit button

4. **Phase 4: Request Locations**
   - Create `location_requests` table with RLS
   - Create `RequestLocationDialog.tsx`
   - Update `AcademyLocations.tsx`
   - Add admin review UI in `AdminLocations.tsx`

---

## Translation Keys to Add

### English (`academy.json`)
```json
{
  "sidebar": {
    "collapseMenu": "Collapse menu"
  },
  "trainers": {
    "createTrainer": "Create Trainer",
    "createTrainerDescription": "Create a new trainer account or link an existing user to your academy.",
    "trainerCreated": "Trainer Created",
    "newUserCredentials": "A new account has been created. Share these credentials securely.",
    "existingUserLinked": "The existing user has been linked to your academy."
  },
  "locations": {
    "requestNew": "Request New Location",
    "requestNewDescription": "Location not in our database? Submit it for admin review.",
    "requestSubmitted": "Request Submitted",
    "requestSubmittedDescription": "An admin will review your location request.",
    "pendingRequests": "Pending Requests"
  }
}
```

