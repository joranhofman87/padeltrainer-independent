import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user?.email) throw new Error("User not authenticated or email not available");
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
      throw new Error("You are not a manager of this academy");
    }
    logStep("Academy manager verified", { role: academyManager.role });

    const origin = req.headers.get("origin") || "https://app.padeltrainer.ai";

    // Check if academy already has a Mollie account with valid tokens
    const { data: existingAccount } = await supabaseClient
      .from('academy_mollie_accounts')
      .select('mollie_organization_id, onboarding_complete, access_token, token_expires_at')
      .eq('academy_profile_id', academyProfileId)
      .maybeSingle();

    if (existingAccount?.mollie_organization_id && existingAccount?.onboarding_complete) {
      logStep("Academy already connected to Mollie", { 
        organizationId: existingAccount.mollie_organization_id 
      });
      return new Response(JSON.stringify({ 
        alreadyConnected: true,
        message: "Already connected to Mollie"
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    // Generate state for CSRF protection
    const state = generateState();
    
    // Store state in database for verification on callback
    const { error: stateError } = await supabaseClient
      .from('academy_mollie_accounts')
      .upsert({
        academy_profile_id: academyProfileId,
        mollie_organization_id: `pending_${state}`, // Temporary placeholder
        onboarding_complete: false,
        charges_enabled: false,
        payouts_enabled: false,
      }, {
        onConflict: 'academy_profile_id'
      });

    if (stateError) {
      logStep("Error storing OAuth state", { error: stateError });
    }

    // Build Mollie OAuth authorization URL
    const redirectUri = `${origin}/api/mollie-callback`;
    const scopes = [
      'organizations.read',
      'organizations.write',
      'payments.read',
      'payments.write',
      'profiles.read',
      'onboarding.read',
      'onboarding.write',
    ].join(' ');

    const authUrl = new URL('https://my.mollie.com/oauth2/authorize');
    authUrl.searchParams.set('client_id', mollieClientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', `academy_${academyProfileId}_${state}`);
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
