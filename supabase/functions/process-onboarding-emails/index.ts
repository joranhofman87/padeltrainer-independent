import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendResendEmail } from "../_shared/resend-send.ts";
import { requireAdmin, requireServiceRole } from "../_shared/auth.ts";
import {
  claimMissingTemplateFailure,
  emitOnboardingRunAlert,
  newOnboardingRunTally,
  recordMissingTemplateOutcome,
  type MissingTemplateClient,
} from "../_shared/onboarding-missing-template.ts";
import {
  marketingFooterHtml,
  resolveMarketingAttachment,
  rfc8058Headers,
  type MarketingAttachDeps,
} from "../_shared/marketing-email.ts";
import type { ManageKeyState } from "../_shared/manage-token.ts";

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
    delivery_class: string | null;
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
        template:onboarding_email_templates(id, subject, body_html, delivery_class)
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

    // ── N2 S3: the marketing attach layer for MARKETING-classed templates ────────────────────
    // The onboarding drip is platform mail; its scope is 'platform'. delivery_class is DECLARED
    // on the template (S1's column): 'marketing' rows get the send-time suppression gate, a
    // per-send capability (the QUEUE ROW is the durable send identity), the unsubscribe footer
    // and the RFC 8058 headers. 'required_service' rows are untouched. An UNCLASSIFIED template
    // is treated as MARKETING: the drip's default content is promotional, and the safe error is
    // an unnecessary unsubscribe link on a service mail — never a marketing mail without one.
    const { data: keyStateRow, error: keyStateErr } = await supabase
      .from("notification_manage_key_state")
      .select("current_version, min_mintable_version")
      .maybeSingle();
    if (keyStateErr) console.error("manage key state read failed:", keyStateErr);
    const manageKeyState: ManageKeyState | null = keyStateRow
      ? { currentVersion: keyStateRow.current_version, minMintableVersion: keyStateRow.min_mintable_version }
      : null;
    const attachDeps: MarketingAttachDeps = {
      mintCapability: async (args) => {
        const { data, error } = await supabase.rpc("mint_notification_manage_capability", {
          p_kind: "marketing_unsubscribe",
          p_scope_kind: args.scopeKind,
          p_scope_id: args.scopeId,
          p_address: args.address,
          p_source_kind: args.sourceKind,
          p_source_id: args.sourceId,
          p_ttl: "480 days",
        });
        if (error) throw new Error(`mint failed: ${error.message}`);
        const row = Array.isArray(data) ? data[0] : data;
        if (!row) throw new Error("mint returned no capability");
        return { capabilityId: row.capability_id, keyVersion: row.key_version };
      },
      readCapabilityForSource: async (sourceKind, sourceId) => {
        const { data, error } = await supabase.rpc("get_manage_capability_for_source", {
          p_source_kind: sourceKind,
          p_source_id: sourceId,
        });
        if (error) throw new Error(`capability lookup failed: ${error.message}`);
        const row = Array.isArray(data) ? data[0] : data;
        if (!row) return null;
        return { capabilityId: row.capability_id, keyVersion: row.key_version, revoked: row.revoked, expired: row.expired };
      },
      keyState: manageKeyState,
    };

    // The tally and its single end-of-run alert are production primitives in
    // _shared/onboarding-missing-template.ts, so the Deno suite exercises this exact
    // wiring (this module is unimportable — `serve(handler)` runs at import time).
    const tally = newOnboardingRunTally(pendingEmails.length);

    for (const rawItem of pendingEmails) {
      // Handle the template which comes as an array from the join
      const rawTemplate = Array.isArray(rawItem.template) ? rawItem.template[0] : rawItem.template;
      const queueItem = { ...rawItem, template: rawTemplate } as QueuedEmail;
      if (!queueItem.template) {
        // Ownership lives in ONE production-owned primitive (_shared/
        // onboarding-missing-template.ts) so the concurrency guard is exercised by
        // tests directly rather than re-implemented by them. See that file for why
        // this path needs a CAS at all: it runs before the claim, so two
        // overlapping invocations would otherwise both count the failure and both
        // fire the end-of-run Slack alert for a single broken row.
        // The primitive declares only the narrow builder surface it needs, so the
        // tests can supply a faithful stand-in; the real client is structurally
        // wider. Cast at this adapter boundary rather than loosening the contract
        // the tests rely on.
        const outcome = await claimMissingTemplateFailure(
          supabase as unknown as MissingTemplateClient,
          queueItem.id,
        );
        if (outcome.kind === "error") {
          console.error(`Could not mark queue item ${queueItem.id} failed:`, outcome.message);
        } else if (outcome.kind === "already_handled") {
          console.log(`Queue item ${queueItem.id} missing-template already handled by another run, skipping`);
        } else {
          console.error(`Template not found for queue item ${queueItem.id}`);
        }
        recordMissingTemplateOutcome(tally, outcome);
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
        tally.failCount++;
        continue;
      }

      if (!claimed) {
        console.log(`Queue item ${queueItem.id} already claimed, skipping`);
        continue;
      }

      // Marketing-classed (or unclassified — see above) templates carry the unsubscribe layer.
      const isMarketing = queueItem.template.delivery_class !== "required_service";
      let finalHtml = body;
      let extraHeaders: Record<string, string> | undefined;
      if (isMarketing) {
        // SEND-TIME suppression, canonical reader. Suppressed → the queue row goes terminal
        // 'suppressed' (never 'failed': an opt-out is a decision, not an error to retry). A
        // check ERROR → 'failed' via the ordinary catch below (an error is never clearance).
        const { data: suppressed, error: suppErr } = await supabase.rpc("is_marketing_suppressed", {
          p_address: queueItem.email,
          p_scope_kind: "platform",
          p_scope_id: null,
        });
        if (suppErr) {
          console.error(`Suppression check failed for queue item ${queueItem.id}:`, suppErr);
          await supabase
            .from("onboarding_email_queue")
            .update({ status: "failed", error_message: `suppression check failed: ${suppErr.message}`.slice(0, 500), sent_at: null })
            .eq("id", queueItem.id);
          tally.failCount++;
          continue;
        }
        if (suppressed === true) {
          // The claim above optimistically marked this row 'sent'; this write is what makes the
          // record truthful. If IT fails, say so loudly — a suppression recorded as a delivery
          // is exactly the lie this status exists to prevent.
          const { error: suppWriteErr } = await supabase
            .from("onboarding_email_queue")
            .update({ status: "suppressed", error_message: null, sent_at: null })
            .eq("id", queueItem.id);
          if (suppWriteErr) {
            console.error(`CRITICAL: queue item ${queueItem.id} is suppressed but stays recorded 'sent':`, suppWriteErr);
            tally.failCount++;
            continue;
          }
          tally.suppressedCount++;
          console.log(`Queue item ${queueItem.id} suppressed (marketing opt-out) — not sent`);
          continue;
        }

        // The QUEUE ROW is the durable send identity. The drip has no provider idempotency key
        // (pre-existing), so there is no frozen-bytes cutover concern here: attach on every
        // attempt, including rows that failed before this deploy — `attempted: false` keeps the
        // mint-or-return path, which is idempotent per row.
        try {
          const attachment = await resolveMarketingAttachment(attachDeps, {
            scopeKind: "platform",
            scopeId: null,
            address: queueItem.email,
            sourceKind: "onboarding_queue",
            sourceId: queueItem.id,
            attempted: false,
          });
          if (attachment.kind !== "attach") {
            // terminal (retired key / revoked / missing state / pre-cutover): the send is
            // BLOCKED — a marketing mail may not leave without a working unsubscribe.
            const reason = attachment.reason;
            await supabase
              .from("onboarding_email_queue")
              .update({ status: "failed", error_message: `unsubscribe unavailable: ${reason}`.slice(0, 500), sent_at: null })
              .eq("id", queueItem.id);
            tally.failCount++;
            continue;
          }
          finalHtml = body + marketingFooterHtml(attachment.token);
          extraHeaders = rfc8058Headers(supabaseUrl, attachment.token);
        } catch (capErr) {
          const msg = capErr instanceof Error ? capErr.message : "capability mint failed";
          console.error(`Capability mint failed for queue item ${queueItem.id}:`, msg);
          await supabase
            .from("onboarding_email_queue")
            .update({ status: "failed", error_message: msg.slice(0, 500), sent_at: null })
            .eq("id", queueItem.id);
          tally.failCount++;
          continue;
        }
      }

      try {
        const emailResult = await sendResendEmail(resendApiKey, {
          from: "PadelTrainer.ai <noreply@app.padeltrainer.ai>",
          to: [queueItem.email],
          subject,
          html: finalHtml,
          ...(extraHeaders ? { headers: extraHeaders } : {}),
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

        tally.successCount++;
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

        tally.failCount++;
      }
    }

    await emitOnboardingRunAlert(tally);

    return new Response(
      JSON.stringify({
        processed: tally.processed,
        success: tally.successCount,
        failed: tally.failCount,
        suppressed: tally.suppressedCount,
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
