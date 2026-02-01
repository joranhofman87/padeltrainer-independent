

# Clean Up Test Users - Execution Plan

## Current Situation
- **23 non-admin test accounts** need to be deleted
- **2 admin accounts** will be preserved:
  - `info@padeltrainer.ai` (user_id: `256b0ed5-1563-4eb5-899b-df559c5e9090`)
  - `joranhofman87@gmail.com` (user_id: `9bcc1c6f-7978-49bb-aa06-6f1be4135fc7`)

## Implementation Approach

I'll create a **bulk cleanup edge function** that will:
1. Get all non-admin user IDs
2. For each user, perform the same cascaded cleanup as the existing `delete-user` function
3. Delete the auth users via admin API

### New Edge Function: `bulk-cleanup-users`

This function will:
- Require admin authentication
- Accept a confirmation parameter to prevent accidental execution
- Clean up all related data in the correct order (respecting foreign keys)
- Delete users from auth system
- Return a summary of deleted accounts

### Cleanup Order (per user)
1. Calendar events
2. Notification preferences  
3. Club-related data (invitations, players, stripe accounts, managers, profiles)
4. Trainer-related data (locations, followers, profile views, slots, lessons, guest players, invoices, profiles)
5. Player-related data (locations, rating history, followers, anonymize bookings/reviews)
6. User roles
7. Profiles
8. Auth user

### Files to Create/Modify
- **Create**: `supabase/functions/bulk-cleanup-users/index.ts`

### How to Execute
After I create the function, you can call it via:
```
POST /functions/v1/bulk-cleanup-users
Authorization: Bearer <your-admin-token>
Body: { "confirm": true }
```

Or I can call it for you using the edge function testing tool.

