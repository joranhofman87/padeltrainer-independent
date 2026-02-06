import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const logStep = (step: string, details?: any) => {
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

    // Handle OAuth error from Mollie
    if (oauthError) {
      logStep("OAuth error received", { error: oauthError, description: errorDescription });
      return redirectToFrontend('error', { message: errorDescription || oauthError });
    }

    if (!code || !state) {
      logStep("Missing parameters", { hasCode: !!code, hasState: !!state });
      return redirectToFrontend('error', { message: 'Missing authorization code or state' });
    }

    logStep("Callback received", { state: state.substring(0, 30) + '...' });

    const mollieClientId = Deno.env.get("MOLLIE_CLIENT_ID");
    const mollieClientSecret = Deno.env.get("MOLLIE_CLIENT_SECRET");
    if (!mollieClientId || !mollieClientSecret) {
      return redirectToFrontend('error', { message: 'Mollie OAuth credentials not configured' });
    }

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Parse state to determine entity type and ID
    // Format: "trainer_{trainerId}_{randomState}" or "academy_{academyId}_{randomState}"
    const stateParts = state.split('_');
    if (stateParts.length < 3) {
      return redirectToFrontend('error', { message: 'Invalid state format' });
    }

    const entityType = stateParts[0]; // 'trainer' or 'academy'
    const entityId = stateParts[1];
    logStep("Parsed state", { entityType, entityId });

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
      const errorData = await tokenResponse.json();
      logStep("Token exchange failed", errorData);
      return redirectToFrontend('error', { 
        message: errorData.error_description || 'Failed to exchange authorization code' 
      });
    }

    const tokens: MollieTokenResponse = await tokenResponse.json();
    logStep("Tokens received", { expiresIn: tokens.expires_in, scope: tokens.scope });

    // Get the organization ID from Mollie
    const orgResponse = await fetch('https://api.mollie.com/v2/organizations/me', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` },
    });

    if (!orgResponse.ok) {
      const errorData = await orgResponse.json();
      logStep("Failed to get organization", errorData);
      return redirectToFrontend('error', { message: 'Failed to retrieve Mollie organization' });
    }

    const organization: MollieOrganization = await orgResponse.json();
    logStep("Organization retrieved", { organizationId: organization.id, name: organization.name });

    // Calculate token expiration time
    const tokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    // Update the appropriate table based on entity type
    if (entityType === 'trainer') {
      const { error: updateError } = await supabaseClient
        .from('trainer_mollie_accounts')
        .update({
          mollie_organization_id: organization.id,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_expires_at: tokenExpiresAt,
          onboarding_complete: true,
          charges_enabled: true,
          payouts_enabled: true,
          updated_at: new Date().toISOString(),
        })
        .eq('trainer_id', entityId);

      if (updateError) {
        logStep("Error updating trainer account", { error: updateError });
        return redirectToFrontend('error', { message: 'Failed to save Mollie connection' });
      }
      logStep("Trainer account updated successfully");
    } else if (entityType === 'academy') {
      const { error: updateError } = await supabaseClient
        .from('academy_mollie_accounts')
        .update({
          mollie_organization_id: organization.id,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_expires_at: tokenExpiresAt,
          onboarding_complete: true,
          charges_enabled: true,
          payouts_enabled: true,
          updated_at: new Date().toISOString(),
        })
        .eq('academy_profile_id', entityId);

      if (updateError) {
        logStep("Error updating academy account", { error: updateError });
        return redirectToFrontend('error', { message: 'Failed to save Mollie connection' });
      }
      logStep("Academy account updated successfully");
    } else {
      return redirectToFrontend('error', { message: 'Invalid entity type' });
    }

    return redirectToFrontend('success', {
      name: organization.name,
      entity: entityType,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    return redirectToFrontend('error', { message: errorMessage });
  }
});
