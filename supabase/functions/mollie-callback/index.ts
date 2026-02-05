import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: any) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[MOLLIE-CALLBACK] ${step}${detailsStr}`);
};

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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    logStep("Function started");

    const mollieClientId = Deno.env.get("MOLLIE_CLIENT_ID");
    const mollieClientSecret = Deno.env.get("MOLLIE_CLIENT_SECRET");
    if (!mollieClientId || !mollieClientSecret) {
      throw new Error("Mollie OAuth credentials not configured");
    }

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Parse the callback parameters
    const { code, state, error: oauthError, error_description } = await req.json();
    
    if (oauthError) {
      logStep("OAuth error received", { error: oauthError, description: error_description });
      throw new Error(error_description || oauthError);
    }

    if (!code || !state) {
      throw new Error("Missing authorization code or state");
    }

    logStep("Callback received", { state: state.substring(0, 20) + '...' });

    // Parse state to determine entity type and ID
    // Format: "trainer_{trainerId}_{randomState}" or "academy_{academyId}_{randomState}"
    const stateParts = state.split('_');
    if (stateParts.length < 3) {
      throw new Error("Invalid state format");
    }

    const entityType = stateParts[0]; // 'trainer' or 'academy'
    const entityId = stateParts[1];
    logStep("Parsed state", { entityType, entityId });

    // Use fixed production redirect URI - Mollie requires exact match with registered callback
    const redirectUri = 'https://app.padeltrainer.ai/api/mollie-callback';

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
      throw new Error(errorData.error_description || 'Failed to exchange authorization code');
    }

    const tokens: MollieTokenResponse = await tokenResponse.json();
    logStep("Tokens received", { 
      expiresIn: tokens.expires_in, 
      scope: tokens.scope 
    });

    // Get the organization ID from Mollie
    const orgResponse = await fetch('https://api.mollie.com/v2/organizations/me', {
      headers: {
        'Authorization': `Bearer ${tokens.access_token}`,
      },
    });

    if (!orgResponse.ok) {
      const errorData = await orgResponse.json();
      logStep("Failed to get organization", errorData);
      throw new Error('Failed to retrieve Mollie organization');
    }

    const organization: MollieOrganization = await orgResponse.json();
    logStep("Organization retrieved", { 
      organizationId: organization.id, 
      name: organization.name 
    });

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
          charges_enabled: true, // Assume enabled after successful OAuth
          payouts_enabled: true,
          updated_at: new Date().toISOString(),
        })
        .eq('trainer_id', entityId);

      if (updateError) {
        logStep("Error updating trainer account", { error: updateError });
        throw new Error('Failed to save Mollie connection');
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
        throw new Error('Failed to save Mollie connection');
      }
      logStep("Academy account updated successfully");
    } else {
      throw new Error("Invalid entity type in state");
    }

    return new Response(JSON.stringify({ 
      success: true,
      organizationId: organization.id,
      organizationName: organization.name,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
