import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[MOLLIE-SUBSCRIPTION-WEBHOOK] ${step}`, details ? JSON.stringify(details) : "");
};

// Plan configurations
const TRAINER_PLANS: Record<string, { amount: string; interval: string; times?: number }> = {
  starter: { amount: "19.00", interval: "1 month" },
  professional: { amount: "39.00", interval: "1 month" },
  starter_yearly: { amount: "190.00", interval: "12 months", times: 1 },
  professional_yearly: { amount: "390.00", interval: "12 months", times: 1 },
};

const ACADEMY_PLAN = { amount: "199.00", interval: "1 month" };

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

    // Mollie sends payment ID in the body
    const formData = await req.formData();
    const paymentId = formData.get("id") as string;

    if (!paymentId) {
      logStep("No payment ID in webhook");
      return new Response("OK", { status: 200 });
    }

    logStep("Webhook received", { paymentId });

    // Fetch payment details from Mollie (source of truth)
    const paymentResponse = await fetch(`https://api.mollie.com/v2/payments/${paymentId}`, {
      headers: { "Authorization": `Bearer ${mollieApiKey}` },
    });

    if (!paymentResponse.ok) {
      logStep("Failed to fetch payment from Mollie", { status: paymentResponse.status });
      // Return 500 so Mollie retries
      return new Response("Failed to fetch payment", { status: 500 });
    }

    const payment = await paymentResponse.json();
    logStep("Payment fetched", { status: payment.status, metadata: payment.metadata });

    const metadata = payment.metadata || {};
    const customerId = payment.customerId;

    // --- Handle failed/expired payments (dunning) ---
    if (payment.status === "failed" || payment.status === "expired") {
      await handleFailedPayment(supabase, metadata, payment.status, paymentId);
      await logSubscriptionPayment(supabase, payment, metadata);
      return new Response("OK", { status: 200 });
    }

    if (payment.status !== "paid") {
      logStep("Payment not actionable", { status: payment.status });
      return new Response("OK", { status: 200 });
    }

    // --- TRAINER first payment ---
    if (metadata.type === "subscription_first_payment" && metadata.trainer_profile_id) {
      // Idempotency: skip if already processed
      const { data: tp } = await supabase
        .from("trainer_profiles")
        .select("subscription_id, last_processed_payment_id")
        .eq("id", metadata.trainer_profile_id)
        .single();

      if (tp?.last_processed_payment_id === paymentId) {
        logStep("Payment already processed (idempotent skip)", { paymentId });
        return new Response("OK", { status: 200 });
      }
      if (tp?.subscription_id) {
        logStep("Subscription already exists (idempotent skip)", { subscriptionId: tp.subscription_id });
        // Still mark payment as processed
        await supabase.from("trainer_profiles").update({ last_processed_payment_id: paymentId }).eq("id", metadata.trainer_profile_id);
        return new Response("OK", { status: 200 });
      }

      const planId = metadata.plan_id;
      const plan = TRAINER_PLANS[planId];
      if (!plan) {
        logStep("Invalid plan ID", { planId });
        return new Response("OK", { status: 200 });
      }

      const subscription = await createMollieSubscription(mollieApiKey, supabaseUrl, customerId, {
        amount: plan.amount,
        interval: plan.interval,
        times: plan.times,
        description: `Trainer subscription - ${planId}`,
        metadata: {
          trainer_profile_id: metadata.trainer_profile_id,
          plan_id: planId,
          type: "trainer_subscription",
        },
      });

      // Use Mollie's nextPaymentDate for accuracy
      const endDate = subscription.nextPaymentDate
        ? new Date(subscription.nextPaymentDate)
        : calculateEndDate(plan.interval);

      const { error: updateError } = await supabase
        .from("trainer_profiles")
        .update({
          subscription_status: "active",
          subscription_tier: planId.replace("_yearly", ""),
          subscription_id: subscription.id,
          subscription_ends_at: endDate.toISOString(),
          last_processed_payment_id: paymentId,
        })
        .eq("id", metadata.trainer_profile_id);

      if (updateError) {
        logStep("DB update failed", { error: updateError.message });
        return new Response("DB error", { status: 500 });
      }

      logStep("Trainer subscription activated", { subscriptionId: subscription.id });
      await sendSlackNotification(supabase, metadata.trainer_profile_id, "trainer_profiles", planId, plan.amount);
      await logSubscriptionPayment(supabase, payment, metadata, "trainer", metadata.trainer_profile_id, planId);
    }

    // --- ACADEMY first payment ---
    if (metadata.type === "academy_subscription_first_payment" && metadata.academy_profile_id) {
      // Idempotency check
      const { data: ap } = await supabase
        .from("academy_profiles")
        .select("subscription_id, last_processed_payment_id")
        .eq("id", metadata.academy_profile_id)
        .single();

      if (ap?.last_processed_payment_id === paymentId) {
        logStep("Academy payment already processed (idempotent skip)", { paymentId });
        return new Response("OK", { status: 200 });
      }
      if (ap?.subscription_id) {
        logStep("Academy subscription already exists (idempotent skip)");
        await supabase.from("academy_profiles").update({ last_processed_payment_id: paymentId }).eq("id", metadata.academy_profile_id);
        return new Response("OK", { status: 200 });
      }

      const subscription = await createMollieSubscription(mollieApiKey, supabaseUrl, customerId, {
        amount: ACADEMY_PLAN.amount,
        interval: ACADEMY_PLAN.interval,
        description: "Academy subscription - monthly",
        metadata: {
          academy_profile_id: metadata.academy_profile_id,
          type: "academy_subscription",
        },
      });

      const endDate = subscription.nextPaymentDate
        ? new Date(subscription.nextPaymentDate)
        : calculateEndDate(ACADEMY_PLAN.interval);

      const { error: updateError } = await supabase
        .from("academy_profiles")
        .update({
          subscription_status: "active",
          subscription_tier: "academy",
          subscription_id: subscription.id,
          subscription_ends_at: endDate.toISOString(),
          last_processed_payment_id: paymentId,
        })
        .eq("id", metadata.academy_profile_id);

      if (updateError) {
        logStep("DB update failed for academy", { error: updateError.message });
        return new Response("DB error", { status: 500 });
      }

      logStep("Academy subscription activated", { subscriptionId: subscription.id });
      await logSubscriptionPayment(supabase, payment, metadata, "academy", metadata.academy_profile_id, "academy");
    }

    // --- CLUB first payment ---
    if (metadata.type === "club_subscription_first_payment" && metadata.club_profile_id) {
      // Idempotency check
      const { data: cp } = await supabase
        .from("club_profiles")
        .select("subscription_id, last_processed_payment_id")
        .eq("id", metadata.club_profile_id)
        .single();

      if (cp?.last_processed_payment_id === paymentId) {
        logStep("Club payment already processed (idempotent skip)", { paymentId });
        return new Response("OK", { status: 200 });
      }
      if (cp?.subscription_id) {
        logStep("Club subscription already exists (idempotent skip)");
        await supabase.from("club_profiles").update({ last_processed_payment_id: paymentId }).eq("id", metadata.club_profile_id);
        return new Response("OK", { status: 200 });
      }

      const billingCycle = metadata.billing_cycle || "yearly";
      const planAmount = metadata.plan_amount || "2388.00";
      const trialEndsAt = metadata.trial_ends_at;
      const startDate = trialEndsAt ? new Date(trialEndsAt) : undefined;

      const subscriptionPayload: Record<string, unknown> = {
        amount: planAmount,
        interval: billingCycle === "yearly" ? "12 months" : "1 month",
        description: `Club subscription - ${billingCycle}`,
        metadata: {
          club_profile_id: metadata.club_profile_id,
          type: "club_subscription",
        },
      };

      if (startDate) {
        subscriptionPayload.startDate = startDate.toISOString().split("T")[0];
      }

      const subscription = await createMollieSubscription(mollieApiKey, supabaseUrl, customerId, subscriptionPayload);

      const endDate = subscription.nextPaymentDate
        ? new Date(subscription.nextPaymentDate)
        : calculateEndDate(billingCycle === "yearly" ? "12 months" : "1 month");

      const { error: updateError } = await supabase
        .from("club_profiles")
        .update({
          subscription_status: "active",
          subscription_id: subscription.id,
          subscription_tier: "club",
          subscription_ends_at: endDate.toISOString(),
          last_processed_payment_id: paymentId,
        })
        .eq("id", metadata.club_profile_id);

      if (updateError) {
        logStep("DB update failed for club", { error: updateError.message });
        return new Response("DB error", { status: 500 });
      }

      logStep("Club subscription activated", { subscriptionId: subscription.id });
      await logSubscriptionPayment(supabase, payment, metadata, "club", metadata.club_profile_id, "club");
    }

    // --- Handle RECURRING subscription payments ---
    if (metadata.type === "trainer_subscription" || metadata.type === "club_subscription" || metadata.type === "academy_subscription") {
      const config = getRecurringConfig(metadata.type);
      if (!config) {
        logStep("Unknown recurring type", { type: metadata.type });
        return new Response("OK", { status: 200 });
      }

      const profileId = metadata[config.profileField];
      if (!profileId) {
        logStep("No profile ID in recurring metadata");
        return new Response("OK", { status: 200 });
      }

      // Idempotency check for recurring
      const { data: profile } = await supabase
        .from(config.table)
        .select("last_processed_payment_id")
        .eq("id", profileId)
        .single();

      if (profile?.last_processed_payment_id === paymentId) {
        logStep("Recurring payment already processed (idempotent skip)", { paymentId });
        return new Response("OK", { status: 200 });
      }

      // Fetch subscription from Mollie to get nextPaymentDate
      let endDate: Date;
      if (payment.subscriptionId && customerId) {
        try {
          const subResp = await fetch(
            `https://api.mollie.com/v2/customers/${customerId}/subscriptions/${payment.subscriptionId}`,
            { headers: { "Authorization": `Bearer ${mollieApiKey}` } }
          );
          if (subResp.ok) {
            const sub = await subResp.json();
            endDate = sub.nextPaymentDate ? new Date(sub.nextPaymentDate) : calculateEndDate(sub.interval || "1 month");
          } else {
            endDate = calculateEndDate(metadata.type === "club_subscription" ? "12 months" : "1 month");
          }
        } catch {
          endDate = calculateEndDate(metadata.type === "club_subscription" ? "12 months" : "1 month");
        }
      } else {
        endDate = calculateEndDate(metadata.type === "club_subscription" ? "12 months" : "1 month");
      }

      const { error: updateError } = await supabase
        .from(config.table)
        .update({
          subscription_status: "active",
          subscription_ends_at: endDate.toISOString(),
          last_processed_payment_id: paymentId,
        })
        .eq("id", profileId);

      if (updateError) {
        logStep("Recurring DB update failed", { error: updateError.message });
        return new Response("DB error", { status: 500 });
      }

      logStep("Recurring payment processed", { type: metadata.type, profileId });
      const profileType = metadata.type === "trainer_subscription" ? "trainer" : metadata.type === "academy_subscription" ? "academy" : "club";
      await logSubscriptionPayment(supabase, payment, metadata, profileType, profileId as string);
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    // Return 500 for transient errors so Mollie retries
    return new Response("Internal error", { status: 500 });
  }
});

// --- Helper functions ---

async function createMollieSubscription(
  apiKey: string,
  supabaseUrl: string,
  customerId: string,
  config: {
    amount: string;
    interval: string;
    times?: number;
    description: string;
    metadata: Record<string, unknown>;
    startDate?: string;
  }
) {
  const body: Record<string, unknown> = {
    amount: { currency: "EUR", value: config.amount },
    interval: config.interval,
    description: config.description,
    webhookUrl: `${supabaseUrl}/functions/v1/mollie-subscription-webhook`,
    metadata: config.metadata,
  };

  if (config.times) body.times = config.times;
  if (config.startDate) body.startDate = config.startDate;

  const response = await fetch(
    `https://api.mollie.com/v2/customers/${customerId}/subscriptions`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    logStep("Failed to create subscription", { error: errorText });
    throw new Error(`Failed to create subscription: ${errorText}`);
  }

  const subscription = await response.json();
  logStep("Subscription created", { subscriptionId: subscription.id });
  return subscription;
}

function calculateEndDate(interval: string): Date {
  const endDate = new Date();
  if (interval === "12 months") {
    endDate.setFullYear(endDate.getFullYear() + 1);
  } else {
    endDate.setMonth(endDate.getMonth() + 1);
  }
  return endDate;
}

function getRecurringConfig(type: string) {
  const configs: Record<string, { profileField: string; table: string }> = {
    trainer_subscription: { profileField: "trainer_profile_id", table: "trainer_profiles" },
    club_subscription: { profileField: "club_profile_id", table: "club_profiles" },
    academy_subscription: { profileField: "academy_profile_id", table: "academy_profiles" },
  };
  return configs[type] || null;
}

async function handleFailedPayment(
  supabase: ReturnType<typeof createClient>,
  metadata: Record<string, unknown>,
  status: string,
  paymentId: string
) {
  logStep("Payment failed/expired", { status, metadata });

  const config = getRecurringConfig(metadata.type as string);
  if (!config) {
    // Also check first-payment types
    const firstPaymentConfigs: Record<string, { profileField: string; table: string }> = {
      subscription_first_payment: { profileField: "trainer_profile_id", table: "trainer_profiles" },
      academy_subscription_first_payment: { profileField: "academy_profile_id", table: "academy_profiles" },
      club_subscription_first_payment: { profileField: "club_profile_id", table: "club_profiles" },
    };
    const fpConfig = firstPaymentConfigs[metadata.type as string];
    if (fpConfig && metadata[fpConfig.profileField]) {
      await supabase
        .from(fpConfig.table)
        .update({ subscription_status: "past_due", last_processed_payment_id: paymentId })
        .eq("id", metadata[fpConfig.profileField]);
    }
    return;
  }

  const profileId = metadata[config.profileField] as string;
  if (!profileId) return;

  await supabase
    .from(config.table)
    .update({ subscription_status: "past_due", last_processed_payment_id: paymentId })
    .eq("id", profileId);

  // Slack notification for failed payment
  try {
    await supabase.functions.invoke("slack-notify", {
      body: {
        event: "subscription_payment_failed",
        data: {
          type: metadata.type,
          profileId,
          paymentStatus: status,
        },
      },
    });
  } catch (slackErr) {
    logStep("Slack notification failed (non-fatal)", { error: String(slackErr) });
  }
}

async function logSubscriptionPayment(
  supabase: ReturnType<typeof createClient>,
  payment: Record<string, unknown>,
  metadata: Record<string, unknown>,
  profileType?: string,
  profileId?: string,
  planId?: string,
) {
  try {
    // Determine profile type and ID from metadata if not provided
    const pType = profileType || (
      metadata.trainer_profile_id ? "trainer" :
      metadata.academy_profile_id ? "academy" :
      metadata.club_profile_id ? "club" : "unknown"
    );
    const pId = profileId || (
      metadata.trainer_profile_id || metadata.academy_profile_id || metadata.club_profile_id
    ) as string;

    if (!pId || pType === "unknown") return;

    await supabase.from("subscription_payments").upsert({
      profile_type: pType,
      profile_id: pId,
      mollie_payment_id: payment.id as string,
      mollie_subscription_id: (payment.subscriptionId as string) || null,
      mollie_customer_id: (payment.customerId as string) || null,
      amount: parseFloat((payment.amount as { value: string })?.value || "0"),
      currency: (payment.amount as { currency: string })?.currency || "EUR",
      status: payment.status as string,
      plan_id: planId || (metadata.plan_id as string) || null,
      paid_at: payment.status === "paid" ? new Date().toISOString() : null,
    }, { onConflict: "mollie_payment_id" });

    logStep("Payment logged to audit table", { paymentId: payment.id });
  } catch (err) {
    logStep("Failed to log payment (non-fatal)", { error: String(err) });
  }
}

async function sendSlackNotification(
  supabase: ReturnType<typeof createClient>,
  trainerProfileId: string,
  _table: string,
  planId: string,
  amount: string,
) {
  try {
    const { data: tp } = await supabase
      .from("trainer_profiles")
      .select("user_id")
      .eq("id", trainerProfileId)
      .single();

    if (tp?.user_id) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("user_id", tp.user_id)
        .single();

      await supabase.functions.invoke("slack-notify", {
        body: {
          event: "subscription_purchased",
          data: {
            name: profile?.full_name || "Unknown",
            type: "Trainer",
            plan: planId,
            amount: `€${amount}`,
          },
        },
      });
    }
  } catch (slackErr) {
    logStep("Slack notification failed (non-fatal)", { error: String(slackErr) });
  }
}
