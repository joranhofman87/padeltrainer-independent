import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendResendEmail } from "../_shared/resend-send.ts";
import { requireAdmin, requireServiceRole } from "../_shared/auth.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface QueuedEmail {
  id: string;
  template_id: string;
  user_id: string;
  email: string;
  user_name: string;
  user_type: string;
  scheduled_for: string;
  template: {
    id: string;
    subject: string;
    body_html: string;
  } | null;
}

function replaceVariables(
  text: string,
  data: {
    user_name: string;
    user_email: string;
    user_type: string;
    signup_date: string;
    plan_name: string;
  }
): string {
  return text
    .replace(/\{\{user_name\}\}/g, data.user_name)
    .replace(/\{\{user_email\}\}/g, data.user_email)
    .replace(/\{\{user_type\}\}/g, data.user_type)
    .replace(/\{\{signup_date\}\}/g, data.signup_date)
    .replace(/\{\{plan_name\}\}/g, data.plan_name);
}

function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) {
      throw new Error("RESEND_API_KEY is not configured");
    }

    // Check if this is a test email request
    let testMode = false;
    let testTemplateId: string | null = null;
    let testEmail: string | null = null;

    if (req.method === "POST") {
      try {
        const body = await req.json();
        testMode = body.test_mode === true;
        testTemplateId = body.template_id;
        testEmail = body.test_email;
      } catch {
        // Not a JSON body, proceed with normal processing
      }
    }

    if (testMode && testTemplateId && testEmail) {
      // Test sends go to a caller-supplied address — require an admin JWT so this
      // can't be used as an arbitrary-recipient email primitive.
      const auth = await requireAdmin(req);
      if (auth instanceof Response) return auth;

      // Send a test email
      const { data: template, error: templateError } = await supabase
        .from("onboarding_email_templates")
        .select("*")
        .eq("id", testTemplateId)
        .single();

      if (templateError || !template) {
        return new Response(
          JSON.stringify({ error: "Template not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const testData = {
        user_name: "Test User",
        user_email: testEmail,
        user_type: capitalizeFirst(template.user_type),
        signup_date: new Date().toLocaleDateString(),
        plan_name: "Pro Plan",
      };

      const subject = replaceVariables(template.subject, testData);
      const body = replaceVariables(template.body_html, testData);

      const emailResult = await sendResendEmail(resendApiKey, {
        from: "PadelTrainer.ai <noreply@app.padeltrainer.ai>",
        to: [testEmail],
        subject: `[TEST] ${subject}`,
        html: body,
      });

      if (!emailResult.ok) {
        throw new Error(emailResult.error);
      }

      console.log("Test email sent:", emailResult);

      return new Response(
        JSON.stringify({ success: true, emailId: emailResult.id }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Normal processing (queue flush) is a server-to-server job — cron only.
    const guard = requireServiceRole(req);
    if (guard) return guard;

    // NO cron single-flight lock (10c-b/CRON-SF-WEDGE). The session-scoped
    // try_lock_cron_job pair was removed: it spanned many pooled PostgREST
    // round-trips with no session affinity, so its unlock could land on a
    // different backend and wedge this job until that connection recycled.
    // Correctness never depended on it — every queue item is taken through
    // claim_onboarding_email_queue_item, a per-row atomic CAS, so an item another
    // concurrent run already claimed is skipped here rather than sent twice.
    // Two overlapping runs therefore duplicate some read work, never a send.

    // fetch pending emails that are due
    const { data: pendingEmails, error: fetchError } = await supabase
      .from("onboarding_email_queue")
      .select(`
        id,
        template_id,
        user_id,
        email,
        user_name,
        user_type,
        scheduled_for,
        template:onboarding_email_templates(id, subject, body_html)
      `)
      .eq("status", "pending")
      .lte("scheduled_for", new Date().toISOString())
      .limit(50);

    if (fetchError) {
      console.error("Error fetching pending emails:", fetchError);
      throw fetchError;
    }

    if (!pendingEmails || pendingEmails.length === 0) {
      console.log("No pending emails to process");
      return new Response(
        JSON.stringify({ processed: 0, message: "No pending emails" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Processing ${pendingEmails.length} pending emails`);

    let successCount = 0;
    let failCount = 0;

    for (const rawItem of pendingEmails) {
      // Handle the template which comes as an array from the join
      const rawTemplate = Array.isArray(rawItem.template) ? rawItem.template[0] : rawItem.template;
      const queueItem = { ...rawItem, template: rawTemplate } as QueuedEmail;
      if (!queueItem.template) {
        console.error(`Template not found for queue item ${queueItem.id}`);
        await supabase
          .from("onboarding_email_queue")
          .update({
            status: "failed",
            error_message: "Template not found",
          })
          .eq("id", queueItem.id);
        failCount++;
        continue;
      }

      // Fetch current email from profiles to avoid sending to stale addresses
      const { data: profile } = await supabase
        .from("profiles")
        .select("email")
        .eq("user_id", queueItem.user_id)
        .single();

      if (profile?.email && profile.email !== queueItem.email) {
        console.log(`Email changed for user ${queueItem.user_id}; queue item ${queueItem.id} updated to current profile email`);
        queueItem.email = profile.email;
        await supabase
          .from("onboarding_email_queue")
          .update({ email: profile.email })
          .eq("id", queueItem.id);
      }

      const variableData = {
        user_name: queueItem.user_name,
        user_email: queueItem.email,
        user_type: capitalizeFirst(queueItem.user_type),
        signup_date: new Date(queueItem.scheduled_for).toLocaleDateString(),
        plan_name: "Pro Plan", // Could be enhanced to fetch actual plan
      };

      const subject = replaceVariables(queueItem.template.subject, variableData);
      const body = replaceVariables(queueItem.template.body_html, variableData);

      const { data: existingLog } = await supabase
        .from("onboarding_email_logs")
        .select("id")
        .eq("queue_id", queueItem.id)
        .eq("status", "sent")
        .limit(1)
        .maybeSingle();

      if (existingLog) {
        await supabase
          .from("onboarding_email_queue")
          .update({ status: "sent", sent_at: new Date().toISOString() })
          .eq("id", queueItem.id)
          .eq("status", "pending");
        continue;
      }

      const { data: claimed, error: claimError } = await supabase.rpc(
        "claim_onboarding_email_queue_item",
        { p_queue_id: queueItem.id, p_from_status: "pending" },
      );

      if (claimError) {
        console.error(`Claim failed for ${queueItem.id}:`, claimError);
        failCount++;
        continue;
      }

      if (!claimed) {
        console.log(`Queue item ${queueItem.id} already claimed, skipping`);
        continue;
      }

      try {
        const emailResult = await sendResendEmail(resendApiKey, {
          from: "PadelTrainer.ai <noreply@app.padeltrainer.ai>",
          to: [queueItem.email],
          subject,
          html: body,
        });

        if (!emailResult.ok) {
          throw new Error(emailResult.error);
        }

        console.log(`Email sent for queue item ${queueItem.id} (user ${queueItem.user_id}):`, emailResult);

        // Log the sent email (unique index prevents duplicate sent logs)
        await supabase.from("onboarding_email_logs").insert({
          template_id: queueItem.template_id,
          queue_id: queueItem.id,
          user_id: queueItem.user_id,
          email: queueItem.email,
          subject,
          status: "sent",
        });

        successCount++;
      } catch (emailError: unknown) {
        console.error(`Failed to send email for queue item ${queueItem.id}:`, emailError);

        const errorMessage = emailError instanceof Error ? emailError.message : "Unknown error";

        // Update queue status to failed
        await supabase
          .from("onboarding_email_queue")
          .update({
            status: "failed",
            error_message: errorMessage,
            sent_at: null,
          })
          .eq("id", queueItem.id);

        // Log the failed attempt
        await supabase.from("onboarding_email_logs").insert({
          template_id: queueItem.template_id,
          queue_id: queueItem.id,
          user_id: queueItem.user_id,
          email: queueItem.email,
          subject,
          status: "failed",
        });

        failCount++;
      }
    }

    // Per-item failures return HTTP 200, so the daily-emails cron wrapper's
    // alertCronFailure (non-2xx only) never sees them. Each failed item is
    // already marked 'failed' in the queue (won't retry), so a silent failure
    // means an onboarding email that never goes out — alert.
    if (failCount > 0) {
      await notifySlackEdgeError(
        "process-onboarding-emails",
        `${failCount} onboarding email(s) failed to send`,
        { failCount, successCount, processed: pendingEmails.length },
      );
    }

    return new Response(
      JSON.stringify({
        processed: pendingEmails.length,
        success: successCount,
        failed: failCount,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Error in process-onboarding-emails:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
};

serve(handler);
