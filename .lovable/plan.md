
# Plan: Add Academy Manager Assignment to Admin Panel

## Problem

Currently, there is no way in the admin UI to assign a user (including trainers like René Lindenbergh) as an owner or manager of an academy. The `academy_managers` table exists and supports this relationship, but:
- The `AddAcademyDialog` creates academies without any manager
- The `AcademyEditDialog` has no tab for managing academy managers
- Most academies have no managers assigned at all

## Solution

Add a "Managers" tab to the `AcademyEditDialog` that allows admins to:
1. View current managers with their roles (owner/manager)
2. Add a user as a manager or owner
3. Change a manager's role
4. Remove managers

## Implementation

### Changes to `src/components/admin/AcademyEditDialog.tsx`

**1. Add Managers tab to the TabsList:**
```
Profile | Locations | Trainers | Managers | Settings
```

**2. Add state for managers:**
- `managers` - list of current academy managers with profile info
- `availableUsers` - list of users that can be assigned as managers
- `userSearch` - search filter for the user picker

**3. Add manager management functions:**
- `loadManagers()` - fetch academy managers with profile data
- `handleAddManager(userId, role)` - insert into `academy_managers`
- `handleUpdateManagerRole(managerId, newRole)` - update role
- `handleRemoveManager(managerId)` - delete from `academy_managers`

**4. Add Managers tab content:**
- Table showing current managers (name, email, role, actions)
- Combobox to search and select users to add
- Role selector (owner/manager)
- Add/Remove buttons

### User Interface

The Managers tab will look like this:

```text
┌─────────────────────────────────────────────────────────────────────┐
│  Current Managers                                                   │
├─────────────────────────────────────────────────────────────────────┤
│  Name              │ Email                  │ Role    │ Actions     │
│  ─────────────────────────────────────────────────────────────────  │
│  René Lindenbergh  │ rene@example.com       │ Owner ▼ │ [Remove]    │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  Add Manager                                                        │
├─────────────────────────────────────────────────────────────────────┤
│  Search user...                               [Manager ▼] [+ Add]   │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ John Doe (john@example.com)                                    │ │
│  │ Jane Smith (jane@example.com)                                  │ │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### Database Considerations

The RLS policies on `academy_managers` allow:
- `Admins can view all academy managers` (SELECT)
- `Academy owners can add managers` (INSERT) - need to bypass for admin

Since admins don't have INSERT policy on `academy_managers`, we'll need to use the admin's elevated permissions carefully. The current policies show admins can view and delete, but INSERT requires being an academy owner or the academy having no managers.

**Option A:** Add a new RLS policy for admin INSERT:
```sql
CREATE POLICY "Admins can insert academy managers"
ON academy_managers FOR INSERT
WITH CHECK (is_admin(auth.uid()));
```

**Option B:** Use an edge function with service role key (like we did for trainers)

I recommend **Option A** as it's simpler and keeps the logic in the database.

### Role Assignment Logic

When a user is added as an academy manager:
1. Insert into `academy_managers` with the selected role
2. Also assign the `academy` role in `user_roles` if they don't have it (so they can access the academy dashboard)

## Files to Modify

| File | Change |
|------|--------|
| `src/components/admin/AcademyEditDialog.tsx` | Add Managers tab with full CRUD UI |
| (migration) | Add RLS policy for admin INSERT on `academy_managers` |

## Technical Details

### Manager Data Structure

```typescript
interface AcademyManager {
  id: string;
  user_id: string;
  role: 'owner' | 'manager';
  profile: {
    full_name: string | null;
    email: string | null;
    avatar_url: string | null;
  } | null;
}
```

### User Search

The user picker will search across all `profiles` (not just trainers), allowing any user to become an academy manager. This is important because:
- Trainers can be managers (like René)
- Non-trainers can also manage academies (e.g., business administrators)

## Immediate Use Case

After implementation, to make René Lindenbergh the owner of an academy:
1. Go to Admin → Academies
2. Click on the academy to edit
3. Go to "Managers" tab
4. Search for "René Lindenbergh"
5. Select "Owner" role
6. Click "Add"

This will create the `academy_managers` record and give René access to the academy dashboard.
