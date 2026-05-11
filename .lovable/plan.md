# Allowlist signupRole in signup-user edge function

## Problem

`supabase/functions/signup-user/index.ts:213-217` upserts `signupRole` straight from the request body into `public.user_roles` using the service role:

```ts
if (signupRole) {
  await supabaseAdmin
    .from('user_roles')
    .upsert({ user_id: user.id, role: signupRole }, { onConflict: 'user_id,role' });
}
```

The `app_role` enum includes `admin`, so `POST /signup-user { role: "admin", ... }` would self-grant admin on signup. Direct privilege escalation.

## Fix

In `supabase/functions/signup-user/index.ts`:

1. Define an allowlist constant:
   ```ts
   const ALLOWED_SIGNUP_ROLES = ['player', 'trainer', 'club', 'academy'] as const;
   type SignupRole = typeof ALLOWED_SIGNUP_ROLES[number];
   ```
2. Right after destructuring the body (line 159), validate:
   ```ts
   if (signupRole !== undefined && !ALLOWED_SIGNUP_ROLES.includes(signupRole as SignupRole)) {
     return new Response(
       JSON.stringify({ error: "Invalid role" }),
       { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
     );
   }
   ```
3. Keep the existing `if (signupRole) { upsert(...) }` block — it's now safe because invalid values were rejected above.

## Verification

- `curl` the deployed function with `role: "admin"` → expect `400 { error: "Invalid role" }` and no row inserted in `user_roles`.
- `curl` with `role: "player"` → expect success and a `user_roles` row with `role='player'`.
- `psql` confirms no `admin` row was created for the test user.

## Out of scope

- Auditing other edge functions that touch `user_roles` (separate finding if any exist).
- Removing the client-supplied `role` entirely in favor of role inference from the signup page route — bigger refactor; allowlist is the minimal correct fix.
