

# Limit Featured Trainers to 6 + Add Collapsible Section

## Overview
Modify the trainers overview page to:
1. Reduce max featured trainers from 8 to 6
2. Make the featured section collapsible (open/closed)

## Current State
- **Location**: `src/pages/Trainers.tsx`
- **Featured limit**: Currently set to `MAX_FEATURED = 8` (line 33)
- **Featured section**: Uses `FeaturedSection` component, rendered between filters and search (lines 497-594)
- **Collapsible component**: Already available at `src/components/ui/collapsible.tsx` using Radix UI

## Implementation

### Step 1: Update MAX_FEATURED Constant
**File: `src/pages/Trainers.tsx`**

Change line 33:
```typescript
// Before
const MAX_FEATURED = 8;

// After
const MAX_FEATURED = 6;
```

### Step 2: Add Collapsible State
**File: `src/pages/Trainers.tsx`**

Add state to track if featured section is open (default: open):
```typescript
const [featuredOpen, setFeaturedOpen] = useState(true);
```

### Step 3: Import Collapsible Components
**File: `src/pages/Trainers.tsx`**

Add to imports:
```typescript
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown } from 'lucide-react';
```

Note: `ChevronDown` is already imported, but we'll add `ChevronUp` or use rotation.

### Step 4: Wrap FeaturedSection in Collapsible
**File: `src/pages/Trainers.tsx`**

Update the Featured Trainers section (lines 497-594) to use Collapsible:

```tsx
{/* Featured Trainers Section */}
{!loading && featuredTrainers.length > 0 && !searchQuery && activeFilterCount === 0 && (
  <Collapsible open={featuredOpen} onOpenChange={setFeaturedOpen} className="mb-8">
    <section className="py-6 px-4 bg-gradient-to-r from-primary/5 via-primary/10 to-primary/5 rounded-xl border border-primary/10">
      <CollapsibleTrigger asChild>
        <button className="w-full flex items-center justify-between gap-2 cursor-pointer group">
          <div className="flex items-center gap-2">
            <Star className="h-5 w-5 text-primary fill-primary/50" />
            <h2 className="text-lg font-semibold">{t('common:featured.trainers')}</h2>
            <span className="text-sm text-muted-foreground">
              ({featuredTrainers.length})
            </span>
          </div>
          <ChevronDown className={`h-5 w-5 text-muted-foreground transition-transform duration-200 ${featuredOpen ? 'rotate-180' : ''}`} />
        </button>
      </CollapsibleTrigger>
      
      <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
        <p className="text-sm text-muted-foreground mt-2 mb-4">
          {t('common:featured.trainersDescription')}
        </p>
        <div className="overflow-x-auto pb-2 -mx-4 px-4">
          <div className="flex gap-6 min-w-max lg:grid lg:grid-cols-3 lg:min-w-0">
            {/* trainer cards here */}
          </div>
        </div>
      </CollapsibleContent>
    </section>
  </Collapsible>
)}
```

## UI Behavior

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ ⭐ Featured Trainers (6)                                           ▼   │
├─────────────────────────────────────────────────────────────────────────┤
│  Premium trainers with verified profiles                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ...           │
│  │ Trainer 1│  │ Trainer 2│  │ Trainer 3│  │ Trainer 4│                │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘                │
└─────────────────────────────────────────────────────────────────────────┘

When collapsed:
┌─────────────────────────────────────────────────────────────────────────┐
│ ⭐ Featured Trainers (6)                                           ▶   │
└─────────────────────────────────────────────────────────────────────────┘
```

- Clicking the header toggles the section
- Chevron rotates to indicate open/closed state
- Count badge shows number of featured trainers
- Smooth animation on open/close via Radix CollapsibleContent

## Files Changed

| File | Action | Changes |
|------|--------|---------|
| `src/pages/Trainers.tsx` | Edit | Change MAX_FEATURED to 6, add featuredOpen state, wrap section in Collapsible |

## Technical Notes

1. **No FeaturedSection component changes needed** - We'll inline the section styling since we need more control over the collapsible structure
2. **Animation** - Radix Collapsible handles the animation automatically via data attributes
3. **Accessibility** - CollapsibleTrigger handles ARIA attributes automatically
4. **State persistence** - Could optionally persist to localStorage later if users want the preference remembered

