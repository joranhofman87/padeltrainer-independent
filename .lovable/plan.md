
# Plan: Add Trainer Creation to Admin Panel

## Summary

Add an "Add Trainer" button and dialog to the Admin Trainers page that allows administrators to create new trainer accounts directly. This will create a user account, assign the trainer role, and set up the trainer profile with configurable settings.

## Implementation Approach

### 1. Create Edge Function: `create-admin-trainer`

**File:** `supabase/functions/create-admin-trainer/index.ts`

This edge function will:
- Verify the caller is an admin user
- Create a new user account with a temporary password (or link existing user)
- Create the profile with the provided name
- Assign the "trainer" role in `user_roles`
- Create the `trainer_profiles` record with trial dates
- Return the trainer ID and temporary password

```text
Request Body:
- email (required)
- fullName (required)  
- phone (optional)
- subscriptionStatus: 'trial' | 'active' | 'inactive' (optional, default: 'trial')
- isPublic: boolean (optional, default: false)

Response:
- success: boolean
- trainerId: string
- temporaryPassword: string | null
- isNewUser: boolean
```

### 2. Create Dialog Component: `AddTrainerDialog`

**File:** `src/components/admin/AddTrainerDialog.tsx`

Form fields:
- Full Name (required)
- Email (required)
- Phone (optional)
- Subscription Status dropdown (Trial / Active / Inactive)
- Is Public toggle

After successful creation:
- Show success toast with temporary password (if new user)
- Provide copy button for the password
- Refresh the trainers list

### 3. Update Admin Trainers Page

**File:** `src/pages/admin/AdminTrainers.tsx`

Add:
- "Add Trainer" button in the page header
- Import and render `AddTrainerDialog`
- State for dialog open/close

## Visual Design

The page header will look like this after the change:

```text
┌─────────────────────────────────────────────────────────────────┐
│  Trainer Management                         [+ Add Trainer]    │
│  View and manage trainer subscriptions                         │
└─────────────────────────────────────────────────────────────────┘
```

The dialog will follow the same pattern as `AddAcademyDialog`:

```text
┌───────────────────────────────────────────────────┐
│  Add Trainer                               [X]    │
│  Create a new trainer account                     │
├───────────────────────────────────────────────────┤
│                                                   │
│  Full Name *                                      │
│  [________________________________]               │
│                                                   │
│  Email *                                          │
│  [________________________________]               │
│                                                   │
│  Phone                                            │
│  [________________________________]               │
│                                                   │
│  Subscription Status                              │
│  [Trial                        ▼]                 │
│                                                   │
│  Public Profile                    [  ]           │
│  Visible in the trainer directory                 │
│                                                   │
├───────────────────────────────────────────────────┤
│                    [Cancel]  [Create Trainer]     │
└───────────────────────────────────────────────────┘
```

## Technical Details

### Edge Function Logic

The edge function will mirror the `create-club-trainer` function but with admin-level permissions:

1. **Auth Check**: Verify caller is admin via `is_admin()` database function
2. **User Creation**: 
   - Check if email exists → reuse existing user
   - If new → create user with `auth.admin.createUser()` and temporary password
3. **Profile Setup**:
   - Update `profiles` table with name/phone
   - Insert into `user_roles` with role = 'trainer'
   - Insert into `trainer_profiles` with trial dates and subscription status
4. **Return**: Trainer ID, temp password (if new), and success status

### Password Handling

When a new trainer is created, the dialog will:
1. Show the temporary password in a highlighted box
2. Provide a "Copy Password" button
3. Display instructions to share the password securely

## File Changes

| File | Change |
|------|--------|
| `supabase/functions/create-admin-trainer/index.ts` | New edge function for admin trainer creation |
| `src/components/admin/AddTrainerDialog.tsx` | New dialog component with form |
| `src/pages/admin/AdminTrainers.tsx` | Add button and dialog integration |

## Security Considerations

- Edge function validates admin status server-side using `is_admin()` RPC
- Temporary passwords are generated with sufficient entropy (12 chars, mixed case + numbers + symbols)
- Password is only shown once in the UI and must be copied immediately
