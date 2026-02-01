
# Fix KNLTB Rating Display on Trainer Cards

## Problem Identified
Trainer KNLTB ratings exist but aren't showing because:
1. **Data location mismatch**: Ratings are stored in `profiles.skill_rating` but code looks for `trainer_profiles.knltb_rating`
2. **Not fetched**: The query to `profiles_public` doesn't include `skill_rating` or `rating_system` fields
3. **Display condition**: Code checks `trainer.knltb_rating` which is NULL for all trainers

## Current Data

| Trainer | profiles.skill_rating | trainer_profiles.knltb_rating |
|---------|----------------------|------------------------------|
| Nikki van der Linden | 4.2 | NULL |
| Patrick Bernardus | 4.6 | NULL |
| Tygho Schoonus | 0.9 | NULL |
| Sep van den Berg | 3.7 | NULL |
| Max Ebbers | 5.1 | NULL |

## Solution

### Step 1: Update Profile Interface
Extend the `profile` object in `TrainerWithProfile` to include rating fields:

```typescript
profile: {
  full_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  location: string | null;
  skill_rating: number | null;    // NEW
  rating_system: string | null;   // NEW
} | null;
```

### Step 2: Fetch Rating Data from profiles_public
Update the query at line 251 to include the rating fields:

```typescript
const { data: profiles } = await supabase
  .from('profiles_public')
  .select('user_id, full_name, avatar_url, bio, location, skill_rating, rating_system')
  .in('user_id', userIds);
```

### Step 3: Update Card Display (Featured Section)
Replace lines 611-616 to show the profile rating:

```tsx
<div className="flex items-center gap-2 text-muted-foreground text-xs">
  {trainer.profile?.skill_rating && trainer.profile?.rating_system && (
    <span className="font-medium text-foreground">
      {ratingSystems.find(rs => rs.code === trainer.profile?.rating_system)?.name || 
        trainer.profile.rating_system.toUpperCase()} {trainer.profile.skill_rating}
    </span>
  )}
</div>
```

### Step 4: Update Card Display (Main Grid)
Same change for lines 778-783.

### Step 5: Show Rating Icon in Info Row (Optional Enhancement)
Add the KNLTB/skill rating to the always-visible info row alongside the review rating:

```tsx
{/* In the info row, add after experience */}
<div className="flex items-center gap-1">
  <Trophy className="h-3 w-3" />  {/* or another suitable icon */}
  <span className={trainer.profile?.skill_rating ? 'font-medium text-foreground' : ''}>
    {trainer.profile?.skill_rating 
      ? `${trainer.profile.skill_rating.toFixed(1)}`
      : '-'}
  </span>
</div>
```

## Visual Result

```text
┌──────────────────────────────────────────────────────────────────┐
│  [Avatar]  Nikki van der Linden                                  │
│            📍 Amsterdam                                          │
│                                                                  │
│  ⭐ 4.8   💬 12   📅 Yes   🕐 5y   🏆 4.2                        │
│                                                                  │
│  €45/hr                    KNLTB 4.2                             │
│                                                                  │
│  [Specialization badges...]                                      │
└──────────────────────────────────────────────────────────────────┘
```

## Files Changed

| File | Action | Changes |
|------|--------|---------|
| `src/pages/Trainers.tsx` | Edit | Add rating fields to profile query, update interface, display skill_rating from profile |

## Technical Notes

1. **Backward compatible**: Keep checking `trainer.knltb_rating` as fallback in case some trainers have it set directly
2. **Both card sections**: Must update Featured (line 611) and Grid (line 778) sections
3. **Profile rating vs Trainer rating**: The profile holds the player's skill rating; the trainer_profiles could optionally hold a separate "trainer credential rating" if needed in future
