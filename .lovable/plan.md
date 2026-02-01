
# Add Rating System Editing for Trainers in Admin Panel

## Overview
Allow admins to view and edit a trainer's skill rating, rating system (e.g., KNLTB, Playtomic), and member ID directly from the admin trainer edit dialog.

## Current State
- **Profiles table** stores: `skill_rating`, `rating_system`, `rating_member_id`
- **TrainerEditDialog** currently edits profile fields (name, email, phone, bio, avatar) via the `update-user` edge function
- **Admin data hook** fetches profile data but does NOT include rating fields
- **Rating systems** are admin-managed in the `rating_systems` table with dynamic min/max, step values, and `lower_is_better` logic

## Implementation Steps

### Step 1: Extend the Profile Data Fetch
**File: `src/hooks/useAdminData.ts`**

Update the profiles query to include rating-related fields:
```typescript
// Line 159-161: Add rating fields to profiles select
.select("user_id, full_name, email, avatar_url, phone, bio, skill_rating, rating_system, rating_member_id")
```

Update the `TrainerProfileAdmin` interface (around line 100) to include:
- `skill_rating: number | null`
- `rating_system: string | null`
- `rating_member_id: string | null`

Update the merge logic to include these fields in the returned object.

### Step 2: Update TrainerEditData Interface
**File: `src/components/admin/TrainerEditDialog.tsx`**

Add new fields to the `TrainerEditData` interface:
```typescript
skill_rating: number | null;
rating_system: string | null;
rating_member_id: string | null;
```

### Step 3: Add State and UI for Rating Fields
**File: `src/components/admin/TrainerEditDialog.tsx`**

Add state variables:
```typescript
const [skillRating, setSkillRating] = useState(trainer.skill_rating?.toString() || "");
const [ratingSystem, setRatingSystem] = useState(trainer.rating_system || "knltb");
const [ratingMemberId, setRatingMemberId] = useState(trainer.rating_member_id || "");
const [ratingSystems, setRatingSystems] = useState<RatingSystemConfig[]>([]);
```

Fetch available rating systems when dialog opens using `getRatingSystems()`.

Add UI in the Profile tab (after the phone/avatar section):
- **Rating System dropdown**: Select from available rating systems
- **Skill Rating input**: Numeric input with min/max/step from selected system, with helper text showing valid range
- **Member ID input**: Only show when the selected system has a `member_id_label`

### Step 4: Update the Edge Function
**File: `supabase/functions/update-user/index.ts`**

Extend the request body destructuring to include:
```typescript
const { target_user_id, email, full_name, phone, bio, avatar_url, 
        skill_rating, rating_system, rating_member_id } = await req.json();
```

Add these fields to the profile update:
```typescript
if (skill_rating !== undefined) updates.skill_rating = skill_rating;
if (rating_system !== undefined) updates.rating_system = rating_system;
if (rating_member_id !== undefined) updates.rating_member_id = rating_member_id;
```

### Step 5: Update Save Handler
**File: `src/components/admin/TrainerEditDialog.tsx`**

Pass the rating fields to the edge function in `handleSave`:
```typescript
skill_rating: skillRating ? parseFloat(skillRating) : null,
rating_system: ratingSystem || "knltb",
rating_member_id: ratingMemberId || null,
```

---

## UI Design

The rating fields will be added to the **Profile tab**, creating a new section after the contact information:

```text
┌─────────────────────────────────────────────────────────────┐
│  Rating System             │  Skill Rating                  │
│  ▼ KNLTB                   │  [ 5.0      ] (0.1 - 9.9)     │
├─────────────────────────────────────────────────────────────┤
│  KNLTB Number                                               │
│  [ 12345678           ]                                     │
└─────────────────────────────────────────────────────────────┘
```

- Rating System: Dropdown populated from `rating_systems` table
- Skill Rating: Number input with validation based on selected system
- Member ID: Text input, only visible when the system has `member_id_label`

---

## Files Changed

| File | Action | Changes |
|------|--------|---------|
| `src/hooks/useAdminData.ts` | Edit | Add rating fields to profile query and interface |
| `src/components/admin/TrainerEditDialog.tsx` | Edit | Add rating UI, state, and save logic |
| `supabase/functions/update-user/index.ts` | Edit | Support rating field updates |

---

## Technical Details

### Rating System Validation
The implementation will dynamically adjust the rating input based on the selected system:
- KNLTB: 0.1 - 9.9, step 0.1, lower is better
- Playtomic: 0.1 - 6.0, step 0.1, higher is better

### Edge Function Security
The existing admin role check in `update-user` ensures only admins can update these fields. No additional RLS changes needed since the edge function uses `service_role`.
