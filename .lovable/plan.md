
# Academy Owner as Trainer + Data Consistency Fix

## Overview

This plan addresses two related issues:

1. **Academy owners who are also trainers should appear on `/academy/trainers`** - Currently, when an academy owner like Rene is also a trainer, they don't automatically appear in the trainers list because they're not in the `academy_trainers` table.

2. **Edit dialog not showing existing data** - The `EditAcademyTrainerDialog` fetches data correctly, but the `getAcademyTrainersWithProfiles` function is missing the `slug` field, and the trainers list doesn't include all needed trainer profile fields.

---

## Problem Analysis

### Issue 1: Academy Owner Not Shown as Trainer

**Current State:**
- Rene is an academy manager (owner) with `user_id: 48f0e4c9-...`
- Rene has a trainer profile with `trainer_profile_id: c0497580-...`
- Rene is **NOT** in `academy_trainers` table for his academy
- Therefore, he doesn't show on `/academy/trainers`

**Comparison with Bram:**
- Bram is also an academy owner AND trainer
- Bram IS in `academy_trainers` table for his academy
- Therefore, Bram appears on his academy's trainers page

### Issue 2: Missing Data in Trainer List

**Current `getAcademyTrainersWithProfiles` query:**
```sql
SELECT *, trainer_profiles(id, user_id, hourly_rate, experience_years, 
                           specializations, certifications, is_verified)
FROM academy_trainers
```

**Missing fields:** `slug` (needed for profile links)

---

## Solution

### Part 1: Add "Add Yourself as Trainer" Feature

Since academy managers who are also trainers may want to be listed on their academy page, provide a way to add themselves.

**Approach: Auto-suggest when academy manager has a trainer profile**

When the page loads, check if the current user:
1. Is an academy manager
2. Has a trainer profile
3. Is NOT already in `academy_trainers` for this academy

If all conditions are met, show a prompt/card to add themselves.

#### UI Addition in `AcademyTrainers.tsx`

Add a banner or card above the trainers list:

```text
+----------------------------------------------------------+
| 👋 You're also a trainer!                                |
|                                                          |
| Would you like to add yourself to your academy's         |
| trainer roster?                                          |
|                                                          |
|                        [Add Myself as Trainer]           |
+----------------------------------------------------------+
```

#### New Helper Function in `src/lib/academy.ts`

```typescript
// Check if current user can add themselves as a trainer
export async function canUserAddSelfAsTrainer(
  userId: string, 
  academyProfileId: string
): Promise<{ canAdd: boolean; trainerProfileId?: string }>;

// Add academy manager as a trainer
export async function addSelfAsAcademyTrainer(
  academyProfileId: string, 
  trainerProfileId: string, 
  userId: string
): Promise<boolean>;
```

### Part 2: Fix Data Fetching

#### Update `getAcademyTrainersWithProfiles` Query

Add missing `slug` field to the trainer_profiles select:

```typescript
const { data, error } = await supabase
  .from('academy_trainers')
  .select(`
    *,
    trainer_profile:trainer_profiles(
      id,
      user_id,
      slug,  // ADD THIS
      hourly_rate,
      experience_years,
      specializations,
      certifications,
      is_verified
    )
  `)
  .eq('academy_profile_id', academyProfileId);
```

This ensures the "View Profile" button in `AcademyTrainers.tsx` can correctly link to `/trainer/{slug}`.

### Part 3: Ensure Edit Dialog Shows Correct Data

The `EditAcademyTrainerDialog` already fetches data correctly when opened (it queries `profiles` and `trainer_profiles` directly by ID). The issue is that the data is fetched properly - we just need to verify it works.

However, I'll verify that the `trainerId` and `userId` props being passed are correct.

---

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/lib/academy.ts` | Modify | Add `slug` to trainer query; add `canUserAddSelfAsTrainer` and `addSelfAsAcademyTrainer` functions |
| `src/pages/academy/AcademyTrainers.tsx` | Modify | Add "Add yourself as trainer" banner/button for eligible managers |
| `src/i18n/locales/en/academy.json` | Modify | Add translation keys for new UI |
| `src/i18n/locales/nl/academy.json` | Modify | Add Dutch translations |

---

## Implementation Details

### 1. New Helper Functions (`src/lib/academy.ts`)

```typescript
// Check if current user can add themselves as a trainer
export async function canUserAddSelfAsTrainer(
  userId: string, 
  academyProfileId: string
): Promise<{ canAdd: boolean; trainerProfileId?: string; trainerName?: string }> {
  // Check if user has a trainer profile
  const { data: trainerProfile } = await supabase
    .from('trainer_profiles')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle();

  if (!trainerProfile) {
    return { canAdd: false };
  }

  // Check if already in academy_trainers
  const { data: existing } = await supabase
    .from('academy_trainers')
    .select('id')
    .eq('academy_profile_id', academyProfileId)
    .eq('trainer_profile_id', trainerProfile.id)
    .maybeSingle();

  if (existing) {
    return { canAdd: false };
  }

  // Get user's name for display
  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name')
    .eq('user_id', userId)
    .single();

  return { 
    canAdd: true, 
    trainerProfileId: trainerProfile.id,
    trainerName: profile?.full_name 
  };
}

// Add the current user as an academy trainer
export async function addSelfAsAcademyTrainer(
  academyProfileId: string, 
  trainerProfileId: string, 
  userId: string
): Promise<boolean> {
  const { error } = await supabase
    .from('academy_trainers')
    .insert({
      academy_profile_id: academyProfileId,
      trainer_profile_id: trainerProfileId,
      status: 'active',
      invited_by: userId,
      joined_at: new Date().toISOString(),
      show_on_academy_page: true,
    });

  if (error) {
    console.error('Error adding self as trainer:', error);
    return false;
  }

  return true;
}
```

### 2. Updated Trainer Query (`src/lib/academy.ts`)

```typescript
// Line ~714 - Add slug to the select
.select(`
  *,
  trainer_profile:trainer_profiles(
    id,
    user_id,
    slug,
    hourly_rate,
    experience_years,
    specializations,
    certifications,
    is_verified
  )
`)
```

### 3. UI Component (`AcademyTrainers.tsx`)

Add state and check on load:

```typescript
const [canAddSelf, setCanAddSelf] = useState<{
  canAdd: boolean;
  trainerProfileId?: string;
  trainerName?: string;
}>({ canAdd: false });

// In fetchData, also check if user can add themselves
if (user) {
  const selfCheck = await canUserAddSelfAsTrainer(user.id, activeAcademy.id);
  setCanAddSelf(selfCheck);
}

// Render banner above trainers list
{canAddSelf.canAdd && (
  <Card className="mb-6 border-primary/20 bg-primary/5">
    <CardContent className="py-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Users className="h-5 w-5 text-primary" />
          <div>
            <p className="font-medium">{t('trainers.addSelfTitle')}</p>
            <p className="text-sm text-muted-foreground">
              {t('trainers.addSelfDescription')}
            </p>
          </div>
        </div>
        <Button onClick={handleAddSelf}>
          {t('trainers.addMyselfAsTrainer')}
        </Button>
      </div>
    </CardContent>
  </Card>
)}
```

### 4. Translation Keys

```json
{
  "trainers": {
    "addSelfTitle": "You're also a trainer!",
    "addSelfDescription": "Add yourself to your academy's trainer roster to appear on the public page.",
    "addMyselfAsTrainer": "Add Myself as Trainer",
    "addedSelf": "You've been added as a trainer"
  }
}
```

---

## Visual Flow

```text
Academy Trainers Page (for manager who is also a trainer):

+----------------------------------------------------------+
| 👥 You're also a trainer!                                |
| Add yourself to your academy's trainer roster to appear  |
| on the public page.                                      |
|                        [Add Myself as Trainer]           |
+----------------------------------------------------------+

+----------------------------------------------------------+
| Trainers                    [Create Trainer] [Invite]    |
+----------------------------------------------------------+
| [Active Trainers (2)]  [Pending Invitations (0)]         |
+----------------------------------------------------------+
|  +---------------+  +---------------+                    |
|  | [Avatar]      |  | [Avatar]      |                    |
|  | Trainer 1     |  | Trainer 2     |                    |
|  | €50/hour      |  | €45/hour      |                    |
|  | [Edit] [View] |  | [Edit] [View] |                    |
|  +---------------+  +---------------+                    |
+----------------------------------------------------------+
```

After clicking "Add Myself as Trainer":
- Banner disappears
- User appears in the trainers grid
- Can edit their own profile visibility and details

---

## Summary

1. **Add `slug` field** to `getAcademyTrainersWithProfiles` query
2. **Add `canUserAddSelfAsTrainer`** function to check if manager can add themselves
3. **Add `addSelfAsAcademyTrainer`** function to insert the record
4. **Update `AcademyTrainers.tsx`** with banner UI for eligible managers
5. **Add translation keys** for the new UI elements

This ensures:
- Academy owners who are trainers can easily add themselves to the trainer roster
- All trainer data is properly fetched including the slug for profile links
- The edit dialog continues to work correctly with full data
