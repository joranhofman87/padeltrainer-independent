import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { refreshTokenIfNeeded as sharedRefreshTokenIfNeeded, resolveAccessToken as sharedResolveAccessToken } from "../_shared/mollie-token-resolution.ts";
import { amountsMatch, parseMollieAmountValue } from "../_shared/booking-pricing.ts";
import { evaluateForwardInvoiceWebhookResult } from "../_shared/forward-invoice-response.ts";
import {
  hasNoRoutableMetadata,
  parseMolliePaymentMetadata,
  usesInvoicePaidBranch,
} from "../_shared/mollie-webhook-metadata.ts";
import { runBookingPaidSideEffects, sendStaffBookingNotifications } from "../_shared/mollie-booking-paid-side-effects.ts";
import { sendPlayerBookingConfirmation } from "../_shared/booking-confirmation-email.ts";
import { writePaymentAuditLog as auditLog, PaymentAuditStatus as AUDIT } from "../_shared/payment-audit.ts";
import {
  applyBookingPaymentWriteback,
  bookingSumTolerance,
  detectPaymentReversal,
  evaluateInvoicePayment,
  findCancelledPaidBookings,
  shouldRunBookingPaidSideEffects,
} from "../_shared/mollie-webhook-payment.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MOLLIE_API_BASE = Deno.env.get("MOLLIE_API_BASE") ?? "https://api.mollie.com";

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[MOLLIE-WEBHOOK] ${step}`, details ? JSON.stringify(details) : "");
};

async function notifySlackError(functionName: string, errorMessage: string, context?: Record<string, unknown>) {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseKey) return;
    const supabase = createClient(supabaseUrl, supabaseKey);
    await supabase.functions.invoke("slack-notify", {
      body: {
        event: "edge_function_error",
        data: {
          function: functionName,
          error: errorMessage.slice(0, 500),
          ...context,
        },
      },
    });
  } catch (_) {
    // Silent — don't let Slack notification failure affect the webhook
  }
}

// Token resolution lives in _shared/mollie-token-resolution.ts (extracted verbatim —
// the nightly stuck-payment check needs the SAME org resolution). Local wrappers keep
// this file's call sites + log prefix unchanged.
const resolveAccessToken = (
  supabase: any,
  trainerId: string,
  slotAcademyProfileId?: string | null,
): Promise<string | null> => sharedResolveAccessToken(supabase, trainerId, slotAcademyProfileId, logStep);
const refreshTokenIfNeeded = (
  supabaseClient: any,
  accountData: any,
  entityType: 'trainer' | 'academy',
  entityId: string,
): Promise<string | null> => sharedRefreshTokenIfNeeded(supabaseClient, accountData, entityType, entityId, logStep);

// HTTP status contract (M-25): Mollie retries any non-200 response on a
// bounded backoff schedule, so the status code decides whether a failed
// delivery is retried or permanently dropped. We return:
//  - 200 for success AND for deliberate refusals that a retry can never fix
//    (missing payment id, unroutable metadata/no connected account, amount
//    mismatch, cancelled invoice, already-processed duplicate). These are
//    Slack-alerted for manual follow-up instead.
//  - 500 for transient infrastructure failures (DB read/write errors, Mollie
//    API fetch failures, unexpected exceptions) so Mollie retries and the
//    payment is not silently lost.
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Mollie sends payment ID in the body
    const formData = await req.formData();
    const paymentId = formData.get("id") as string;

    if (!paymentId) {
      // Malformed (non-Mollie) request — a retry would resend the same body.
      logStep("No payment ID in webhook");
      return new Response("OK", { status: 200 });
    }

    logStep("Webhook received", { paymentId });
    await auditLog(supabase, { function_name: "mollie-webhook", status: AUDIT.webhookReceived, mollie_payment_id: paymentId });

    // Look up booking to find trainer + academy for token resolution
    const { data: bookingForToken, error: bookingForTokenError } = await supabase
      .from("bookings")
      .select("slot_id, availability_slots!inner(trainer_id, academy_profile_id)")
      .eq("mollie_payment_id", paymentId)
      .limit(1)
      .maybeSingle();

    // A DB error here is transient, not "unroutable" — fail so Mollie retries
    // instead of refusing the payment forever below.
    if (bookingForTokenError) {
      throw new Error(`Booking lookup failed: ${bookingForTokenError.message}`);
    }

    const slotsData = bookingForToken?.availability_slots as unknown as
      { trainer_id: string; academy_profile_id: string | null } | null;
    const trainerId = slotsData?.trainer_id;
    let recipientAccessToken: string | null = null;

    if (trainerId) {
      // Pass the slot's academy so a multi-academy trainer resolves to the SAME org the
      // charge side used (Codex F3). All slots in a cyclus payment share this academy.
      recipientAccessToken = await resolveAccessToken(supabase, trainerId, slotsData?.academy_profile_id ?? null);
    }

    // If no token from booking, try resolving via invoice
    if (!recipientAccessToken) {
      const { data: invoiceForToken, error: invoiceForTokenError } = await supabase
        .from("invoices")
        .select("academy_profile_id, trainer_id")
        .eq("mollie_payment_id", paymentId)
        .maybeSingle();

      // Transient DB failure — retry, don't refuse as unroutable.
      if (invoiceForTokenError) {
        throw new Error(`Invoice lookup failed: ${invoiceForTokenError.message}`);
      }

      if (invoiceForToken) {
        if (invoiceForToken.academy_profile_id) {
          // Resolve directly from academy mollie account
          const { data: academyMollie } = await supabase
            .from("academy_mollie_accounts")
            .select("access_token, refresh_token, token_expires_at, charges_enabled")
            .eq("academy_profile_id", invoiceForToken.academy_profile_id)
            .eq("onboarding_complete", true)
            .single();

          if (academyMollie?.access_token && academyMollie?.charges_enabled) {
            const token = await refreshTokenIfNeeded(supabase, academyMollie, 'academy', invoiceForToken.academy_profile_id);
            if (token) {
              logStep("Using academy token from invoice lookup", { academyId: invoiceForToken.academy_profile_id });
              recipientAccessToken = token;
            }
          }
        }

        if (!recipientAccessToken && invoiceForToken.trainer_id) {
          // trainer_id on invoices is the trainer_profile_id
          recipientAccessToken = await resolveAccessToken(supabase, invoiceForToken.trainer_id);
          if (recipientAccessToken) {
            logStep("Using trainer token from invoice lookup", { trainerId: invoiceForToken.trainer_id });
          }
        }
      }
    }

    // SECURITY: Refuse to process if no connected-account token resolves.
    // Falling back to the platform API key would let an attacker forge metadata
    // on any payment in our Mollie OAuth app and have us flip arbitrary
    // bookings/invoices to "paid".
    if (!recipientAccessToken) {
      logStep("No connected-account token resolved, refusing to process", { paymentId, trainerId });
      await notifySlackError(
        "mollie-webhook",
        "Refused payment processing: no connected Mollie account resolved",
        { paymentId, trainerId },
      );
      await auditLog(supabase, { function_name: "mollie-webhook", status: AUDIT.noConnectedMollieAccount, mollie_payment_id: paymentId, metadata: { trainerId } });
      // Deliberate refusal (M-25): a retry cannot connect a Mollie account,
      // so 200 (no retry) — we've alerted internally for manual follow-up.
      return new Response("OK", { status: 200 });
    }

    // Use platform key prefix only as a hint for whether to query test mode.
    // The actual API call is always made with the connected-account token.
    const platformKey = Deno.env.get("MOLLIE_API_KEY") ?? "";
    const isTestMode = platformKey.startsWith("test_");
    let fetchUrl = `${MOLLIE_API_BASE}/v2/payments/${paymentId}`;
    if (isTestMode) {
      fetchUrl += "?testmode=true";
    }

    logStep("Fetching payment from Mollie", { useConnectedToken: true, isTestMode });

    // Fetch payment details from Mollie using the connected-account token only.
    const mollieResponse = await fetch(fetchUrl, {
      headers: {
        "Authorization": `Bearer ${recipientAccessToken}`,
      },
    });

    if (!mollieResponse.ok) {
      const errorText = await mollieResponse.text();
      throw new Error(`Failed to fetch payment: ${errorText}`);
    }

    const payment = await mollieResponse.json();
    logStep("Payment fetched", { 
      status: payment.status, 
      metadata: payment.metadata 
    });

    const { invoiceId: invoiceIdFromMetadata, bookingIds } = parseMolliePaymentMetadata(
      payment.metadata,
    );

    if (hasNoRoutableMetadata(invoiceIdFromMetadata, bookingIds)) {
      logStep("No booking IDs or invoice ID in payment metadata");
      return new Response("OK", { status: 200 });
    }

    // P2-5: a settled payment can be REVERSED (full chargeback flips status to
    // "charged_back"; a partial chargeback / refund keeps status "paid" but sets a
    // non-zero amountChargedBack / amountRefunded). None of the branches below act on
    // that: the invoice branch is status==="paid" only, and the booking writeback's
    // payment_status!="paid" guard leaves an already-paid booking untouched — so the
    // money is gone but the seat stays paid/confirmed with no alert. Do NOT auto-resurrect
    // or downgrade state (risks clobbering a re-payment / manual fix); surface it for
    // manual reconciliation only, mirroring the cancelled-invoice/cancelled-booking
    // manual-refund alerts, then 200 (a retry can never change a reversal).
    const reversal = detectPaymentReversal(payment);
    if (reversal.isReversal) {
      logStep("Payment REVERSED — manual reconciliation needed", {
        paymentId,
        kind: reversal.kind,
        chargedBackValue: reversal.chargedBackValue,
        refundedValue: reversal.refundedValue,
        invoiceId: invoiceIdFromMetadata,
        bookingIds,
      });
      await notifySlackError(
        "mollie-webhook",
        `Mollie payment REVERSED (${reversal.kind}) — money reversed but booking/invoice still marked paid. Manual refund/reconciliation needed.`,
        {
          paymentId,
          kind: reversal.kind,
          chargedBackValue: reversal.chargedBackValue,
          refundedValue: reversal.refundedValue,
          invoiceId: invoiceIdFromMetadata,
          bookingIds,
        },
      );
      await auditLog(supabase, {
        function_name: "mollie-webhook",
        status: reversal.kind === "refunded" ? AUDIT.paymentRefunded : AUDIT.paymentChargedBack,
        mollie_payment_id: paymentId,
        invoice_id: invoiceIdFromMetadata,
        booking_id: bookingIds[0] ?? null,
        amount: reversal.kind === "refunded" ? reversal.refundedValue : reversal.chargedBackValue,
        metadata: {
          kind: reversal.kind,
          chargedBackValue: reversal.chargedBackValue,
          refundedValue: reversal.refundedValue,
          bookingIds,
        },
      });
      // Deliberate refusal (M-25): a retry cannot un-reverse the payment. Returning here
      // guarantees NO automatic state change (no resurrection / no downgrade).
      return new Response("OK", { status: 200 });
    }

    // Handle invoice payments (create-invoice-payment); invoice_id takes priority over booking_ids
    if (usesInvoicePaidBranch(invoiceIdFromMetadata)) {
      logStep("invoice_paid_branch", {
        invoiceId: invoiceIdFromMetadata,
        metadataBookingCount: bookingIds.length,
      });
      if (payment.status === "paid") {
        // Fetch the invoice to (a) verify the paid amount matches the invoice
        // total before flipping to paid, and (b) detect whether it was already
        // paid so duplicate webhook deliveries don't re-fire notifications.
        const { data: invoiceForPay, error: invoiceForPayError } = await supabase
          .from("invoices")
          .select("total, status")
          .eq("id", invoiceIdFromMetadata)
          .maybeSingle();

        // M-25: a transient DB failure must not silently skip the amount and
        // cancelled-invoice guards (invoiceForPay would read as null) — fail
        // so Mollie retries.
        if (invoiceForPayError) {
          throw new Error(`Invoice guard lookup failed: ${invoiceForPayError.message}`);
        }

        // Money was taken for an invoice that no longer exists — a retry can
        // never fix that (M-25), so refuse with 200 and alert for manual review.
        if (!invoiceForPay) {
          logStep("BLOCKED: payment for unknown invoice", { invoiceId: invoiceIdFromMetadata, paymentId });
          await notifySlackError(
            "mollie-webhook",
            "Payment received for an unknown/deleted invoice — needs manual review",
            { paymentId, invoiceId: invoiceIdFromMetadata },
          );
          await auditLog(supabase, { function_name: "mollie-webhook", status: AUDIT.paymentForUnknownInvoice, mollie_payment_id: paymentId, invoice_id: invoiceIdFromMetadata });
          return new Response("OK", { status: 200 });
        }

        const expectedTotal = Number(invoiceForPay?.total) || 0;
        const paidValue = parseMollieAmountValue(payment.amount?.value);
        const invoiceAlreadyPaid = invoiceForPay?.status === "paid";
        const invoiceDecision = evaluateInvoicePayment(
          expectedTotal,
          paidValue,
          invoiceAlreadyPaid,
        );

        if (invoiceDecision.amountMismatch) {
          logStep("BLOCKED: Invoice payment amount mismatch", {
            invoiceId: invoiceIdFromMetadata,
            expectedTotal,
            paidValue,
          });
          await notifySlackError(
            "mollie-webhook",
            "Invoice payment amount mismatch — invoice not marked paid",
            { paymentId, invoiceId: invoiceIdFromMetadata, expectedTotal, paidValue },
          );
          await auditLog(supabase, { function_name: "mollie-webhook", status: AUDIT.amountMismatchBlocked, mollie_payment_id: paymentId, invoice_id: invoiceIdFromMetadata, amount: paidValue, metadata: { expectedTotal, paidValue } });
          // Deliberate refusal (M-25): retrying can never fix the amount.
          return new Response("OK", { status: 200 });
        }

        // A cancelled invoice must never resurrect to "paid" from a stale
        // checkout (e.g. a slow bank transfer completing after cancel/reissue).
        // Money was taken on a cancelled invoice → flag for a manual refund
        // instead of silently re-collecting.
        if (invoiceForPay?.status === "cancelled") {
          logStep("BLOCKED: payment for cancelled invoice", { invoiceId: invoiceIdFromMetadata, paidValue });
          await notifySlackError(
            "mollie-webhook",
            "Payment received for a CANCELLED invoice — needs manual refund/review",
            { paymentId, invoiceId: invoiceIdFromMetadata, paidValue },
          );
          await auditLog(supabase, { function_name: "mollie-webhook", status: AUDIT.paymentForCancelledInvoice, mollie_payment_id: paymentId, invoice_id: invoiceIdFromMetadata, amount: paidValue });
          // Deliberate refusal (M-25): retrying can never un-cancel the invoice.
          return new Response("OK", { status: 200 });
        }

        // E-15: this UPDATE is the atomic idempotency claim — only the request
        // that actually transitions the invoice to paid may notify and forward
        // to bookkeeping. The status predicates also close the read-then-act
        // race of the cancelled/already-paid checks above with a concurrent
        // cancel or duplicate delivery.
        const { data: claimedInvoiceRows, error: invUpdateError } = await supabase
          .from("invoices")
          .update({ status: "paid", paid_at: new Date().toISOString(), mollie_payment_id: paymentId })
          .eq("id", invoiceIdFromMetadata)
          .neq("status", "paid")
          .neq("status", "cancelled")
          .select("id, invoice_number, total");
        if (invUpdateError) {
          logStep("Failed to update invoice", { error: invUpdateError.message, invoiceId: invoiceIdFromMetadata });
          await notifySlackError(
            "mollie-webhook",
            "Invoice paid webhook: DB update failed",
            { paymentId, invoiceId: invoiceIdFromMetadata, error: invUpdateError.message },
          );
          // M-25: transient DB failure and the invoice was NOT marked paid —
          // 500 so Mollie retries with a full, safe reprocess.
          return new Response("Internal Server Error", { status: 500 });
        }

        const claimedPaidTransition = (claimedInvoiceRows?.length ?? 0) > 0;

        if (claimedPaidTransition) {
          logStep("Invoice marked as paid via payment link", { invoiceId: invoiceIdFromMetadata });
          await auditLog(supabase, { function_name: "mollie-webhook", status: AUDIT.invoiceMarkedPaid, mollie_payment_id: paymentId, invoice_id: invoiceIdFromMetadata, amount: paidValue });

          // Only notify on the first transition to paid (the claim above) —
          // duplicate deliveries must not re-send payment_received.
          try {
            const paidInvoice = claimedInvoiceRows?.[0];
            await supabase.functions.invoke("slack-notify", {
              body: {
                event: "payment_received",
                data: {
                  type: "invoice",
                  invoice_number: paidInvoice?.invoice_number ?? "unknown",
                  amount: paidInvoice?.total != null
                    ? `€${Number(paidInvoice.total).toFixed(2)}`
                    : (payment.amount?.value ? `€${payment.amount.value}` : "?"),
                  payment_id: paymentId,
                },
              },
            });
          } catch (slackErr) {
            logStep("Slack payment_received failed (non-fatal)", { error: String(slackErr) });
          }
        } else {
          logStep("Invoice already paid — duplicate delivery, notifications skipped", {
            invoiceId: invoiceIdFromMetadata,
          });
          await auditLog(supabase, { function_name: "mollie-webhook", status: AUDIT.duplicateWebhookIgnored, mollie_payment_id: paymentId, invoice_id: invoiceIdFromMetadata });
        }

        // Also sync linked bookings so dashboard shows correct payment status.
        // A transient failure here is retryable (flagged → 500 below): the
        // notify/forward side effects are claim-gated, so a Mollie retry only
        // re-runs this idempotent sync.
        let linkedBookingsSyncFailed = false;
        const { data: invoiceData, error: invoiceDataError } = await supabase
          .from("invoices")
          .select("booking_ids, rebook_cyclus_id, rebook_group_id")
          .eq("id", invoiceIdFromMetadata)
          .single();

        if (invoiceDataError) {
          logStep("Failed to read linked bookings", { error: invoiceDataError.message, invoiceId: invoiceIdFromMetadata });
          linkedBookingsSyncFailed = true;
        }

        if (invoiceData?.booking_ids && invoiceData.booking_ids.length > 0) {
          try {
            // Detect a paid invoice landing on a CANCELLED booking before the
            // guarded write-back skips it: the money was received but the seat
            // is gone → alert for a manual refund (mirrors the booking-pay branch).
            const { data: linkedRows } = await supabase
              .from("bookings")
              .select("id, status, payment_status")
              .in("id", invoiceData.booking_ids);
            const cancelledPaid = findCancelledPaidBookings(linkedRows || []);
            if (cancelledPaid.length > 0) {
              logStep("Invoice paid on CANCELLED booking(s) — manual refund needed", {
                cancelledPaid,
                invoiceId: invoiceIdFromMetadata,
              });
              await notifySlackError(
                "mollie-webhook",
                "Invoice paid webhook: payment landed on cancelled booking(s) — manual refund/review",
                { paymentId, invoiceId: invoiceIdFromMetadata, bookingIds: cancelledPaid },
              );
            }

            // Guarded write-back: NEVER resurrect a cancelled booking, never
            // downgrade an already-paid one. Routes through the same helper the
            // booking-pay branch uses — previously this branch did a RAW
            // unguarded .update(), which could flip a cancelled booking back to
            // paid/confirmed (the no-resurrection invariant held for the booking
            // branch but not here).
            const updated = await applyBookingPaymentWriteback(supabase, invoiceData.booking_ids, {
              payment_status: "paid",
              status: "confirmed",
              paid_at: new Date().toISOString(),
              hold_expires_at: null, // (A5) a committed strict GROUP hold is no longer a hold
            });
            logStep("Linked bookings updated to paid (guarded)", {
              requested: invoiceData.booking_ids.length,
              transitioned: updated.length,
            });
          } catch (bookingUpdateError) {
            const msg = bookingUpdateError instanceof Error
              ? bookingUpdateError.message
              : String(bookingUpdateError);
            logStep("Failed to update linked bookings", { error: msg });
            await notifySlackError(
              "mollie-webhook",
              "Invoice paid webhook: linked bookings sync failed",
              {
                paymentId,
                invoiceId: invoiceIdFromMetadata,
                bookingCount: invoiceData.booking_ids.length,
                error: msg,
              },
            );
            linkedBookingsSyncFailed = true;
          }
        }

        // Forward invoice to bookkeeping emails (non-fatal — paid status already saved).
        // E-15: only on the first paid transition —
        // forward-invoice's own forwarded_at guard is read-then-act, so
        // concurrent duplicate deliveries could double-send the bookkeeping
        // email without this claim gate.
        if (claimedPaidTransition) {
          try {
            logStep("forward_invoice_invoke", { invoiceId: invoiceIdFromMetadata, paymentId });
            const forwardRes = await supabase.functions.invoke("forward-invoice", {
              body: { invoiceId: invoiceIdFromMetadata },
              headers: {
                Authorization: `Bearer ${supabaseServiceKey}`,
                apikey: supabaseServiceKey,
              },
            });
            const forwardEval = evaluateForwardInvoiceWebhookResult(
              forwardRes.data as Record<string, unknown> | null,
              forwardRes.error,
              { paymentId, invoiceId: invoiceIdFromMetadata },
            );
            logStep(forwardEval.logStep, forwardEval.context);
            if (forwardEval.shouldWarn) {
              await notifySlackError(
                "mollie-webhook",
                forwardEval.slackMessage,
                forwardEval.context,
              );
            }
          } catch (fwdErr) {
            logStep("forward_invoke_exception", { error: String(fwdErr), paymentId, invoiceId: invoiceIdFromMetadata });
            await notifySlackError(
              "mollie-webhook",
              "Invoice paid webhook: forward-invoice failed",
              { paymentId, invoiceId: invoiceIdFromMetadata, error: String(fwdErr) },
            );
          }

          // REBOOK pay-first: this is an INVOICE payment, so the booking-paid confirmation path never
          // runs and the payer would otherwise hear nothing. Send them their confirmation here —
          // sessions + the paid invoice PDF + a sign-in link (guest → signup, registered → login) —
          // reusing the same composer as public bookings. Scoped to rebook invoices (tagged
          // rebook_cyclus_id / rebook_group_id) + claim-gated so a duplicate delivery never re-sends.
          if (
            (invoiceData?.rebook_cyclus_id || invoiceData?.rebook_group_id) &&
            invoiceData?.booking_ids && invoiceData.booking_ids.length > 0
          ) {
            try {
              const confirmation = await sendPlayerBookingConfirmation({
                // cast: the shared composer types SupabaseClient from `@2` while this fn pins
                // `@2.57.2` — a pure version-identity mismatch (same client at runtime).
                supabase: supabase as unknown as Parameters<typeof sendPlayerBookingConfirmation>[0]["supabase"],
                bookingIds: invoiceData.booking_ids,
                invoiceId: invoiceIdFromMetadata,
                logStep,
              });
              if (!confirmation.ok) {
                // Alert on EVERY non-send, not just recipient-resolution failures. The silent
                // reasons (no_resend = RESEND_API_KEY unset, send_failed = Resend rejected) are
                // exactly what hides a "paid but no confirmation email" — surface them all so a
                // missing rebook email is never invisible again.
                await notifySlackError(
                  "mollie-webhook",
                  "Rebook paid: player confirmation not sent",
                  { paymentId, invoiceId: invoiceIdFromMetadata, reason: confirmation.reason },
                );
              }
            } catch (confErr) {
              logStep("rebook_confirmation_exception", { error: String(confErr), paymentId, invoiceId: invoiceIdFromMetadata });
              await notifySlackError(
                "mollie-webhook",
                "Rebook paid: player confirmation threw",
                { paymentId, invoiceId: invoiceIdFromMetadata, error: String(confErr) },
              );
            }

            // Staff notification: tell the academy managers (with the amount) + the involved
            // trainers (their own sessions, no amount) that a rebooking was paid — the same
            // deduped notice a public booking sends. The booking-paid side-effects path never
            // runs for an INVOICE payment, so this is the only place it can fire; claim-gated
            // above so a duplicate webhook delivery can't re-send. Non-fatal (helper alerts Slack
            // on its own failures). For a group-captain invoice, booking_ids spans the whole group
            // (one academy) → the manager gets one email with every session + the captain's total.
            try {
              const { data: payerRow } = await supabase
                .from("bookings")
                .select("profiles:player_id(full_name), guest_players:guest_player_id(full_name)")
                .eq("id", invoiceData.booking_ids[0])
                .maybeSingle();
              const payer = payerRow as
                | { profiles?: { full_name?: string | null } | null; guest_players?: { full_name?: string | null } | null }
                | null;
              const playerName = payer?.profiles?.full_name ?? payer?.guest_players?.full_name ?? "Speler";
              await sendStaffBookingNotifications({
                supabase: supabase as unknown as Parameters<typeof sendStaffBookingNotifications>[0]["supabase"],
                bookingIds: invoiceData.booking_ids,
                playerName,
                paymentAmountValue: payment.amount?.value,
                source: "mollie-webhook-rebook",
                logStep,
                notifySlackError,
              });
            } catch (staffErr) {
              logStep("rebook_staff_notify_exception", { error: String(staffErr), paymentId, invoiceId: invoiceIdFromMetadata });
              await notifySlackError(
                "mollie-webhook",
                "Rebook paid: staff notification threw",
                { paymentId, invoiceId: invoiceIdFromMetadata, error: String(staffErr) },
              );
            }
          }
        }

        if (linkedBookingsSyncFailed) {
          // M-25: transient DB failure while syncing linked bookings — 500 so
          // Mollie retries. Safe: notify + forward above ran (claim-gated) on
          // this request; the retry only re-runs the idempotent sync.
          return new Response("Internal Server Error", { status: 500 });
        }
      }
      return new Response("OK", { status: 200 });
    }

    // Map Mollie status to our payment status
    let paymentStatus: string;
    let bookingStatus: string;

    switch (payment.status) {
      case "paid":
        paymentStatus = "paid";
        bookingStatus = "confirmed";
        break;
      case "failed":
      case "canceled":
      case "expired":
        paymentStatus = "failed";
        bookingStatus = "cancelled";
        break;
      case "pending":
      case "open":
        paymentStatus = "pending";
        bookingStatus = "pending";
        break;
      default:
        paymentStatus = "pending";
        bookingStatus = "pending";
    }

    logStep("Updating bookings", { bookingIds, paymentStatus, bookingStatus });

    if (payment.status === "paid") {
      const { data: amountRows, error: amountRowsError } = await supabase
        .from("bookings")
        .select("id, payment_amount, status, payment_status")
        .in("id", bookingIds);

      // M-25: a transient DB failure must not silently skip the amount check
      // (expectedSum would be 0) — fail so Mollie retries.
      if (amountRowsError) {
        throw new Error(`Booking amount lookup failed: ${amountRowsError.message}`);
      }

      // A paid payment landing on a CANCELLED booking (e.g. the BookLesson
      // online-cycle rollback soft-cancelled it after a payment-creation hiccup,
      // then the payment completed out of band). applyBookingPaymentWriteback's
      // status!='cancelled' guard refuses to resurrect it — but the money WAS
      // received, so surface it for a manual refund / review instead of letting
      // a real payment vanish silently.
      const cancelledPaid = findCancelledPaidBookings(amountRows || []);
      if (cancelledPaid.length > 0) {
        logStep("Paid payment on CANCELLED booking(s) — manual refund needed", { cancelledPaid, paymentId: payment.id });
        await notifySlackError("mollie-webhook", "Paid Mollie payment landed on CANCELLED booking(s) — money received, no active booking. Manual refund / review needed.", {
          bookingIds: cancelledPaid,
          paymentId: payment.id,
        });
        await auditLog(supabase, { function_name: "mollie-webhook", status: AUDIT.paymentForCancelledBooking, mollie_payment_id: payment.id, booking_id: cancelledPaid[0], metadata: { bookingIds: cancelledPaid } });
      }

      const expectedSum = (amountRows || []).reduce(
        (sum, b) => sum + (Number(b.payment_amount) || 0),
        0,
      );
      const paidValue = parseMollieAmountValue(payment.amount?.value);

      // Tolerance scales with booking count: per-booking amounts are stored to
      // the cent, so the sum can legitimately differ from the charged total by
      // up to ~half a cent per booking. A flat 1ct tolerance wrongly rejected
      // legitimate multi-session cyclus payments (money taken, booking stuck).
      const sumTolerance = bookingSumTolerance(bookingIds.length);
      if (expectedSum > 0 && !amountsMatch(expectedSum, paidValue, sumTolerance)) {
        logStep("BLOCKED: Payment amount mismatch", { bookingIds, expectedSum, paidValue, sumTolerance });
        await notifySlackError("mollie-webhook", "Payment amount mismatch — bookings not marked paid", {
          bookingIds,
          expectedSum,
          paidValue,
          paymentId: payment.id,
        });
        await auditLog(supabase, { function_name: "mollie-webhook", status: AUDIT.amountMismatchBlocked, mollie_payment_id: payment.id, booking_id: bookingIds[0], amount: paidValue, metadata: { bookingIds, expectedSum, paidValue } });
        // Deliberate refusal (M-25): retrying can never fix the amount.
        return new Response("OK", { status: 200 });
      }
    }

    // (A4 strict rebook) For a failed/canceled/expired payment, a payment_pending HOLD must
    // release its seat AND re-offer its claim. Capture the holds BEFORE the write-back cancels
    // them; scoped to status='payment_pending' so the non-strict upfront flow is unchanged.
    let strictHoldIds: string[] = [];
    if (paymentStatus === "failed") {
      const { data: holdRows } = await supabase
        .from("bookings")
        .select("id")
        .in("id", bookingIds)
        .eq("status", "payment_pending");
      strictHoldIds = (holdRows ?? []).map((b: { id: string }) => b.id);
    }

    const updateData: Record<string, unknown> = {
      payment_status: paymentStatus,
      status: bookingStatus,
      mollie_transaction_id: payment.id,
    };

    if (payment.status === "paid") {
      updateData.paid_at = new Date().toISOString();
      updateData.hold_expires_at = null; // (A4) a committed strict hold is no longer a hold
    }

    // Never un-confirm or downgrade a booking that's already PAID — for ANY
    // webhook status. A stale `open`/`pending` delivery arriving after the paid
    // one must not reset the booking to pending, and a later failed/expired
    // delivery must not cancel an out-of-band (cash) paid booking. For the paid
    // transition the same `payment_status != 'paid'` predicate doubles as the
    // atomic idempotency claim (E-15): only rows still unpaid are transitioned,
    // and the returned rows tell us whether THIS request performed the
    // transition — duplicate concurrent deliveries (or a verify-mollie-payment
    // race) then cannot double-run the side effects below. The guard now lives
    // in applyBookingPaymentWriteback so it is unconditional + unit-tested.
    const transitionedRows = await applyBookingPaymentWriteback(
      supabase,
      bookingIds,
      updateData,
    );

    logStep("Bookings updated successfully", {
      count: bookingIds.length,
      transitioned: transitionedRows.length,
    });
    if (payment.status === "paid") {
      await auditLog(supabase, {
        function_name: "mollie-webhook",
        status: transitionedRows.length > 0 ? AUDIT.bookingMarkedPaid : AUDIT.duplicateWebhookIgnored,
        mollie_payment_id: payment.id,
        booking_id: bookingIds[0],
        metadata: { bookingIds, transitioned: transitionedRows.length },
      });
    }

    // (A4 strict rebook) A failed/canceled/expired payment just cancelled these strict holds —
    // reset their priority claims to 'pending' so the seat is re-offerable (mirror
    // release_rebook_hold + the expiry cron). Non-fatal: the cron is the backstop.
    if (strictHoldIds.length > 0) {
      try {
        await supabase
          .from("slot_priority_claims")
          .update({ status: "pending", booking_id: null, responded_at: null })
          .in("booking_id", strictHoldIds)
          .eq("status", "claimed");
        logStep("Re-offered strict-hold claim(s) after failed payment", { count: strictHoldIds.length });
      } catch (e) {
        logStep("Failed to re-offer strict-hold claim (non-fatal)", { error: String(e) });
      }
    }

    // P2-12: claim finalization moved into runBookingPaidSideEffects (below) so
    // verify-mollie-payment settles the claim too, not just the webhook. Keyed off
    // the SURVIVOR/transitioned ids there — do NOT re-run it here (would double-run).

    // If payment is successful, auto-create invoice and send confirmation
    // email. E-15: gated on the atomic claim above — zero transitioned rows
    // means the bookings were already paid (duplicate delivery, or
    // verify-mollie-payment got there first and already ran the side effects).
    const bookingsAlreadyPaid = (transitionedRows?.length ?? 0) === 0;

    if (shouldRunBookingPaidSideEffects(payment.status, bookingsAlreadyPaid)) {
      // P1-4: key side-effects (auto-create-invoice + confirmation email/Slack)
      // off the SURVIVOR/transitioned ids — NOT the raw metadata list. On an
      // M-17 collision the colliding hold was cancelled and its survivor stamped
      // paid; pulling the raw metadata id in would invoice/email a cancelled row.
      const paidIds = transitionedRows.map((r) => r.id);
      await runBookingPaidSideEffects({
        supabase,
        bookingIds: paidIds.length > 0 ? paidIds : bookingIds,
        paymentAmountValue: payment.amount?.value,
        source: "mollie-webhook",
        logStep,
        notifySlackError,
      });
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    await notifySlackError("mollie-webhook", message);
    // M-25: anything that lands here is a transient/unexpected failure
    // (DB error, Mollie fetch failure, crash) — 500 so Mollie retries.
    // Deliberate refusals return 200 explicitly above.
    return new Response("Internal Server Error", { status: 500 });
  }
});
