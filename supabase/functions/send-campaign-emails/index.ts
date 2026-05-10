import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY not configured");
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase config missing");

    // Verify user auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Verify JWT
    const token = authHeader.replace("Bearer ", "");
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY") || "");
    const { data: { user }, error: authError } = await userClient.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { campaignId, testMode, testEmail, subject: testSubject, bodyHtml: testBodyHtml, academyProfileId, trainerProfileId } = body;

    // Helper: verify caller owns the campaign owner (academy or trainer)
    async function verifyOwner(academyId: string | null, trainerId: string | null): Promise<boolean> {
      if (academyId) {
        const { data: isManager } = await supabase.rpc("is_academy_manager", {
          _user_id: user.id,
          _academy_profile_id: academyId,
        });
        return !!isManager;
      }
      if (trainerId) {
        const { data: tp } = await supabase
          .from("trainer_profiles")
          .select("user_id")
          .eq("id", trainerId)
          .maybeSingle();
        return tp?.user_id === user.id;
      }
      return false;
    }

    // === TEST MODE ===
    if (testMode && testEmail && testSubject && testBodyHtml) {
      const ok = await verifyOwner(academyProfileId || null, trainerProfileId || null);
      if (!ok) {
        return new Response(JSON.stringify({ error: "Not authorized" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const personalizeVars = (s: string, full: string) => {
        const first = (full || "there").trim().split(/\s+/)[0] || "there";
        return s
          .replace(/\{\{first_name\}\}/gi, first)
          .replace(/\{\{name\}\}/gi, full || "there");
      };
      const personalizedHtml = personalizeVars(testBodyHtml, "Test User");
      const personalizedSubject = personalizeVars(testSubject, "Test User");

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: "PadelTrainer.ai <noreply@app.padeltrainer.ai>",
          to: [testEmail],
          subject: `[TEST] ${personalizedSubject}`,
          html: personalizedHtml,
        }),
      });

      if (!res.ok) {
        const errBody = await res.text();
        return new Response(JSON.stringify({ error: errBody }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(
        JSON.stringify({ success: true, test: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // === NORMAL CAMPAIGN MODE ===
    if (!campaignId) {
      return new Response(JSON.stringify({ error: "campaignId required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch campaign
    const { data: campaign, error: campErr } = await supabase
      .from("email_campaigns")
      .select("*")
      .eq("id", campaignId)
      .single();

    if (campErr || !campaign) {
      return new Response(JSON.stringify({ error: "Campaign not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify user owns the campaign (academy manager or trainer owner)
    const ok = await verifyOwner(campaign.academy_profile_id || null, campaign.trainer_profile_id || null);
    if (!ok) {
      return new Response(JSON.stringify({ error: "Not authorized" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch recipients from campaign_recipients
    const { data: recipients, error: recErr } = await supabase
      .from("email_campaign_recipients")
      .select("*")
      .eq("campaign_id", campaignId)
      .eq("status", "pending");

    if (recErr || !recipients || recipients.length === 0) {
      return new Response(JSON.stringify({ error: "No recipients to send to" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Update campaign status to sending
    await supabase
      .from("email_campaigns")
      .update({ status: "sending", total_recipients: recipients.length })
      .eq("id", campaignId);

    let sentCount = 0;
    let failedCount = 0;

    // Send emails one by one
    for (const recipient of recipients) {
      try {
        // Replace personalization variables
        const fullName = recipient.recipient_name || "there";
        const firstName = fullName.trim().split(/\s+/)[0] || "there";
        const personalizedHtml = campaign.body_html
          .replace(/\{\{first_name\}\}/gi, firstName)
          .replace(/\{\{name\}\}/gi, fullName);

        const personalizedSubject = campaign.subject
          .replace(/\{\{first_name\}\}/gi, firstName)
          .replace(/\{\{name\}\}/gi, fullName);

        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${RESEND_API_KEY}`,
          },
          body: JSON.stringify({
            from: "PadelTrainer.ai <noreply@app.padeltrainer.ai>",
            to: [recipient.recipient_email],
            subject: personalizedSubject,
            html: personalizedHtml,
          }),
        });

        if (res.ok) {
          sentCount++;
          await supabase
            .from("email_campaign_recipients")
            .update({ status: "sent", sent_at: new Date().toISOString() })
            .eq("id", recipient.id);
        } else {
          const errBody = await res.text();
          failedCount++;
          await supabase
            .from("email_campaign_recipients")
            .update({ status: "failed", error_message: errBody })
            .eq("id", recipient.id);
        }

        // Small delay between sends to avoid rate limits
        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        failedCount++;
        await supabase
          .from("email_campaign_recipients")
          .update({
            status: "failed",
            error_message: err instanceof Error ? err.message : "Unknown error",
          })
          .eq("id", recipient.id);
      }
    }

    // Update campaign with results
    await supabase
      .from("email_campaigns")
      .update({
        status: "sent",
        sent_count: sentCount,
        failed_count: failedCount,
        sent_at: new Date().toISOString(),
      })
      .eq("id", campaignId);

    return new Response(
      JSON.stringify({ success: true, sent: sentCount, failed: failedCount }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Campaign send error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
