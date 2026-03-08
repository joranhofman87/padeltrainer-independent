import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[RECONCILE-SUBSCRIPTIONS] ${step}`, details ? JSON.stringify(details) : "");
};

const BATCH_DELAY_MS = 300; // 300ms between Mollie API calls to respect rate limits

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ProfileRow {
  id: string;
  mollie_customer_id: string;
  subscription_status: string | null;
  subscription_id: string | null;
  subscription_ends_at: string | null;
}

async function reconcileProfiles(
  mollieApiKey: string,
  supabase: any,
  table: string,
  profileType: string,
) {
  const { data: profiles, error } = await supabase
    .from(table)
    .select("id, mollie_customer_id, subscription_status, subscription_id, subscription_ends_at")
    .not("mollie_customer_id", "is", null);

  if (error || !profiles) {
    logStep(`Failed to fetch ${profileType} profiles`, { error: error?.message });
    return { checked: 0, updated: 0 };
  }

  let updated = 0;

  for (const profile of profiles as ProfileRow[]) {
    try {
      const subsResp = await fetch(
        `https://api.mollie.com/v2/customers/${profile.mollie_customer_id}/subscriptions`,
        { headers: { "Authorization": `Bearer ${mollieApiKey}` } }
      );

      if (!subsResp.ok) {
        logStep(`Failed to fetch subscriptions for ${profileType}`, { profileId: profile.id, status: subsResp.status });
        await sleep(BATCH_DELAY_MS);
        continue;
      }

      const subsData = await subsResp.json();
      const activeSub = (subsData._embedded?.subscriptions || []).find(
        (s: { status: string }) => s.status === "active"
      );

      const dbStatus = profile.subscription_status;
      const now = new Date();

      if (activeSub) {
        // Mollie has an active subscription
        const nextPaymentDate = activeSub.nextPaymentDate;
        const updates: Record<string, unknown> = {};

        if (dbStatus !== "active") {
          updates.subscription_status = "active";
        }
        if (profile.subscription_id !== activeSub.id) {
          updates.subscription_id = activeSub.id;
        }
        if (nextPaymentDate) {
          const newEnd = new Date(nextPaymentDate).toISOString();
          if (profile.subscription_ends_at !== newEnd) {
            updates.subscription_ends_at = newEnd;
          }
        }

        if (Object.keys(updates).length > 0) {
          await supabase.from(table).update(updates).eq("id", profile.id);
          updated++;
          logStep(`Reconciled ${profileType}`, { profileId: profile.id, updates });
        }
      } else {
        // No active subscription at Mollie
        if (dbStatus === "active" && profile.subscription_ends_at) {
          const endDate = new Date(profile.subscription_ends_at);
          if (endDate < now) {
            await supabase
              .from(table)
              .update({ subscription_status: "inactive", subscription_id: null })
              .eq("id", profile.id);
            updated++;
            logStep(`Deactivated expired ${profileType}`, { profileId: profile.id });
          }
        }
      }

      await sleep(BATCH_DELAY_MS);
    } catch (err) {
      logStep(`Error reconciling ${profileType}`, { profileId: profile.id, error: String(err) });
      await sleep(BATCH_DELAY_MS);
    }
  }

  return { checked: profiles.length, updated };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const mollieApiKey = Deno.env.get("MOLLIE_API_KEY");
    if (!mollieApiKey) throw new Error("MOLLIE_API_KEY is not set");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    logStep("Starting reconciliation");

    const trainerResult = await reconcileProfiles(mollieApiKey, supabase, "trainer_profiles", "trainer");
    const academyResult = await reconcileProfiles(mollieApiKey, supabase, "academy_profiles", "academy");
    const clubResult = await reconcileProfiles(mollieApiKey, supabase, "club_profiles", "club");

    const summary = {
      trainers: trainerResult,
      academies: academyResult,
      clubs: clubResult,
    };

    logStep("Reconciliation complete", summary);

    return new Response(
      JSON.stringify({ success: true, summary }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
