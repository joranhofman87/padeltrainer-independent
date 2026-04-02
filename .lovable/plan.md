

# Fix: Auto-assign player role on guest-to-user conversion

## Problem
When a guest player (created via invoice) later signs up, the `link_guest_invoices_on_signup` trigger links their invoices/bookings but never assigns the `player` role in `user_roles`. Role assignment only happens through the frontend onboarding flow via `pendingRole` in localStorage/sessionStorage, which is bypassed when users sign up from invoice links.

## Solution
Two changes to close the gap from both directions:

### 1. Database migration: Update `link_guest_invoices_on_signup` trigger
After linking guest invoices and bookings, insert a `player` role into `user_roles` if any guest data was actually linked. Use `ON CONFLICT DO NOTHING` to avoid errors if the role already exists.

```sql
-- At the end of the function, after linking guest_players:
IF FOUND THEN
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.user_id, 'player')
  ON CONFLICT (user_id, role) DO NOTHING;
END IF;
```

### 2. Edge function: `signup-user/index.ts` — assign role server-side
The function already receives a `role` parameter but never uses it for role assignment. Add role insertion after user creation (before the welcome email) so that even if the frontend onboarding is skipped, the user gets their role.

```typescript
// After profile update, before welcome email
if (signupRole) {
  await supabaseAdmin
    .from('user_roles')
    .upsert({ user_id: user.id, role: signupRole }, { onConflict: 'user_id,role' });
}
```

### 3. Manual fix for Casper Maassen
Run a one-time query to assign the player role to any existing users who have linked guest data but no role.

## Files changed

| File | Change |
|------|--------|
| DB migration | Update `link_guest_invoices_on_signup` to insert player role |
| `supabase/functions/signup-user/index.ts` | Assign role from `signupRole` param server-side |

