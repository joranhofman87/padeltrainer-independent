

# Enhanced Trainer Cards - Always Show Key Info with Icons

## Overview
Update trainer cards on the `/trainers` overview page to always display key information fields with their icons, showing a dash (`-`) when data is missing. This provides visual consistency and makes it easier to troubleshoot/compare trainers.

## Fields to Always Display
1. **Rating** - Star icon with rating value (or `-` if none)
2. **Reviews** - Review count in parentheses (or `-` if none)
3. **Available Lessons** - Calendar/check icon showing Yes/No
4. **Years of Experience** - Clock icon with years (or `-` if none)

## Current State
- **Location**: `src/pages/Trainers.tsx`
- **Rating/Reviews**: Only shown when `reviewCount > 0` (lines 713-721, 555-563)
- **Experience**: Only shown when `experience_years` exists (lines 744-748, 586-590)
- **Availability**: Not currently tracked/displayed

## Implementation

### Step 1: Extend TrainerWithProfile Interface
Add `hasAvailability` field to track if trainer has upcoming slots:

```typescript
interface TrainerWithProfile {
  // ... existing fields
  hasAvailability: boolean;  // NEW
}
```

### Step 2: Fetch Availability Data
Query availability_slots to check which trainers have future slots:

```typescript
// In fetchTrainers(), after fetching trainer profiles:
const now = new Date().toISOString();
const { data: availabilityData } = await supabase
  .from('availability_slots')
  .select('trainer_id')
  .in('trainer_id', trainerIds)
  .gt('start_time', now)
  .is('lesson_id', null);  // Only open slots

// Build a Set of trainer IDs with availability
const trainersWithAvailability = new Set(
  availabilityData?.map(a => a.trainer_id) || []
);
```

### Step 3: Update Card Layout
Replace conditional rendering with always-visible info row:

```tsx
{/* Always-visible Info Row */}
<div className="flex items-center gap-4 text-sm text-muted-foreground mt-2">
  {/* Rating & Reviews */}
  <div className="flex items-center gap-1">
    <Star className="h-3.5 w-3.5 text-yellow-400" />
    <span className={trainer.reviewCount > 0 ? 'font-medium text-foreground' : ''}>
      {trainer.reviewCount > 0 ? trainer.averageRating.toFixed(1) : '-'}
    </span>
  </div>
  
  {/* Review Count */}
  <div className="flex items-center gap-1">
    <MessageSquare className="h-3.5 w-3.5" />
    <span>{trainer.reviewCount > 0 ? trainer.reviewCount : '-'}</span>
  </div>
  
  {/* Availability */}
  <div className="flex items-center gap-1">
    <CalendarCheck className="h-3.5 w-3.5" />
    <span className={trainer.hasAvailability ? 'text-green-600 font-medium' : ''}>
      {trainer.hasAvailability ? 'Yes' : 'No'}
    </span>
  </div>
  
  {/* Experience */}
  <div className="flex items-center gap-1">
    <Clock className="h-3.5 w-3.5" />
    <span>{trainer.experience_years ? `${trainer.experience_years}y` : '-'}</span>
  </div>
</div>
```

### Step 4: Add New Icon Imports
```typescript
import { 
  Search, MapPin, Star, ArrowLeft, TrendingUp, ChevronRight, ChevronDown,
  MessageSquare, CalendarCheck, Clock  // NEW
} from 'lucide-react';
```

## Visual Design

```text
┌──────────────────────────────────────┐
│  [Avatar]  Trainer Name              │
│            📍 Amsterdam              │
│                                      │
│  ⭐ 4.5   💬 12   📅 Yes   🕐 5y    │  ← Always visible row
│                                      │
│  €45/hr          KNLTB 7.5           │
│                                      │
│  [Specialization badges...]          │
└──────────────────────────────────────┘

When data is missing:
│  ⭐ -    💬 -    📅 No    🕐 -      │
```

## Files Changed

| File | Action | Changes |
|------|--------|---------|
| `src/pages/Trainers.tsx` | Edit | Add hasAvailability to interface, fetch availability, update both card sections (featured + grid) |

## Technical Notes

1. **Single Query for Availability**: We'll use a single query with `SELECT DISTINCT trainer_id` to efficiently check which trainers have open slots
2. **Both Card Sections**: Must update both the Featured Trainers section (lines ~555-610) AND the regular grid (lines ~713-765)
3. **Consistent Styling**: Missing data shown with `-` and muted styling; available data uses appropriate color highlights
4. **Performance**: The availability query is efficient as it only needs to check existence, not count slots

