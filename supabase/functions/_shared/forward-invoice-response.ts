/** Shared forward-invoice response types and webhook evaluation. */

export type ForwardInvoiceResponse = {
  success: boolean;
  sent?: number;
  failed?: number;
  reason?: string;
  skipped?: boolean;
  pdf_attached?: boolean;
  email_source?: string;
  invoice_number?: string;
  errors?: string[];
};

export function parseResendSendResult(
  data: { id?: string } | null | undefined,
  error: unknown,
): { ok: boolean; error?: string; resendId?: string } {
  if (error) {
    return { ok: false, error: typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error) };
  }
  if (!data?.id) {
    return { ok: false, error: "no_resend_id" };
  }
  return { ok: true, resendId: data.id };
}

export function countSendOutcomes(
  outcomes: Array<{ ok: boolean }>,
): { sent: number; failed: number } {
  const sent = outcomes.filter((o) => o.ok).length;
  return { sent, failed: outcomes.length - sent };
}

export type ForwardSendCompletion = {
  success: boolean;
  reason?: "partial_send" | "resend_failed";
  shouldSetForwardedAt: boolean;
};

/** All recipients must succeed with PDF attached before we mark forwarded_at. */
export function evaluateForwardSendCompletion(input: {
  sent: number;
  failed: number;
  totalRecipients: number;
  pdfAttached: boolean;
}): ForwardSendCompletion {
  const { sent, failed, totalRecipients, pdfAttached } = input;

  if (failed > 0) {
    return {
      success: false,
      reason: sent > 0 ? "partial_send" : "resend_failed",
      shouldSetForwardedAt: false,
    };
  }

  const fullDelivery = sent === totalRecipients && failed === 0 && pdfAttached;
  return {
    success: fullDelivery,
    shouldSetForwardedAt: fullDelivery,
  };
}

function forwardEvalContext(
  body: ForwardInvoiceResponse,
  base: { paymentId: string; invoiceId: string },
  sent: number,
  failed: number,
): Record<string, unknown> {
  return {
    ...base,
    sent,
    failed,
    reason: body.reason,
    pdf_attached: body.pdf_attached,
    email_source: body.email_source,
    invoice_number: body.invoice_number,
  };
}

export type ForwardWebhookEvaluation = {
  shouldWarn: boolean;
  logStep: string;
  slackMessage: string;
  context: Record<string, unknown>;
};

export function evaluateForwardInvoiceWebhookResult(
  data: ForwardInvoiceResponse | Record<string, unknown> | null,
  invokeError: unknown,
  context: { paymentId: string; invoiceId: string },
): ForwardWebhookEvaluation {
  if (invokeError) {
    return {
      shouldWarn: true,
      logStep: "forward_invoke_failed",
      slackMessage: "Invoice paid webhook: forward-invoice invoke failed",
      context: { ...context, error: String(invokeError) },
    };
  }

  const body = (data ?? {}) as ForwardInvoiceResponse;

  if (body.skipped === true) {
    return {
      shouldWarn: false,
      logStep: "forward_skipped",
      slackMessage: "",
      context: {
        ...context,
        reason: body.reason ?? "already_forwarded",
        invoice_number: body.invoice_number,
      },
    };
  }

  const sent = typeof body.sent === "number" ? body.sent : 0;
  const failed = typeof body.failed === "number" ? body.failed : 0;
  const evalContext = forwardEvalContext(body, context, sent, failed);

  if (failed > 0 || body.reason === "partial_send") {
    return {
      shouldWarn: true,
      logStep: body.reason === "partial_send" ? "forward_partial_send" : "forward_send_failures",
      slackMessage: body.reason === "partial_send"
        ? "Invoice paid webhook: forward-invoice partial delivery (not all bookkeeping recipients reached)"
        : "Invoice paid webhook: forward-invoice failed to send to one or more recipients",
      context: evalContext,
    };
  }

  if (body.success !== true) {
    return {
      shouldWarn: true,
      logStep: "forward_failed",
      slackMessage: "Invoice paid webhook: forward-invoice reported failure",
      context: { ...evalContext, reason: body.reason ?? "unknown" },
    };
  }

  if (sent === 0) {
    return {
      shouldWarn: true,
      logStep: "forward_zero_sent",
      slackMessage: "Invoice paid webhook: forward-invoice sent 0 emails",
      context: evalContext,
    };
  }

  if (body.pdf_attached === false) {
    return {
      shouldWarn: true,
      logStep: "forward_no_pdf",
      slackMessage: "Invoice paid webhook: forward-invoice without PDF attachment",
      context: evalContext,
    };
  }

  if (body.reason) {
    return {
      shouldWarn: true,
      logStep: "forward_reason_present",
      slackMessage: "Invoice paid webhook: forward-invoice completed with warning reason",
      context: evalContext,
    };
  }

  return {
    shouldWarn: false,
    logStep: "forward_success",
    slackMessage: "",
    context: evalContext,
  };
}
