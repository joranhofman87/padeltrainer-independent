

# Assign player role to Casper Maassen

## What
Run a single migration to insert the `player` role for Casper Maassen (user_id: `646016cc-ab00-4053-a717-2b80ed99e602`) into `user_roles`.

```sql
INSERT INTO public.user_roles (user_id, role)
VALUES ('646016cc-ab00-4053-a717-2b80ed99e602', 'player')
ON CONFLICT (user_id, role) DO NOTHING;
```

One migration, no code changes.

