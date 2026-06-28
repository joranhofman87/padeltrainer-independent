import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { amountsMatch, parseMollieAmountValue } from "../_shared/booking-pricing.ts";
import { evaluateForwardInvoiceWebhookResult } from "../_shared/forward-invoice-response.ts";
import {
  hasNoRoutableMetadata,
  parseMolliePaymentMetadata,
  usesInvoicePaidBranch,
} from "../_shared/mollie-webhook-metadata.ts";
import { runBookingPaidSideEffects } from "../_shared/mollie-booking-paid-side-effects.ts";
import {
  applyBookingPaymentWriteback,
  evaluateInvoicePayment,
  findCancelledPaidBookings,
  shouldRunBookingPaidSideEffects,
} from "../_shared/mollie-webhook-payment.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

async function refreshTokenIfNeeded(
  supabaseClient: any,
  accountData: any,
  entityType: 'trainer' | 'academy',
  entityId: string
): Promise<string | null> {
  const mollieClientId = Deno.env.get("MOLLIE_CLIENT_ID");
  const mollieClientSecret = Deno.env.get("MOLLIE_CLIENT_SECRET");

  if (!mollieClientId || !mollieClientSecret) {
    return accountData.access_token;
  }

  const tokenExpiresAt = new Date(accountData.token_expires_at);
  const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);

  if (tokenExpiresAt > fiveMinutesFromNow) {
    return accountData.access_token;
  }

  logStep("Token expired or expiring soon, refreshing");

  if (!accountData.refresh_token) {
    return accountData.access_token;
  }

  const tableName = entityType === 'trainer' ? 'trainer_mollie_accounts' : 'academy_mollie_accounts';
  const idColumn = entityType === 'trainer' ? 'trainer_id' : 'academy_profile_id';

  // Mollie refresh tokens are single-use (rotating). Claim the refresh so only
  // ONE concurrent webhook rotates the token; others skip and reuse the current
  // token (valid for the 5-min buffer, or the winner's freshly written one). The
  // 2-minute staleness window lets a crashed claim self-heal.
  const staleClaim = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const { data: claimRows } = await supabaseClient
    .from(tableName)
    .update({ token_refreshing_at: new Date().toISOString() })
    .eq(idColumn, entityId)
    .or(`token_refreshing_at.is.null,token_refreshing_at.lt.${staleClaim}`)
    .select('access_token');

  if (!claimRows || claimRows.length === 0) {
    const { data: fresh } = await supabaseClient
      .from(tableName)
      .select('access_token')
      .eq(idColumn, entityId)
      .maybeSingle();
    logStep("Token refresh already in progress — reusing current token");
    return fresh?.access_token ?? accountData.access_token;
  }

  try {
    const tokenResponse = await fetch('https://api.mollie.com/oauth2/tokens', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${btoa(`${mollieClientId}:${mollieClientSecret}`)}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: accountData.refresh_token,
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.json();
      logStep("Token refresh failed", errorData);
      // Release the claim so a later webhook can retry the refresh.
      await supabaseClient.from(tableName).update({ token_refreshing_at: null }).eq(idColumn, entityId);
      return accountData.access_token;
    }

    const tokens = await tokenResponse.json();
    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    await supabaseClient
      .from(tableName)
      .update({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: newExpiresAt,
        token_refreshing_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq(idColumn, entityId);

    logStep("Token refreshed successfully");
    return tokens.access_token;
  } catch (error) {
    logStep("Error refreshing token", { error: String(error) });
    await supabaseClient.from(tableName).update({ token_refreshing_at: null }).eq(idColumn, entityId);
    return accountData.access_token;
  }
}

async function resolveAccessToken(
  supabase: any,
  trainerId: string
): Promise<string | null> {
  // First check if trainer is part of an active academy
  const { data: academyTrainer } = await supabase
    .from("academy_trainers")
    .select("academy_profile_id, status")
    .eq("trainer_profile_id", trainerId)
    .eq("status", "active")
    .maybeSingle();

  if (academyTrainer?.academy_profile_id) {
    const { data: academyMollie } = await supabase
      .from("academy_mollie_accounts")
      .select("access_token, refresh_token, token_expires_at, charges_enabled")
      .eq("academy_profile_id", academyTrainer.academy_profile_id)
      .eq("onboarding_complete", true)
      .single();

    if (academyMollie?.access_token && academyMollie?.charges_enabled) {
      const token = await refreshTokenIfNeeded(supabase, academyMollie, 'academy', academyTrainer.academy_profile_id);
      if (token) {
        logStep("Using academy access token", { academyId: academyTrainer.academy_profile_id });
        return token;
      }
    }
  }

  // Check trainer's own Mollie account
  const { data: trainerMollie } = await supabase
    .from("trainer_mollie_accounts")
    .select("access_token, refresh_token, token_expires_at")
    .eq("trainer_id", trainerId)
    .eq("onboarding_complete", true)
    .single();

  if (trainerMollie?.access_token) {
    const token = await refreshTokenIfNeeded(supabase, trainerMollie, 'trainer', trainerId);
    if (token) {
      logStep("Using trainer access token", { trainerId });
      return token;
    }
  }

  return null;
}

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

    // Look up booking to find trainer for token resolution
    const { data: bookingForToken, error: bookingForTokenError } = await supabase
      .from("bookings")
      .select("slot_id, availability_slots!inner(trainer_id)")
      .eq("mollie_payment_id", paymentId)
      .limit(1)
      .maybeSingle();

    // A DB error here is transient, not "unroutable" — fail so Mollie retries
    // instead of refusing the payment forever below.
    if (bookingForTokenError) {
      throw new Error(`Booking lookup failed: ${bookingForTokenError.message}`);
    }

    const slotsData = bookingForToken?.availability_slots as unknown as { trainer_id: string } | null;
    const trainerId = slotsData?.trainer_id;
    let recipientAccessToken: string | null = null;

    if (trainerId) {
      recipientAccessToken = await resolveAccessToken(supabase, trainerId);
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
      // Deliberate refusal (M-25): a retry cannot connect a Mollie account,
      // so 200 (no retry) — we've alerted internally for manual follow-up.
      return new Response("OK", { status: 200 });
    }

    // Use platform key prefix only as a hint for whether to query test mode.
    // The actual API call is always made with the connected-account token.
    const platformKey = Deno.env.get("MOLLIE_API_KEY") ?? "";
    const isTestMode = platformKey.startsWith("test_");
    let fetchUrl = `https://api.mollie.com/v2/payments/${paymentId}`;
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
        }

        // Also sync linked bookings so dashboard shows correct payment status.
        // A transient failure here is retryable (flagged → 500 below): the
        // notify/forward side effects are claim-gated, so a Mollie retry only
        // re-runs this idempotent sync.
        let linkedBookingsSyncFailed = false;
        const { data: invoiceData, error: invoiceDataError } = await supabase
          .from("invoices")
          .select("booking_ids")
          .eq("id", invoiceIdFromMetadata)
          .single();

        if (invoiceDataError) {
          logStep("Failed to read linked bookings", { error: invoiceDataError.message, invoiceId: invoiceIdFromMetadata });
          linkedBookingsSyncFailed = true;
        }

        if (invoiceData?.booking_ids && invoiceData.booking_ids.length > 0) {
          const { error: bookingUpdateError } = await supabase
            .from("bookings")
            .update({
              payment_status: "paid",
              status: "confirmed",
              paid_at: new Date().toISOString(),
            })
            .in("id", invoiceData.booking_ids);

          if (bookingUpdateError) {
            logStep("Failed to update linked bookings", { error: bookingUpdateError.message });
            await notifySlackError(
              "mollie-webhook",
              "Invoice paid webhook: linked bookings sync failed",
              {
                paymentId,
                invoiceId: invoiceIdFromMetadata,
                bookingCount: invoiceData.booking_ids.length,
                error: bookingUpdateError.message,
              },
            );
            linkedBookingsSyncFailed = true;
          } else {
            logStep("Linked bookings updated to paid", { count: invoiceData.booking_ids.length });
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
      const sumTolerance = Math.max(0.01, bookingIds.length * 0.01);
      if (expectedSum > 0 && !amountsMatch(expectedSum, paidValue, sumTolerance)) {
        logStep("BLOCKED: Payment amount mismatch", { bookingIds, expectedSum, paidValue, sumTolerance });
        await notifySlackError("mollie-webhook", "Payment amount mismatch — bookings not marked paid", {
          bookingIds,
          expectedSum,
          paidValue,
          paymentId: payment.id,
        });
        // Deliberate refusal (M-25): retrying can never fix the amount.
        return new Response("OK", { status: 200 });
      }
    }

    const updateData: Record<string, unknown> = {
      payment_status: paymentStatus,
      status: bookingStatus,
      mollie_transaction_id: payment.id,
    };

    if (payment.status === "paid") {
      updateData.paid_at = new Date().toISOString();
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

    // If payment is paid, mark any matching priority claim as 'claimed'
    if (payment.status === "paid") {
      try {
        const { data: paidBookings } = await supabase
          .from("bookings")
          .select("id, slot_id, player_id, guest_player_id")
          .in("id", bookingIds);
        for (const b of paidBookings || []) {
          const orParts: string[] = [];
          if (b.player_id) orParts.push(`player_id.eq.${b.player_id}`);
          if (b.guest_player_id) orParts.push(`guest_player_id.eq.${b.guest_player_id}`);
          if (orParts.length === 0) continue;
          await supabase
            .from("slot_priority_claims")
            .update({ status: "claimed", responded_at: new Date().toISOString(), booking_id: b.id })
            .eq("slot_id", b.slot_id)
            .eq("status", "pending")
            .or(orParts.join(","));
        }
      } catch (e) {
        logStep("Failed to mark priority claim claimed (non-fatal)", { error: String(e) });
      }
    }

    // If payment is successful, auto-create invoice and send confirmation
    // email. E-15: gated on the atomic claim above — zero transitioned rows
    // means the bookings were already paid (duplicate delivery, or
    // verify-mollie-payment got there first and already ran the side effects).
    const bookingsAlreadyPaid = (transitionedRows?.length ?? 0) === 0;

    if (shouldRunBookingPaidSideEffects(payment.status, bookingsAlreadyPaid)) {
      await runBookingPaidSideEffects({
        supabase,
        bookingIds,
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
