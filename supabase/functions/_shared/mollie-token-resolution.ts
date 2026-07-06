// Connected-account Mollie token resolution — extracted VERBATIM from mollie-webhook
// (P0 payments observability) so the nightly stuck-payment check resolves the SAME org
// token the webhook would: academy first (slot academy hint filters multi-academy
// trainers — Codex F3), hard-refuse academy slots without an academy token (P1-9,
// charge-org == confirm-org), trainer's own account only for trainer-owned slots.
// Only change vs the webhook original: logStep is injected (each caller keeps its own
// log prefix) and defaults to console.log.
// deno-lint-ignore-file no-explicit-any
/* eslint-disable @typescript-eslint/no-explicit-any -- verbatim extraction from
   mollie-webhook: the supabase client + account rows were untyped there; typing them
   here would diverge the moved code from what has been running in prod. */

type LogStep = (step: string, details?: Record<string, unknown>) => void;
const defaultLog: LogStep = (step, details) =>
  console.log(`[MOLLIE-TOKENS] ${step}`, details ? JSON.stringify(details) : "");

export async function refreshTokenIfNeeded(
  supabaseClient: any,
  accountData: any,
  entityType: 'trainer' | 'academy',
  entityId: string,
  logStep: LogStep = defaultLog,
): Promise<string | null> {
  const mollieClientId = Deno.env.get("MOLLIE_CLIENT_ID");
  const mollieClientSecret = Deno.env.get("MOLLIE_CLIENT_SECRET");

  if (!mollieClientId || !mollieClientSecret) {
    return accountData.access_token;
  }

  const tokenExpiresAt = new Date(accountData.token_expires_at);
  const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);

  if (tokenExpiresAt > fiveMinutesFromNow) {
    return accountData.access_token;
  }

  logStep("Token expired or expiring soon, refreshing");

  if (!accountData.refresh_token) {
    return accountData.access_token;
  }

  const tableName = entityType === 'trainer' ? 'trainer_mollie_accounts' : 'academy_mollie_accounts';
  const idColumn = entityType === 'trainer' ? 'trainer_id' : 'academy_profile_id';

  // Mollie refresh tokens are single-use (rotating). Claim the refresh so only
  // ONE concurrent webhook rotates the token; others skip and reuse the current
  // token (valid for the 5-min buffer, or the winner's freshly written one). The
  // 2-minute staleness window lets a crashed claim self-heal.
  const staleClaim = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const { data: claimRows } = await supabaseClient
    .from(tableName)
    .update({ token_refreshing_at: new Date().toISOString() })
    .eq(idColumn, entityId)
    .or(`token_refreshing_at.is.null,token_refreshing_at.lt.${staleClaim}`)
    .select('access_token');

  if (!claimRows || claimRows.length === 0) {
    const { data: fresh } = await supabaseClient
      .from(tableName)
      .select('access_token')
      .eq(idColumn, entityId)
      .maybeSingle();
    logStep("Token refresh already in progress — reusing current token");
    return fresh?.access_token ?? accountData.access_token;
  }

  try {
    const tokenResponse = await fetch('https://api.mollie.com/oauth2/tokens', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${btoa(`${mollieClientId}:${mollieClientSecret}`)}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: accountData.refresh_token,
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.json();
      logStep("Token refresh failed", errorData);
      // Release the claim so a later webhook can retry the refresh.
      await supabaseClient.from(tableName).update({ token_refreshing_at: null }).eq(idColumn, entityId);
      return accountData.access_token;
    }

    const tokens = await tokenResponse.json();
    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    await supabaseClient
      .from(tableName)
      .update({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: newExpiresAt,
        token_refreshing_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq(idColumn, entityId);

    logStep("Token refreshed successfully");
    return tokens.access_token;
  } catch (error) {
    logStep("Error refreshing token", { error: String(error) });
    await supabaseClient.from(tableName).update({ token_refreshing_at: null }).eq(idColumn, entityId);
    return accountData.access_token;
  }
}

export async function resolveAccessToken(
  supabase: any,
  trainerId: string,
  slotAcademyProfileId?: string | null,
  logStep: LogStep = defaultLog,
): Promise<string | null> {
  // First check if trainer is part of an active academy. When the slot names an academy,
  // filter by it so a trainer who belongs to 2+ academies routes to the RIGHT one (else the
  // .maybeSingle() collapses on the multiple active rows and mis-resolves). The charge side
  // (resolveSlotRecipient / create-mollie-payment) applies the IDENTICAL filter off the same
  // slot.academy_profile_id, so the org that CONFIRMS equals the org that CHARGED (Codex F3).
  // Null (or a single-academy trainer) → no-op, byte-for-byte unchanged.
  let academyTrainerQuery = supabase
    .from("academy_trainers")
    .select("academy_profile_id, status")
    .eq("trainer_profile_id", trainerId)
    .eq("status", "active");
  if (slotAcademyProfileId) {
    academyTrainerQuery = academyTrainerQuery.eq("academy_profile_id", slotAcademyProfileId);
  }
  const { data: academyTrainer } = await academyTrainerQuery.maybeSingle();

  if (academyTrainer?.academy_profile_id) {
    const { data: academyMollie } = await supabase
      .from("academy_mollie_accounts")
      .select("access_token, refresh_token, token_expires_at, charges_enabled")
      .eq("academy_profile_id", academyTrainer.academy_profile_id)
      .eq("onboarding_complete", true)
      .single();

    if (academyMollie?.access_token && academyMollie?.charges_enabled) {
      const token = await refreshTokenIfNeeded(supabase, academyMollie, 'academy', academyTrainer.academy_profile_id, logStep);
      if (token) {
        logStep("Using academy access token", { academyId: academyTrainer.academy_profile_id });
        return token;
      }
    }
  }

  // OWNER INTENT (P1-9): for an academy slot (slotAcademyProfileId set) the recipient is
  // ALWAYS the academy - mirror the charge side (resolveSlotRecipient), which refuses
  // rather than falling back to the trainer. If the academy branch above did not resolve
  // a token, return null so the webhook's no-connected-account-token refusal fires
  // (Slack alert + 200, no retry) instead of silently confirming the hold against the
  // trainer's personal Mollie. Only a trainer-owned slot/invoice (no academy hint) may
  // use the trainer account. This keeps charge-org == confirm-org.
  if (slotAcademyProfileId) {
    return null;
  }

  // Check trainer's own Mollie account
  const { data: trainerMollie } = await supabase
    .from("trainer_mollie_accounts")
    .select("access_token, refresh_token, token_expires_at")
    .eq("trainer_id", trainerId)
    .eq("onboarding_complete", true)
    .single();

  if (trainerMollie?.access_token) {
    const token = await refreshTokenIfNeeded(supabase, trainerMollie, 'trainer', trainerId, logStep);
    if (token) {
      logStep("Using trainer access token", { trainerId });
      return token;
    }
  }

  return null;
}
