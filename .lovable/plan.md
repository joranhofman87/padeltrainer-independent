

# Fix Privilege Escalation on user_roles

## Problem

The current INSERT policy on `user_roles` is:
```sql
WITH CHECK (auth.uid() = user_id)
```

This allows any authenticated user to insert **any role** for themselves, including `admin`. A malicious user could simply call:
```sql
INSERT INTO user_roles (user_id, role) VALUES (auth.uid(), 'admin');
```

## Fix

Drop the permissive INSERT policy entirely. Role assignment should only happen through:
- Edge functions using the service role key (signup-user, toggle-player-role)
- Database triggers (link_guest_invoices_on_signup)
- Admin actions via service role

No regular user should ever directly INSERT into `user_roles`.

## Migration SQL

```sql
DROP POLICY IF EXISTS "Users can insert their own role" ON public.user_roles;

-- Only admins can manually insert roles (for admin dashboard use)
CREATE POLICY "Admins can insert roles"
  ON public.user_roles
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin(auth.uid()));
```

The existing `SECURITY DEFINER` functions and edge functions using the service role key will continue to work since they bypass RLS.

## File summary

| File | Change |
|------|--------|
| Migration SQL | Drop self-service INSERT policy, add admin-only INSERT policy |

