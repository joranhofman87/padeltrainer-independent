import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { fetchMollieReadiness } from "../_shared/mollie-onboarding.ts";

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[MOLLIE-CALLBACK] ${step}${detailsStr}`);
};

const FRONTEND_BASE_URL = 'https://padeltrainer.ai';

interface MollieTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

interface MollieOrganization {
  id: string;
  name: string;
  email: string;
}

function redirectToFrontend(status: 'success' | 'error', params: Record<string, string> = {}) {
  const url = new URL(`${FRONTEND_BASE_URL}/app/api/mollie-callback`);
  url.searchParams.set('status', status);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  logStep("Redirecting to frontend", { url: url.toString() });
  return new Response(null, {
    status: 302,
    headers: { 'Location': url.toString() },
  });
}

serve(async (req) => {
  try {
    logStep("Function started", { method: req.method, url: req.url });

    // Parse query parameters from Mollie's GET redirect
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const oauthError = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');

    // Handle OAuth error from Mollie. Only stable short codes go into the browser
    // redirect (visible in history/referrer); full detail stays in server logs.
    if (oauthError) {
      logStep("OAuth error received", { error: oauthError, description: errorDescription });
      return redirectToFrontend('error', {
        reason: oauthError === 'access_denied' ? 'access_denied' : 'oauth_error',
      });
    }

    if (!code || !state) {
      logStep("Missing parameters", { hasCode: !!code, hasState: !!state });
      return redirectToFrontend('error', { reason: 'missing_params' });
    }

    logStep("Callback received", { state: state.substring(0, 30) + '...' });

    const mollieClientId = Deno.env.get("MOLLIE_CLIENT_ID");
    const mollieClientSecret = Deno.env.get("MOLLIE_CLIENT_SECRET");
    if (!mollieClientId || !mollieClientSecret) {
      logStep("Mollie OAuth credentials not configured");
      return redirectToFrontend('error', { reason: 'not_configured' });
    }

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Parse state to determine entity type and ID
    // Format: "trainer_{trainerId}_{randomState}" or "academy_{academyId}_{randomState}"
    const stateParts = state.split('_');
    if (stateParts.length < 3) {
      logStep("Invalid state format");
      return redirectToFrontend('error', { reason: 'invalid_state' });
    }

    const entityType = stateParts[0]; // 'trainer' or 'academy'
    const entityId = stateParts[1];
    logStep("Parsed state", { entityType, entityId });

    // Validate state against the row stored when the OAuth flow was initiated.
    const { data: storedState, error: stateLookupError } = await supabaseClient
      .from('mollie_oauth_states')
      .select('entity_type, entity_id, expires_at, used_at')
      .eq('state', state)
      .maybeSingle();

    if (stateLookupError) {
      logStep("State lookup failed", { error: stateLookupError });
      return redirectToFrontend('error', { reason: 'state_validation_failed' });
    }
    if (!storedState) {
      logStep("State not found in store");
      return redirectToFrontend('error', { reason: 'invalid_state' });
    }
    if (storedState.used_at) {
      logStep("State already used", { used_at: storedState.used_at });
      return redirectToFrontend('error', { reason: 'state_already_used' });
    }
    if (new Date(storedState.expires_at) < new Date()) {
      logStep("State expired", { expires_at: storedState.expires_at });
      return redirectToFrontend('error', { reason: 'state_expired' });
    }
    if (storedState.entity_type !== entityType || storedState.entity_id !== entityId) {
      logStep("State entity mismatch", {
        claimed: { entityType, entityId },
        stored: { entity_type: storedState.entity_type, entity_id: storedState.entity_id },
      });
      return redirectToFrontend('error', { reason: 'state_mismatch' });
    }

    // Atomically mark used to prevent replay/race.
    const { data: consumed, error: consumeError } = await supabaseClient
      .from('mollie_oauth_states')
      .update({ used_at: new Date().toISOString() })
      .eq('state', state)
      .is('used_at', null)
      .select('state')
      .maybeSingle();

    if (consumeError || !consumed) {
      logStep("Failed to consume state (likely race)", { error: consumeError });
      return redirectToFrontend('error', { reason: 'state_already_used' });
    }

    // The redirect URI must match exactly what was used when creating the authorization URL
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const redirectUri = `${supabaseUrl}/functions/v1/mollie-callback`;

    // Exchange authorization code for access token
    const tokenResponse = await fetch('https://api.mollie.com/oauth2/tokens', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${btoa(`${mollieClientId}:${mollieClientSecret}`)}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      // Never log the full token-endpoint payload; only status + standard error fields.
      const errorData = await tokenResponse.json().catch(() => null);
      logStep("Token exchange failed", {
        status: tokenResponse.status,
        error: errorData?.error,
        description: errorData?.error_description,
      });
      return redirectToFrontend('error', { reason: 'token_exchange_failed' });
    }

    const tokens: MollieTokenResponse = await tokenResponse.json();
    logStep("Tokens received", { expiresIn: tokens.expires_in, scope: tokens.scope });

    // Get the organization ID from Mollie
    const orgResponse = await fetch('https://api.mollie.com/v2/organizations/me', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` },
    });

    if (!orgResponse.ok) {
      const errorData = await orgResponse.json().catch(() => null);
      logStep("Failed to get organization", {
        status: orgResponse.status,
        title: errorData?.title,
        detail: errorData?.detail,
      });
      return redirectToFrontend('error', { reason: 'organization_fetch_failed' });
    }

    const organization: MollieOrganization = await orgResponse.json();
    logStep("Organization retrieved", { organizationId: organization.id, name: organization.name });

    // Calculate token expiration time
    const tokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    // Resolve REAL readiness from Mollie's onboarding/KYC state — do NOT hardcode true. An
    // account that connected but hasn't finished KYC is not yet chargeable; showing it "ready"
    // sends guests into a 422 dead-end. On fetch failure, default to NOT ready (conservative);
    // check-mollie-connect-status reconciles once KYC completes.
    const readiness = (await fetchMollieReadiness(tokens.access_token)) ??
      { onboardingComplete: false, chargesEnabled: false, payoutsEnabled: false };
    logStep("Onboarding readiness resolved", readiness);

    // Update the appropriate table based on entity type
    if (entityType === 'trainer') {
      const { error: updateError } = await supabaseClient
        .from('trainer_mollie_accounts')
        .update({
          mollie_organization_id: organization.id,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_expires_at: tokenExpiresAt,
          onboarding_complete: readiness.onboardingComplete,
          charges_enabled: readiness.chargesEnabled,
          payouts_enabled: readiness.payoutsEnabled,
          updated_at: new Date().toISOString(),
        })
        .eq('trainer_id', entityId);

      if (updateError) {
        logStep("Error updating trainer account", { error: updateError });
        return redirectToFrontend('error', { reason: 'save_failed' });
      }
      logStep("Trainer account updated successfully");
    } else if (entityType === 'academy') {
      const { error: upsertError } = await supabaseClient
        .from('academy_mollie_accounts')
        .upsert({
          academy_profile_id: entityId,
          mollie_organization_id: organization.id,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_expires_at: tokenExpiresAt,
          onboarding_complete: readiness.onboardingComplete,
          charges_enabled: readiness.chargesEnabled,
          payouts_enabled: readiness.payoutsEnabled,
          disconnected_at: null, // F06: reconnecting clears the soft-disconnect stamp
          updated_at: new Date().toISOString(),
        }, { onConflict: 'academy_profile_id' });

      if (upsertError) {
        logStep("Error saving academy account", { error: upsertError });
        return redirectToFrontend('error', { reason: 'save_failed' });
      }
      logStep("Academy account saved successfully");
    } else {
      logStep("Invalid entity type", { entityType });
      return redirectToFrontend('error', { reason: 'invalid_entity' });
    }

    return redirectToFrontend('success', {
      name: organization.name,
      entity: entityType,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    // Full detail stays in logs; the browser only sees a stable code.
    return redirectToFrontend('error', { reason: 'unexpected_error' });
  }
});
