import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface SlackNotifyPayload {
  event: string;
  data: Record<string, unknown>;
}

const EVENT_CONFIG: Record<string, { emoji: string; title: string }> = {
  new_signup: { emoji: "👤", title: "New Sign up" },
  new_club_signup: { emoji: "🏟️", title: "New Club Signup" },
  new_academy_signup: { emoji: "🎓", title: "New Academy Signup" },
  booking_created: { emoji: "📅", title: "Booking Created" },
  payment_received: { emoji: "💰", title: "Payment Received" },
  profile_published: { emoji: "🚀", title: "Profile Published" },
  subscription_purchased: { emoji: "⭐", title: "Subscription Purchased" },
  new_review: { emoji: "⭐", title: "New Review Posted" },
  account_deletion: { emoji: "🗑️", title: "Account Deletion Requested" },
  new_club_claim: { emoji: "🏢", title: "New Club Claim" },
  edge_function_error: { emoji: "🚨", title: "Edge Function Error" },
  new_registration: { emoji: "📝", title: "New Cycle Registration" },
  registration_error: { emoji: "⚠️", title: "Registration Form Error" },
};

function formatMessage(event: string, data: Record<string, unknown>): object {
  const config = EVENT_CONFIG[event] || { emoji: "ℹ️", title: event };

  // For signup events, append the role to the title
  let title = config.title;
  if (event === "new_signup" && data.role) {
    title = `${config.title}: ${String(data.role)}`;
  }

  const fields: { type: string; text: string }[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value != null && value !== "") {
      const label = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      fields.push({
        type: "mrkdwn",
        text: `*${label}:*\n${String(value)}`,
      });
    }
  }

  return {
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${config.emoji} ${title}`,
          emoji: true,
        },
      },
      {
        type: "section",
        fields: fields.slice(0, 10), // Slack limit
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `<!date^${Math.floor(Date.now() / 1000)}^{date_short_pretty} at {time}|${new Date().toISOString()}>`,
          },
        ],
      },
    ],
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Authenticate: only allow calls with service role key
    const authHeader = req.headers.get("Authorization");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!authHeader || authHeader !== `Bearer ${serviceKey}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const webhookUrl = Deno.env.get("SLACK_WEBHOOK_URL");
    if (!webhookUrl) {
      console.error("[SLACK-NOTIFY] SLACK_WEBHOOK_URL not configured");
      return new Response(JSON.stringify({ error: "Webhook not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { event, data }: SlackNotifyPayload = await req.json();

    if (!event) {
      return new Response(JSON.stringify({ error: "Missing event" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const message = formatMessage(event, data || {});

    const slackResponse = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });

    if (!slackResponse.ok) {
      const errorText = await slackResponse.text();
      console.error("[SLACK-NOTIFY] Slack API error:", errorText);
      return new Response(JSON.stringify({ error: "Slack API error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[SLACK-NOTIFY] Sent: ${event}`);
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[SLACK-NOTIFY] Error:", error);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
