
# Make joranhofman87@gmail.com Admin

## Current Status

Found the user in the database:
- **Email**: joranhofman87@gmail.com
- **Name**: Joran
- **User ID**: `9bcc1c6f-7978-49bb-aa06-6f1be4135fc7`
- **Current Role**: player

## Action Required

Add the `admin` role to this user's roles in the `user_roles` table.

## Implementation

**Database Change (Migration):**

```sql
INSERT INTO public.user_roles (user_id, role)
VALUES ('9bcc1c6f-7978-49bb-aa06-6f1be4135fc7', 'admin')
ON CONFLICT (user_id, role) DO NOTHING;
```

This will:
1. Add the `admin` role for Joran
2. Keep their existing `player` role (users can have multiple roles)
3. Use `ON CONFLICT DO NOTHING` to safely handle if already an admin

## Result

After this change, joranhofman87@gmail.com will have access to the Admin Dashboard and all admin functionality.
