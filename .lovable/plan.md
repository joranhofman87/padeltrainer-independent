## Remove `bootstrap-admin-password` backdoor edge function

The function lets anyone with `BOOTSTRAP_SECRET` reset any non-admin user's password. There are zero references to it anywhere in the codebase, and admin password resets already have a proper gated path (`admin-reset-password`). Best fix: delete it outright.

### Changes
1. Delete folder `supabase/functions/bootstrap-admin-password/`.
2. Call `supabase--delete_edge_functions` with `["bootstrap-admin-password"]` to remove the deployed function from the backend.
3. After deletion, you can also remove the `BOOTSTRAP_ENABLED` and `BOOTSTRAP_SECRET` runtime secrets from Cloud settings (manual step — not managed by tools, but I'll remind you in the final message).

### Out of scope
- Auditing other edge functions (already covered in earlier rounds).
- Any code changes elsewhere — nothing in the app calls this function.