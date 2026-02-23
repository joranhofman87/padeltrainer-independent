import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-signature",
};

async function verifySignature(
  body: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body)
  );
  const computed = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return computed === signature;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const webhookSecret = Deno.env.get("REDITUS_WEBHOOK_SECRET");
    const rawBody = await req.text();

    // Verify signature if secret is configured
    if (webhookSecret) {
      const signature = req.headers.get("x-signature") || "";
      const valid = await verifySignature(rawBody, signature, webhookSecret);
      if (!valid) {
        console.error("Invalid webhook signature");
        return new Response(JSON.stringify({ error: "Invalid signature" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const payload = JSON.parse(rawBody);
    console.log("Reditus webhook received:", JSON.stringify(payload));

    const eventType = payload.event || payload.type;

    // Only handle lead.created events
    if (eventType !== "lead.created") {
      return new Response(JSON.stringify({ ok: true, skipped: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const leadUid = payload.lead_uid || payload.data?.lead_uid;
    const leadEmail = payload.lead_email || payload.data?.lead_email;

    if (!leadUid && !leadEmail) {
      console.error("No lead_uid or lead_email in payload");
      return new Response(
        JSON.stringify({ error: "Missing lead identifier" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Look up user by user_id first, then by email
    let userId: string | null = null;

    if (leadUid) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("user_id")
        .eq("user_id", leadUid)
        .maybeSingle();
      if (profile) userId = profile.user_id;
    }

    if (!userId && leadEmail) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("user_id")
        .eq("email", leadEmail)
        .maybeSingle();
      if (profile) userId = profile.user_id;
    }

    if (!userId) {
      console.log("User not found for lead:", { leadUid, leadEmail });
      return new Response(JSON.stringify({ ok: true, user_not_found: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check if user already has an active referral discount
    const { data: existingDiscount } = await supabase
      .from("user_discounts")
      .select("id")
      .eq("user_id", userId)
      .eq("source", "referral")
      .eq("is_active", true)
      .maybeSingle();

    if (existingDiscount) {
      console.log("User already has active referral discount:", userId);
      return new Response(
        JSON.stringify({ ok: true, already_has_discount: true }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Insert 20% discount for 3 months
    const { error: insertError } = await supabase
      .from("user_discounts")
      .insert({
        user_id: userId,
        discount_percent: 20,
        duration_months: 3,
        months_remaining: 3,
        source: "referral",
        is_active: true,
      });

    if (insertError) {
      console.error("Error inserting discount:", insertError);
      return new Response(
        JSON.stringify({ error: "Failed to create discount" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    console.log("Referral discount created for user:", userId);
    return new Response(JSON.stringify({ ok: true, discount_created: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Webhook error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
