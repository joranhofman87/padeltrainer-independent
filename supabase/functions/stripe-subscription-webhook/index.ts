import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[STRIPE-SUBSCRIPTION-WEBHOOK] ${step}`, details ? JSON.stringify(details) : "");
};

async function notifySlack(supabaseUrl: string, supabaseKey: string, eventType: string, details: Record<string, unknown>) {
  try {
    const supabase = createClient(supabaseUrl, supabaseKey);
    await supabase.functions.invoke("slack-notify", {
      body: { type: eventType, ...details },
    });
  } catch (e) {
    logStep("Slack notification failed", { error: String(e) });
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200 });
  }

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeKey) {
    return new Response("STRIPE_SECRET_KEY not set", { status: 500 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

  try {
    const body = await req.text();
    const sig = req.headers.get("stripe-signature");

    // For now, we process without signature verification
    // TODO: Add STRIPE_WEBHOOK_SECRET for production signature verification
    const event = JSON.parse(body) as Stripe.Event;

    logStep("Event received", { type: event.type, id: event.id });

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const metadata = session.metadata || {};
        const profileId = metadata.profile_id;
        const type = metadata.type;
        const tier = metadata.tier;

        if (!profileId || !type) {
          logStep("Missing metadata in checkout session", { metadata });
          break;
        }

        // Get the subscription from the session
        const subscriptionId = session.subscription as string;
        if (!subscriptionId) break;

        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const endsAt = new Date(subscription.current_period_end * 1000).toISOString();

        const table = type === "trainer" ? "trainer_profiles" : type === "academy" ? "academy_profiles" : "club_profiles";

        await supabase.from(table).update({
          subscription_status: "active",
          subscription_tier: tier,
          subscription_id: subscriptionId,
          subscription_ends_at: endsAt,
        }).eq("id", profileId);

        logStep("Subscription activated", { profileId, type, tier, subscriptionId });

        await notifySlack(supabaseUrl, supabaseServiceKey, "new_subscription", {
          profileId, type, tier,
        });
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = invoice.subscription as string;
        if (!subscriptionId) break;

        // Find the profile with this subscription ID
        for (const table of ["trainer_profiles", "academy_profiles", "club_profiles"] as const) {
          const { data } = await supabase
            .from(table)
            .select("id")
            .eq("subscription_id", subscriptionId)
            .maybeSingle();

          if (data) {
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            const endsAt = new Date(subscription.current_period_end * 1000).toISOString();

            await supabase.from(table).update({
              subscription_status: "active",
              subscription_ends_at: endsAt,
            }).eq("id", data.id);

            logStep("Subscription renewed", { table, profileId: data.id, endsAt });
            break;
          }
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = invoice.subscription as string;
        if (!subscriptionId) break;

        for (const table of ["trainer_profiles", "academy_profiles", "club_profiles"] as const) {
          const { data } = await supabase
            .from(table)
            .select("id")
            .eq("subscription_id", subscriptionId)
            .maybeSingle();

          if (data) {
            await supabase.from(table).update({
              subscription_status: "past_due",
            }).eq("id", data.id);

            logStep("Payment failed", { table, profileId: data.id });

            await notifySlack(supabaseUrl, supabaseServiceKey, "edge_function_error", {
              function_name: "stripe-subscription-webhook",
              error: `Payment failed for ${table} ${data.id}`,
            });
            break;
          }
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;

        for (const table of ["trainer_profiles", "academy_profiles", "club_profiles"] as const) {
          const { data } = await supabase
            .from(table)
            .select("id")
            .eq("subscription_id", subscription.id)
            .maybeSingle();

          if (data) {
            await supabase.from(table).update({
              subscription_status: "inactive",
              subscription_id: null,
            }).eq("id", data.id);

            logStep("Subscription deleted", { table, profileId: data.id });
            break;
          }
        }
        break;
      }

      default:
        logStep("Unhandled event type", { type: event.type });
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
