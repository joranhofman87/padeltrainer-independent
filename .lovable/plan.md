

# Fix: Registration Form Error on Academy Cycles

## Root Cause Analysis

There are **two bugs** causing errors when submitting a registration for an academy cycle:

### Bug 1: `autoFollowOwner` crashes on academy owner type

In `submitIntakeRequest` (line 608-609 of `cycles.ts`), after inserting the intake request:

```typescript
await autoFollowOwner(cycle.owner_type as 'trainer' | 'club', cycle.owner_id, input.player_id);
await addToStudentList(cycle.owner_type as 'trainer' | 'club', cycle.owner_id, input);
```

When `owner_type` is `'academy'`, `autoFollowOwner` falls into the `else` branch and tries to insert into `club_followers` with the academy ID as `club_profile_id`. This causes a **foreign key violation** because the academy ID doesn't exist in `club_profiles`. Same issue with `addToStudentList` — it tries to upsert into `club_players` with an academy ID.

These functions are called _after_ the intake request is inserted, but the error likely propagates and shows an error toast to the user even though the intake was technically created.

### Bug 2 (Guest flow): Missing `user_roles` INSERT policy

When a guest signs up via the form, the code tries:
```typescript
await supabase.from('user_roles').insert({ user_id: currentPlayerUserId, role: 'player' });
```
There is **no INSERT policy** on `user_roles`. This silently fails (RLS blocks it). The player role never gets assigned.

Additionally, if email confirmation is required (the default), `signUp()` returns a user but **no active session**, meaning all subsequent Supabase calls (profile lookup, intake insert) fail because `auth.uid()` is null.

---

## Fix Plan

### 1. Fix `autoFollowOwner` and `addToStudentList` to handle academy type

**File:** `src/lib/cycles.ts`

Update `autoFollowOwner` to handle `'academy'` owner type — use `academy_followers` table (or skip if no such table exists). Update `addToStudentList` similarly — use `academy_players` or skip for academy. Also update the type signature to accept `'academy'`.

If the `academy_followers` / `academy_players` tables don't exist, simply skip the auto-follow and student list steps for academy cycles (they're already wrapped in try/catch as non-blocking).

### 2. Fix guest signup flow to use edge function

**File:** `src/components/cycles/CycleApplicationForm.tsx`

Instead of calling `supabase.auth.signUp()` client-side (which fails without a session for subsequent calls), use the existing `create-manual-player` edge function pattern. This edge function:
- Creates the user with `email_confirm: true` via admin API
- Creates the profile
- Assigns the player role
- All using the service role key (bypasses RLS)

Alternatively, if we want to keep client-side signup, submit the intake request via an edge function that accepts unauthenticated requests and handles everything server-side.

The simplest fix: make the guest flow call `create-manual-player` edge function (which already exists and does exactly what we need), then use the returned `profileId` for the intake submission via another edge function call.

However, the cleanest approach is:
- Keep `supabase.auth.signUp()` client-side (it works for creating the account)
- Move the intake submission for guests to an edge function that uses the service role key
- Or: add an RLS policy allowing insert into `intake_requests` for the `anon` role with a specific check

**Recommended approach:** Update the guest flow to:
1. Call `supabase.auth.signUp()` — this creates the user + triggers profile creation
2. Call a new edge function `submit-guest-intake` that uses the service role key to: insert the player role, look up the profile, and insert the intake request
3. This avoids all RLS issues for guest users

### 3. Add missing academy manager policies for intake_requests

**Migration:** Add RLS policies so academy managers can view/manage intake requests for their academy cycles. Currently only trainer and club manager policies exist.

---

## Files to Modify

| File | Change |
|------|--------|
| `src/lib/cycles.ts` | Fix `autoFollowOwner` and `addToStudentList` to handle `'academy'` owner type (skip or use correct tables) |
| `src/components/cycles/CycleApplicationForm.tsx` | Fix guest signup flow to handle no-session state |
| `supabase/functions/submit-guest-intake/index.ts` | New edge function for guest intake submissions |
| Migration | Add academy manager RLS policies for `intake_requests` |

