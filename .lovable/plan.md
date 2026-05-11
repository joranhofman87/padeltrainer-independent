# Mollie OAuth state validation

## Problem (confirmed)

`mollie-connect-trainer` and `mollie-connect-academy` generate a random `state` but never persist it. `mollie-callback` only splits the state on `_` and trusts the `entityType` + `entityId` from the URL. An attacker can complete OAuth on their own Mollie account, then replay the `code` with a hand-crafted `state=trainer_<victimId>_<anything>` — the victim's `trainer_mollie_accounts` row gets overwritten with the attacker's `access_token` + `mollie_organization_id`, and all future payouts go to the attacker.

## Fix

### 1. Migration — `mollie_oauth_states` table

```sql
CREATE TABLE public.mollie_oauth_states (
  state TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('trainer','academy')),
  entity_id UUID NOT NULL,
  user_id UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '15 minutes'),
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.mollie_oauth_states ENABLE ROW LEVEL SECURITY;
-- No policies: only the service role (edge functions) reads/writes this table.

CREATE INDEX idx_mollie_oauth_states_expires_at
  ON public.mollie_oauth_states (expires_at);
```

No RLS policies are needed — only the three edge functions (running with the service role) touch this table.

### 2. `mollie-connect-trainer` / `mollie-connect-academy`

Before redirecting to Mollie, insert a row:

```ts
const randomState = generateState(); // existing 32-byte hex
const composedState = `trainer_${trainerProfile.id}_${randomState}`;
// or: `academy_${academyProfileId}_${randomState}`

await supabaseClient.from('mollie_oauth_states').insert({
  state: composedState,
  entity_type: 'trainer',          // or 'academy'
  entity_id: trainerProfile.id,    // or academyProfileId
  user_id: user.id,
});
```

Use `composedState` in the Mollie URL (same shape as today, so we don't break in-flight flows during deploy).

### 3. `mollie-callback`

After parsing `entityType` / `entityId` from the state, validate:

```ts
const { data: stored, error: stateError } = await supabaseClient
  .from('mollie_oauth_states')
  .select('entity_type, entity_id, expires_at, used_at')
  .eq('state', state)
  .maybeSingle();

if (stateError || !stored) {
  return redirectToFrontend('error', { message: 'Invalid OAuth state' });
}
if (stored.used_at) {
  return redirectToFrontend('error', { message: 'OAuth state already used' });
}
if (new Date(stored.expires_at) < new Date()) {
  return redirectToFrontend('error', { message: 'OAuth state expired' });
}
if (stored.entity_type !== entityType || stored.entity_id !== entityId) {
  return redirectToFrontend('error', { message: 'OAuth state mismatch' });
}

// Mark used immediately to prevent replay even if the rest fails.
await supabaseClient
  .from('mollie_oauth_states')
  .update({ used_at: new Date().toISOString() })
  .eq('state', state)
  .is('used_at', null);
```

Only proceed to the token exchange after all four checks pass.

### 4. Verification

- Happy path: real connect flow from the trainer settings page completes and writes tokens to the right row.
- Tampering: `curl` the callback with `?code=anything&state=trainer_<random-uuid>_deadbeef` → expect redirect to `/app/api/mollie-callback?status=error&message=Invalid%20OAuth%20state`. No DB writes.
- Replay: re-hit a real callback URL twice → second attempt redirects with `OAuth state already used`.

## Out of scope

- Cleanup cron for expired rows (table will accumulate ~10s of rows per active month; cheap).
- Refactoring the `entityType_entityId_random` string format into separate columns / a single opaque token. Could swap to opaque later; current shape stays for backward compatibility.
- Auditing `mollie-webhook` / `verify-mollie-payment` for related issues — separate scope, flag if you want a follow-up turn.
