import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import {
  getAcademyMolliePaymentReadiness,
  getTrainerMolliePaymentReadiness,
  type MolliePaymentUnavailableReason,
} from "../_shared/mollie-payment-ready.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[CREATE-INVOICE-PAYMENT] ${step}`, details ? JSON.stringify(details) : "");
};

async function notifySlack(supabase: any, event: string, data: Record<string, unknown>) {
  try {
    await supabase.functions.invoke("slack-notify", {
      body: { event, data },
    });
  } catch (_) {
    // Silent
  }
}

async function writeAuditLog(
  supabase: any,
  log: {
    function_name: string;
    invoice_id?: string;
    recipient_type?: string;
    mollie_org_id?: string;
    amount?: number;
    status: string;
    error_message?: string;
    mollie_payment_id?: string;
    metadata?: Record<string, unknown>;
  }
) {
  try {
    await supabase.from("payment_audit_log").insert(log);
  } catch (_) {
    logStep("Failed to write audit log", { error: String(_) });
  }
}

async function refreshTokenIfNeeded(
  supabaseClient: any,
  accountData: any,
  entityType: "trainer" | "academy",
  entityId: string
): Promise<string | null> {
  const mollieClientId = Deno.env.get("MOLLIE_CLIENT_ID");
  const mollieClientSecret = Deno.env.get("MOLLIE_CLIENT_SECRET");
  if (!mollieClientId || !mollieClientSecret) return accountData.access_token;

  const tokenExpiresAt = new Date(accountData.token_expires_at);
  const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
  if (tokenExpiresAt > fiveMinutesFromNow) return accountData.access_token;

  if (!accountData.refresh_token) return accountData.access_token;

  try {
    const tokenResponse = await fetch("https://api.mollie.com/oauth2/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${btoa(`${mollieClientId}:${mollieClientSecret}`)}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: accountData.refresh_token,
      }),
    });

    if (!tokenResponse.ok) return accountData.access_token;

    const tokens = await tokenResponse.json();
    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    const tableName = entityType === "trainer" ? "trainer_mollie_accounts" : "academy_mollie_accounts";
    const idColumn = entityType === "trainer" ? "trainer_id" : "academy_profile_id";

    await supabaseClient
      .from(tableName)
      .update({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: newExpiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq(idColumn, entityId);

    return tokens.access_token;
  } catch {
    return accountData.access_token;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const mollieApiKey = Deno.env.get("MOLLIE_API_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json();
    const publicToken = typeof body?.publicToken === "string" ? body.publicToken.trim() : "";
    const invoiceId = typeof body?.invoiceId === "string" ? body.invoiceId : "";

    if (!publicToken) {
      return new Response(JSON.stringify({ error: "publicToken required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch invoice by public payment link token (no login required)
    const { data: invoice, error: invError } = await supabase
      .from("invoices")
      .select("id, invoice_number, total, player_name, player_id, trainer_id, academy_profile_id, status, mollie_payment_id, mollie_payment_url, public_token, public_token_revoked_at")
      .eq("public_token", publicToken)
      .single();

    if (!invError && invoice && invoiceId && invoice.id !== invoiceId) {
      return new Response(JSON.stringify({ error: "Invoice not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (invError || !invoice || invoice.public_token_revoked_at) {
      logStep("Invoice not found or revoked", { publicToken: publicToken.slice(0, 8) });
      return new Response(JSON.stringify({ error: "Invoice not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (invoice.status === "draft") {
      return new Response(JSON.stringify({ error: "draft_invoice" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (invoice.status === "paid" || invoice.status === "cancelled") {
      return new Response(JSON.stringify({ error: "invoice_locked" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const resolvedInvoiceId = invoice.id;

    // Note: existing payment URL check moved to after token resolution

    // Resolve Mollie access token — academy invoices use academy Mollie only (no trainer fallback)
    let accessToken: string | null = null;
    let recipientType: string | null = null;
    let mollieOrgId: string | null = null;
    let paymentUnavailableReason: MolliePaymentUnavailableReason | undefined;

    if (invoice.academy_profile_id) {
      const academyReadiness = await getAcademyMolliePaymentReadiness(
        supabase,
        invoice.academy_profile_id,
      );
      paymentUnavailableReason = academyReadiness.reason;
      if (academyReadiness.ready && academyReadiness.account) {
        accessToken = await refreshTokenIfNeeded(
          supabase,
          academyReadiness.account,
          "academy",
          invoice.academy_profile_id,
        );
        recipientType = "academy";
        mollieOrgId = academyReadiness.account.mollie_organization_id ?? null;
      }
    } else if (invoice.trainer_id) {
      const trainerReadiness = await getTrainerMolliePaymentReadiness(supabase, invoice.trainer_id);
      paymentUnavailableReason = trainerReadiness.reason;
      if (trainerReadiness.ready && trainerReadiness.account) {
        accessToken = await refreshTokenIfNeeded(
          supabase,
          trainerReadiness.account,
          "trainer",
          invoice.trainer_id,
        );
        recipientType = "trainer";
        mollieOrgId = trainerReadiness.account.mollie_organization_id ?? null;
      }
    } else {
      paymentUnavailableReason = "no_row";
    }

    if (!accessToken) {
      logStep("No connected Mollie account found", {
        invoiceId: resolvedInvoiceId,
        reason: paymentUnavailableReason,
        academyProfileId: invoice.academy_profile_id,
        trainerId: invoice.trainer_id,
      });

      await writeAuditLog(supabase, {
        function_name: "create-invoice-payment",
        invoice_id: resolvedInvoiceId,
        amount: invoice.total,
        status: "blocked_no_account",
        error_message: paymentUnavailableReason
          ? `No connected Mollie account (${paymentUnavailableReason})`
          : "No connected Mollie account",
        metadata: {
          invoiceNumber: invoice.invoice_number,
          reason: paymentUnavailableReason,
        },
      });

      return new Response(
        JSON.stringify({
          error: "no_mollie_account",
          message: "Payment account not connected.",
          reason: paymentUnavailableReason ?? "no_row",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const isTestMode = mollieApiKey.startsWith("test_");

    // Check if existing payment is still usable before creating a new one
    if (invoice.mollie_payment_url && invoice.mollie_payment_id && invoice.status !== "paid") {
      try {
        const testParam = isTestMode ? "?testmode=true" : "";
        const checkResp = await fetch(
          `https://api.mollie.com/v2/payments/${invoice.mollie_payment_id}${testParam}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (checkResp.ok) {
          const existing = await checkResp.json();
          if (existing.status === "open") {
            // M-11: only reuse the live payment if its amount STILL matches the
            // current invoice total. Editing a sent invoice, removing a session, or
            // a split rebalance changes the total while the pay link is alive —
            // reusing then charges the OLD amount and the webhook refuses to mark
            // it paid (amount mismatch), stranding the invoice as unpaid.
            const openValue = Number(existing.amount?.value);
            const invoiceTotal = Number(invoice.total);
            if (Number.isFinite(openValue) && Math.abs(openValue - invoiceTotal) <= 0.01) {
              logStep("Reusing existing open payment", { paymentId: invoice.mollie_payment_id });
              return new Response(JSON.stringify({ paymentUrl: invoice.mollie_payment_url, existing: true }), {
                status: 200,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
            // Amount drifted — cancel the stale open payment so the customer can no
            // longer pay the wrong total, then fall through to create a fresh one.
            logStep("Open payment amount mismatch — cancelling stale payment", {
              paymentId: invoice.mollie_payment_id, openValue, invoiceTotal,
            });
            try {
              await fetch(`https://api.mollie.com/v2/payments/${invoice.mollie_payment_id}${testParam}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${accessToken}` },
              });
            } catch (cancelErr) {
              logStep("Failed to cancel stale payment", { error: String(cancelErr) });
            }
          } else {
            logStep("Existing payment no longer open", { paymentId: invoice.mollie_payment_id, status: existing.status });
          }
        }
        // Stale / cancelled / amount-drifted — clear stored URL so a fresh payment is created
        await supabase.from("invoices")
          .update({ mollie_payment_url: null, mollie_payment_id: null })
          .eq("id", invoice.id);
        logStep("Cleared stale payment URL", { oldPaymentId: invoice.mollie_payment_id });
      } catch {
        logStep("Error checking existing payment, will create new");
      }
    }

    // Fetch Mollie profile ID (required for OAuth payments)
    let mollieProfileId: string | null = null;
    try {
      const profileResp = await fetch("https://api.mollie.com/v2/profiles", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (profileResp.ok) {
        const profileData = await profileResp.json();
        if (profileData._embedded?.profiles?.length > 0) {
          mollieProfileId = profileData._embedded.profiles[0].id;
          logStep("Mollie profile found", { profileId: mollieProfileId });
        }
      } else {
        logStep("Could not fetch Mollie profiles", { status: profileResp.status });
      }
    } catch (err) {
      logStep("Error fetching Mollie profiles", { error: String(err) });
    }

    if (!mollieProfileId) {
      logStep("No Mollie profile found", { invoiceId: resolvedInvoiceId });

      await writeAuditLog(supabase, {
        function_name: "create-invoice-payment",
        invoice_id: resolvedInvoiceId,
        recipient_type: recipientType,
        mollie_org_id: mollieOrgId,
        amount: invoice.total,
        status: "blocked_no_profile",
        error_message: "No Mollie profile found",
      });

      return new Response(JSON.stringify({ error: "missing_mollie_profile", message: "Payment profile not configured." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Build redirect URL
    const appUrl = Deno.env.get("APP_URL") || `https://padeltrainer.ai`;
    let redirectUrl: string;

    if (invoice.public_token && invoice.academy_profile_id) {
      // Fetch academy slug for branded URL
      const { data: academyData } = await supabase
        .from("academy_profiles")
        .select("slug")
        .eq("id", invoice.academy_profile_id)
        .single();
      const slug = academyData?.slug;
      redirectUrl = slug
        ? `${appUrl}/nl/academies/${slug}/pay/${invoice.public_token}?status=success`
        : `${appUrl}/pay/${invoice.public_token}?status=success`;
    } else if (invoice.public_token) {
      redirectUrl = `${appUrl}/pay/${invoice.public_token}?status=success`;
    } else {
      redirectUrl = `${appUrl}/app/booking-success?invoice=${invoice.invoice_number}`;
    }
    const webhookUrl = `${supabaseUrl}/functions/v1/mollie-webhook`;

    // Create Mollie payment
    const paymentBody: Record<string, unknown> = {
      amount: {
        currency: "EUR",
        value: invoice.total.toFixed(2),
      },
      description: `Factuur ${invoice.invoice_number}`,
      redirectUrl,
      webhookUrl,
      profileId: mollieProfileId,
      metadata: {
        invoice_id: invoice.id,
      },
    };

    if (isTestMode && accessToken) {
      paymentBody.testmode = true;
    }

    logStep("Creating Mollie payment", { invoiceNumber: invoice.invoice_number, amount: invoice.total, recipientType, mollieOrgId });

    const mollieRes = await fetch("https://api.mollie.com/v2/payments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(paymentBody),
    });

    if (!mollieRes.ok) {
      const errText = await mollieRes.text();
      logStep("Mollie payment creation failed", { error: errText });

      await writeAuditLog(supabase, {
        function_name: "create-invoice-payment",
        invoice_id: resolvedInvoiceId,
        recipient_type: recipientType,
        mollie_org_id: mollieOrgId,
        amount: invoice.total,
        status: "error",
        error_message: errText.slice(0, 500),
      });

      await notifySlack(supabase, "edge_function_error", {
        function: "create-invoice-payment",
        error: errText.slice(0, 300),
        invoiceNumber: invoice.invoice_number,
      });

      throw new Error(`Mollie error: ${errText}`);
    }

    const molliePayment = await mollieRes.json();
    const checkoutUrl = molliePayment._links?.checkout?.href;

    // Update invoice with payment info
    await supabase
      .from("invoices")
      .update({
        mollie_payment_id: molliePayment.id,
        mollie_payment_url: checkoutUrl,
      })
      .eq("id", invoice.id);

    logStep("Payment created", { paymentId: molliePayment.id, checkoutUrl, recipientType, mollieOrgId });

    // Write success audit log
    await writeAuditLog(supabase, {
      function_name: "create-invoice-payment",
      invoice_id: resolvedInvoiceId,
      recipient_type: recipientType,
      mollie_org_id: mollieOrgId,
      amount: invoice.total,
      status: "success",
      mollie_payment_id: molliePayment.id,
      metadata: { invoiceNumber: invoice.invoice_number, profileId: mollieProfileId },
    });

    // Slack notification for successful payment creation
    await notifySlack(supabase, "payment_created", {
      type: "invoice",
      invoiceNumber: invoice.invoice_number,
      recipientType,
      mollieOrgId,
      amount: `€${invoice.total.toFixed(2)}`,
      paymentId: molliePayment.id,
    });

    return new Response(JSON.stringify({ paymentUrl: checkoutUrl, paymentId: molliePayment.id }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
