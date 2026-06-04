import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import {
  buildAcademyMollieConnectStatus,
  buildTrainerMollieConnectStatus,
  MOLLIE_CONNECT_STATUS_DISCONNECTED,
} from "../_shared/mollie-payment-ready.ts";
import { corsHeaders, jsonForbidden, requireUser } from "../_shared/auth.ts";

const logStep = (step: string, details?: any) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[CHECK-MOLLIE-STATUS] ${step}${detailsStr}`);
};

interface MollieBalance {
  available: { value: string; currency: string };
  pending: { value: string; currency: string };
}

// Refresh access token if expired
async function refreshTokenIfNeeded(
  supabaseClient: any,
  accountData: any,
  entityType: 'trainer' | 'academy',
  entityId: string
): Promise<string | null> {
  const mollieClientId = Deno.env.get("MOLLIE_CLIENT_ID");
  const mollieClientSecret = Deno.env.get("MOLLIE_CLIENT_SECRET");
  
  if (!mollieClientId || !mollieClientSecret) {
    logStep("Mollie credentials not configured");
    return null;
  }

  // Check if token is expired or about to expire (within 5 minutes)
  const tokenExpiresAt = new Date(accountData.token_expires_at);
  const now = new Date();
  const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

  if (tokenExpiresAt > fiveMinutesFromNow) {
    return accountData.access_token; // Token still valid
  }

  logStep("Token expired or expiring soon, refreshing", { expiresAt: tokenExpiresAt });

  if (!accountData.refresh_token) {
    logStep("No refresh token available");
    return null;
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
      return null;
    }

    const tokens = await tokenResponse.json();
    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    // Update tokens in database
    const tableName = entityType === 'trainer' ? 'trainer_mollie_accounts' : 'academy_mollie_accounts';
    const idColumn = entityType === 'trainer' ? 'trainer_id' : 'academy_profile_id';

    await supabaseClient
      .from(tableName)
      .update({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: newExpiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq(idColumn, entityId);

    logStep("Token refreshed successfully");
    return tokens.access_token;
  } catch (error) {
    logStep("Error refreshing token", { error });
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    logStep("Function started");

    const authResult = await requireUser(req);
    if (authResult instanceof Response) return authResult;
    const { user, supabase: supabaseClient } = authResult;
    logStep("User authenticated", { userId: user.id });

    const { entityType, entityId } = await req.json();
    
    if (!entityType || !entityId) {
      throw new Error("Entity type and ID are required");
    }

    let accountData: any = null;

    if (entityType === 'trainer') {
      // Verify user owns this trainer profile
      const { data: trainerProfile } = await supabaseClient
        .from('trainer_profiles')
        .select('id')
        .eq('id', entityId)
        .eq('user_id', user.id)
        .single();

      if (!trainerProfile) {
        return jsonForbidden("Trainer profile not found or access denied");
      }

      const { data } = await supabaseClient
        .from('trainer_mollie_accounts')
        .select('*')
        .eq('trainer_id', entityId)
        .maybeSingle();
      
      accountData = data;
    } else if (entityType === 'academy') {
      // Verify user is a manager of this academy
      const { data: academyManager } = await supabaseClient
        .from('academy_managers')
        .select('role')
        .eq('academy_profile_id', entityId)
        .eq('user_id', user.id)
        .single();

      if (!academyManager) {
        return jsonForbidden("You are not a manager of this academy");
      }

      const { data } = await supabaseClient
        .from('academy_mollie_accounts')
        .select('*')
        .eq('academy_profile_id', entityId)
        .maybeSingle();
      
      accountData = data;
    } else {
      throw new Error("Invalid entity type");
    }

    const statusFields = entityType === "academy"
      ? buildAcademyMollieConnectStatus(accountData)
      : buildTrainerMollieConnectStatus(accountData);

    if (!statusFields.connected) {
      logStep("No Mollie account found");
      return new Response(JSON.stringify({
        ...MOLLIE_CONNECT_STATUS_DISCONNECTED,
        balance: null,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    // Try to refresh token if needed and get balance
    let balance: MollieBalance | null = null;
    const accessToken = await refreshTokenIfNeeded(
      supabaseClient,
      accountData,
      entityType,
      entityId,
    );

    if (accessToken && statusFields.chargesEnabled) {
      try {
        // Get balance from Mollie API
        const balanceResponse = await fetch('https://api.mollie.com/v2/balances', {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
          },
        });

        if (balanceResponse.ok) {
          const balanceData = await balanceResponse.json();
          if (balanceData._embedded?.balances?.[0]) {
            const primaryBalance = balanceData._embedded.balances[0];
            balance = {
              available: primaryBalance.availableAmount,
              pending: primaryBalance.pendingAmount,
            };
          }
        }
        logStep("Balance retrieved", { balance });
      } catch (balanceError) {
        logStep("Could not retrieve balance", { error: balanceError });
      }
    }

    return new Response(JSON.stringify({
      ...statusFields,
      balance: balance ? {
        available: [{
          amount: parseFloat(balance.available.value),
          currency: balance.available.currency,
        }],
        pending: [{
          amount: parseFloat(balance.pending.value),
          currency: balance.pending.currency,
        }],
      } : null,
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
