import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { corsHeaders, jsonForbidden, jsonUnauthorized, requireUser } from "../_shared/auth.ts";

const logStep = (step: string, details?: any) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[MOLLIE-CONNECT-ACADEMY] ${step}${detailsStr}`);
};

// Generate a random state string for CSRF protection
function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    logStep("Function started");

    const mollieClientId = Deno.env.get("MOLLIE_CLIENT_ID");
    if (!mollieClientId) throw new Error("MOLLIE_CLIENT_ID is not set");

    const authResult = await requireUser(req);
    if (authResult instanceof Response) return authResult;
    const { user, supabase: supabaseClient } = authResult;
    if (!user.email) {
      return jsonUnauthorized();
    }
    logStep("User authenticated", { userId: user.id, email: user.email });

    const { academyProfileId } = await req.json();
    if (!academyProfileId) throw new Error("Academy profile ID is required");
    logStep("Request payload", { academyProfileId });

    // Verify user is a manager of this academy
    const { data: academyManager } = await supabaseClient
      .from('academy_managers')
      .select('role')
      .eq('academy_profile_id', academyProfileId)
      .eq('user_id', user.id)
      .single();

    if (!academyManager) {
      return jsonForbidden("You are not a manager of this academy");
    }
    logStep("Academy manager verified", { role: academyManager.role });

    // Build Mollie OAuth authorization URL
    // Redirect directly to the edge function so the token exchange happens server-to-server
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const redirectUri = `${supabaseUrl}/functions/v1/mollie-callback`;
    const scopes = [
      'organizations.read',
      'organizations.write',
      'payments.read',
      'payments.write',
      'profiles.read',
      'onboarding.read',
      'onboarding.write',
    ].join(' ');

    const state = generateState();
    const composedState = `academy_${academyProfileId}_${state}`;

    const { error: stateInsertError } = await supabaseClient
      .from('mollie_oauth_states')
      .insert({
        state: composedState,
        entity_type: 'academy',
        entity_id: academyProfileId,
        user_id: user.id,
      });
    if (stateInsertError) {
      throw new Error(`Failed to persist OAuth state: ${stateInsertError.message}`);
    }

    const authUrl = new URL('https://my.mollie.com/oauth2/authorize');
    authUrl.searchParams.set('client_id', mollieClientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', composedState);
    authUrl.searchParams.set('scope', scopes);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('approval_prompt', 'auto');
    authUrl.searchParams.set('landing_page', 'signup'); // Show signup for new merchants

    logStep("OAuth URL created", { url: authUrl.toString() });

    return new Response(JSON.stringify({ url: authUrl.toString() }), {
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
