
# Plan: Refactor Registrations to Academy + Trainer Level

## Overview

Restructure the cycle/registration system so that:
1. **Remove** club-owned cycles (clubs cannot create cycles)
2. **Display** academy cycles and trainer cycles on club pages (aggregated from all trainers/academies at that location)
3. **Display** trainer cycles on the trainer public profile
4. **Display** academy cycles on the academy public profile

## Current Architecture

```text
cycles table:
+------------------+-------------------------------+
| owner_type       | owner_id points to            |
+------------------+-------------------------------+
| 'club'           | club_profiles.id              |  ← REMOVE
| 'trainer'        | trainer_profiles.id           |  ← KEEP
| 'academy'        | academy_profiles.id           |  ← KEEP
+------------------+-------------------------------+
```

## New Architecture

```text
Public Page Display Logic:

Club/Location Page
├── Fetch trainers at this location (trainer_locations.location_id)
│   └── Get open cycles where owner_type='trainer' AND owner_id IN trainer_ids
├── Fetch academies at this location (academy_locations.location_id)
│   └── Get open cycles where owner_type='academy' AND owner_id IN academy_ids
└── Display all aggregated open cycles

Trainer Profile Page
└── Get open cycles where owner_type='trainer' AND owner_id=trainer_profile_id
    └── Display trainer's own cycles

Academy Profile Page
└── Get open cycles where owner_type='academy' AND owner_id=academy_profile_id
    └── Display academy's own cycles
```

## Files to Modify/Create

| File | Action | Description |
|------|--------|-------------|
| `src/lib/cycles.ts` | Modify | Add `getLocationCycles()` function to fetch cycles by location |
| `src/components/club/ClubOpenCycles.tsx` | Modify | Rename to `LocationOpenCycles`, fetch trainer + academy cycles |
| `src/pages/LocationDetail.tsx` | Modify | Update to use new component |
| `src/pages/TrainerProfile.tsx` | Modify | Add `TrainerOpenCycles` section |
| `src/pages/AcademyPublicProfile.tsx` | Modify | Add `AcademyOpenCycles` section |
| `src/components/trainer/TrainerOpenCycles.tsx` | Create | New component for trainer profile cycles |
| `src/components/academy/AcademyOpenCycles.tsx` | Create | New component for academy profile cycles |
| `src/pages/club/ClubCycles.tsx` | Delete | Remove club cycle management |
| `src/pages/club/ClubIntakeRequests.tsx` | Delete | Remove club intake requests management |

## Detailed Implementation

### 1. New Library Function: `getLocationCycles()`

Add to `src/lib/cycles.ts`:

```typescript
// Fetch all open cycles for a location (from trainers + academies at that location)
export async function getLocationCycles(locationId: string): Promise<Cycle[]> {
  // Get trainers at this location
  const { data: trainerLocations } = await supabase
    .from('trainer_locations')
    .select('trainer_id')
    .eq('location_id', locationId);
  
  const trainerIds = trainerLocations?.map(t => t.trainer_id) || [];
  
  // Get academies at this location
  const { data: academyLocations } = await supabase
    .from('academy_locations')
    .select('academy_profile_id')
    .eq('location_id', locationId)
    .eq('is_active', true);
  
  const academyIds = academyLocations?.map(a => a.academy_profile_id) || [];
  
  // Fetch cycles from both
  const allCycles: Cycle[] = [];
  
  if (trainerIds.length > 0) {
    const { data: trainerCycles } = await supabase
      .from('cycles')
      .select('*')
      .eq('owner_type', 'trainer')
      .in('owner_id', trainerIds)
      .eq('status', 'open');
    if (trainerCycles) allCycles.push(...trainerCycles);
  }
  
  if (academyIds.length > 0) {
    const { data: academyCycles } = await supabase
      .from('cycles')
      .select('*')
      .eq('owner_type', 'academy')
      .in('owner_id', academyIds)
      .eq('status', 'open');
    if (academyCycles) allCycles.push(...academyCycles);
  }
  
  return allCycles.sort((a, b) => 
    new Date(a.start_date).getTime() - new Date(b.start_date).getTime()
  );
}
```

### 2. Refactor `ClubOpenCycles` → `LocationOpenCycles`

Update to fetch cycles from both trainers and academies at the location:

```typescript
// src/components/club/LocationOpenCycles.tsx
interface LocationOpenCyclesProps {
  locationId: string;        // The location's ID
  locationName: string;      // For display
}

export function LocationOpenCycles({ locationId, locationName }: LocationOpenCyclesProps) {
  // Use getLocationCycles(locationId) instead of getActiveCycles('club', clubProfileId)
  // This aggregates cycles from all trainers + academies at this location
}
```

### 3. Create `TrainerOpenCycles` Component

New component for trainer profile pages:

```typescript
// src/components/trainer/TrainerOpenCycles.tsx
interface TrainerOpenCyclesProps {
  trainerId: string;
  trainerName: string;
}

export function TrainerOpenCycles({ trainerId, trainerName }: TrainerOpenCyclesProps) {
  const [cycles, setCycles] = useState<Cycle[]>([]);
  
  useEffect(() => {
    getActiveCycles('trainer', trainerId).then(setCycles);
  }, [trainerId]);
  
  // Render cycle cards with apply functionality
}
```

### 4. Create `AcademyOpenCycles` Component

New component for academy profile pages:

```typescript
// src/components/academy/AcademyOpenCycles.tsx
interface AcademyOpenCyclesProps {
  academyId: string;
  academyName: string;
}

export function AcademyOpenCycles({ academyId, academyName }: AcademyOpenCyclesProps) {
  const [cycles, setCycles] = useState<Cycle[]>([]);
  
  useEffect(() => {
    getActiveCycles('academy', academyId).then(setCycles);
  }, [academyId]);
  
  // Render cycle cards with apply functionality
}
```

### 5. Update Public Profile Pages

**TrainerProfile.tsx:**
Add section after the lessons/availability section:
```tsx
{/* Open Registrations */}
<TrainerOpenCycles 
  trainerId={trainer.id} 
  trainerName={profile.full_name} 
/>
```

**AcademyPublicProfile.tsx:**
Add section after the trainers section:
```tsx
{/* Open Registrations */}
<AcademyOpenCycles 
  academyId={academy.id} 
  academyName={academy.name} 
/>
```

**LocationDetail.tsx:**
Update to pass location ID instead of club profile ID:
```tsx
{/* Open Registrations - from trainers and academies at this location */}
<LocationOpenCycles 
  locationId={location.id}
  locationName={location.name} 
/>
```

### 6. Remove Club Cycle Management

| File | Action |
|------|--------|
| `src/pages/club/ClubCycles.tsx` | Delete or redirect to info page |
| `src/pages/club/ClubIntakeRequests.tsx` | Delete or redirect to info page |
| Club navigation | Remove "Cycles" and "Intake Requests" menu items |

Alternatively, repurpose these pages to show intake requests from cycles associated with their location (read-only view of what trainers/academies are doing).

### 7. Navigation Updates

Update `src/components/club/ClubNavigation.tsx` to remove:
- Link to `/club/cycles`
- Link to `/club/intake-requests`

Or repurpose to show aggregated view (read-only).

## Visual Flow

```text
BEFORE:
+------------------+     +------------------+     +------------------+
| Club creates     |     | Trainer creates  |     | Academy creates  |
| cycles           |     | cycles           |     | cycles           |
+------------------+     +------------------+     +------------------+
         ↓                        ↓                        ↓
+------------------+     +------------------+     +------------------+
| Club page shows  |     | (not displayed)  |     | (not displayed)  |
| club cycles only |     |                  |     |                  |
+------------------+     +------------------+     +------------------+

AFTER:
+------------------+     +------------------+
| Trainer creates  |     | Academy creates  |
| cycles           |     | cycles           |
+------------------+     +------------------+
         ↓                        ↓
+--------------------------------------------------+
| Club/Location page shows BOTH:                   |
| - Cycles from trainers at this location          |
| - Cycles from academies at this location         |
+--------------------------------------------------+
         ↓                        ↓
+------------------+     +------------------+
| Trainer profile  |     | Academy profile  |
| shows own cycles |     | shows own cycles |
+------------------+     +------------------+
```

## Summary

| Change | Impact |
|--------|--------|
| Remove club cycle creation | Clubs focus on venue management, not lesson scheduling |
| Add cycles to trainer profile | Players can apply directly from trainer pages |
| Add cycles to academy profile | Players can apply directly from academy pages |
| Aggregate cycles on location pages | Players see all training opportunities at a venue |

This creates a cleaner hierarchy where:
- **Trainers** manage their own independent cycles
- **Academies** manage cycles across multiple locations with multiple trainers
- **Clubs/Locations** display aggregated cycles from everyone working there
