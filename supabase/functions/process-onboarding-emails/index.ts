import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";

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

  try {
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) {
      throw new Error("RESEND_API_KEY is not configured");
    }

    const resend = new Resend(resendApiKey);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

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

      const emailResult = await resend.emails.send({
        from: "PadelTrainer.ai <noreply@app.padeltrainer.ai>",
        to: [testEmail],
        subject: `[TEST] ${subject}`,
        html: body,
      });

      console.log("Test email sent:", emailResult);

      return new Response(
        JSON.stringify({ success: true, emailId: emailResult.data?.id }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Normal processing: fetch pending emails that are due
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
        console.log(`Email changed for user ${queueItem.user_id}: ${queueItem.email} → ${profile.email}`);
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

      try {
        const emailResult = await resend.emails.send({
          from: "PadelTrainer.ai <noreply@app.padeltrainer.ai>",
          to: [queueItem.email],
          subject,
          html: body,
        });

        console.log(`Email sent to ${queueItem.email}:`, emailResult);

        // Update queue status to sent
        await supabase
          .from("onboarding_email_queue")
          .update({
            status: "sent",
            sent_at: new Date().toISOString(),
          })
          .eq("id", queueItem.id);

        // Log the sent email
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
        console.error(`Failed to send email to ${queueItem.email}:`, emailError);

        const errorMessage = emailError instanceof Error ? emailError.message : "Unknown error";

        // Update queue status to failed
        await supabase
          .from("onboarding_email_queue")
          .update({
            status: "failed",
            error_message: errorMessage,
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
