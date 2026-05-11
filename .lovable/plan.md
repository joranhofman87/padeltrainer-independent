# Move preserved user IDs out of source

## Problem

`supabase/functions/bulk-cleanup-users/index.ts` hardcodes the founder's auth UUID and email in a comment:

```ts
const PRESERVED_USER_IDS = [
  "256b0ed5-1563-4eb5-899b-df559c5e9090", // info@padeltrainer.ai
  "9bcc1c6f-7978-49bb-aa06-6f1be4135fc7", // joranhofman87@gmail.com
];
```

If the repo is ever made public (or leaks), that's a direct identifier + email for a privileged account.

## Fix

Resolve the preserved set at runtime from the existing `user_roles` table — every admin is preserved. No new secret, no new config table, nothing to keep in sync.

In `supabase/functions/bulk-cleanup-users/index.ts`:

1. Delete the `PRESERVED_USER_IDS` constant.
2. Before the cleanup query, fetch admin user IDs:
   ```ts
   const { data: adminRows, error: adminFetchError } = await supabaseAdmin
     .from("user_roles")
     .select("user_id")
     .eq("role", "admin");
   if (adminFetchError) {
     return new Response(
       JSON.stringify({ error: "Failed to load preserved admins" }),
       { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
     );
   }
   const preservedUserIds = Array.from(new Set(adminRows?.map(r => r.user_id) ?? []));
   if (preservedUserIds.length === 0) {
     return new Response(
       JSON.stringify({ error: "Refusing to run: no admin users to preserve" }),
       { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
     );
   }
   ```
3. Replace the existing `not("user_id", "in", `(${PRESERVED_USER_IDS.join(",")})`)` with the same pattern using `preservedUserIds`.

The empty-list guard is important: if `user_roles` ever returned zero admins, the existing pattern would silently delete everyone. Refusing is safer than wiping.

## Verification

- Static check: `rg "256b0ed5|9bcc1c6f|joranhofman87|PRESERVED_USER_IDS" supabase/` returns nothing.
- Functional: as admin, call `bulk-cleanup-users` with `{ confirm: true }` against a non-prod project (or trust the static read of the new query). The preserved set should equal current admins.

## Out of scope

- Rotating the leaked UUID (UUIDs aren't secret; the email is the sensitive bit and is now removed). Git history still contains both — flagging for the user but not rewriting history here.
- Auditing every other edge function for hardcoded UUIDs/emails (`rg` shows this is the only one with named-user constants, but a wider sweep is a separate task if you want it).
