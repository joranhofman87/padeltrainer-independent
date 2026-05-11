## Goal

Address audit point #2: ensure `.env` is never committed so a future dev dropping a real secret into it can't leak it.

## Current state

`.env` contains only public values (Supabase project ref, URL, and anon/publishable key). They are safe to expose, but the file is not gitignored, so any future addition (e.g. a service role key, Stripe secret, etc.) would be silently committed.

```
SUPABASE_PUBLISHABLE_KEY="..."   # anon key, public
SUPABASE_URL="..."               # public
VITE_SUPABASE_PROJECT_ID="..."   # public
VITE_SUPABASE_PUBLISHABLE_KEY="..." # anon key, public
VITE_SUPABASE_URL="..."          # public
```

## Changes

1. **`.gitignore`** — add an `.env` block:
   ```
   # Environment files - never commit (may contain secrets)
   .env
   .env.local
   .env.*.local
   ```
   Keep `.env.example` allowed (none exists today; not creating one).

2. **Leave `.env` content alone.** Lovable Cloud auto-generates and overwrites `.env` on every sandbox start with both the `VITE_`-prefixed and unprefixed Supabase variables. Renaming or deleting entries would be reverted on the next regeneration and could break edge-function-adjacent code paths that read the unprefixed names. The audit's "rename to VITE_ only" suggestion does not apply cleanly here because the file is platform-managed, not hand-authored.

3. **No code changes.** A repo search confirms no source file reads the unprefixed `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` from the client bundle (only `VITE_*` and `import.meta.env.VITE_*` are referenced). Edge functions read their own `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` from the Supabase runtime, not from this `.env`.

## Out of scope

- Rotating the anon key (not needed; it's public by design and protected by RLS).
- Editing `src/integrations/supabase/client.ts` or `.env` (both are platform-managed).
- A separate audit pass on RLS coverage (the auditor flagged this as a follow-up; happy to tackle it next if you want).

## Note on git history

Gitignoring `.env` now stops future leaks but does not remove the currently-tracked file from git history. Since the values in it today are all public (anon key + project ref + URL), no rotation is required. If a real secret is ever committed by accident in the future, it must be rotated immediately — gitignore is prevention, not cleanup.
