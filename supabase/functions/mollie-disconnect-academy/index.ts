// F06 (audit): disconnect must NOT hard-delete the Mollie org row — in-flight payments
// (open checkout links on unpaid invoices, live booking holds mid-checkout) settle via
// mollie-webhook, which resolves the org token from THIS row. Deleting it made the
// webhook drop those payments with a deliberate 200 (no retry): money captured at
// Mollie, nothing settled here — stranded seat, unpaid invoice, manual refund each time.
//
// So instead:
//  1) REFUSE while open Mollie-linked invoices or live payment holds exist — the
//     manager settles or cancels them first (the response carries the counts);
//  2) then SOFT-disconnect: stamp disconnected_at, keeping the row + tokens so a late
//     webhook can still settle. Every charge path refuses a disconnected academy
//     (mollie-payment-ready / guest-payment / create-mollie-payment / the public
//     payment-ready RPC), and mollie-callback clears the stamp on reconnect.
//
// The OAuth grant is deliberately NOT revoked at Mollie: revocation would kill exactly
// the late-settlement ability this fix exists to preserve. The org owner can revoke the
// app's access from their Mollie dashboard at any time.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { corsHeaders, jsonForbidden, requireUser } from "../_shared/auth.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[MOLLIE-DISCONNECT-ACADEMY] ${step}`, details ? JSON.stringify(details) : "");
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authResult = await requireUser(req);
    if (authResult instanceof Response) return authResult;
    const { user, supabase: supabaseClient } = authResult;

    const { academyProfileId } = await req.json();
    if (!academyProfileId) throw new Error("Academy profile ID is required");

    const { data: academyManager } = await supabaseClient
      .from("academy_managers")
      .select("role")
      .eq("academy_profile_id", academyProfileId)
      .eq("user_id", user.id)
      .single();

    if (!academyManager) {
      return jsonForbidden("You are not a manager of this academy");
    }

    // GATE: refuse while money is in flight. Unpaid invoices with a minted Mollie payment
    // carry durable checkout links (a bank-transfer checkout stays payable for days), and a
    // live payment_pending hold means a customer is mid-checkout RIGHT NOW. Fail CLOSED on
    // a check error — this guards money.
    const { count: openInvoices, error: invoiceCheckError } = await supabaseClient
      .from("invoices")
      .select("id", { count: "exact", head: true })
      .eq("academy_profile_id", academyProfileId)
      .not("mollie_payment_id", "is", null)
      .not("status", "in", "(paid,cancelled)");
    if (invoiceCheckError) throw new Error("Failed to check open invoice payments");

    const { count: liveHolds, error: holdCheckError } = await supabaseClient
      .from("bookings")
      .select("id, availability_slots!inner(academy_profile_id)", { count: "exact", head: true })
      .eq("availability_slots.academy_profile_id", academyProfileId)
      .eq("status", "payment_pending")
      .gt("hold_expires_at", new Date().toISOString());
    if (holdCheckError) throw new Error("Failed to check live payment holds");

    if ((openInvoices ?? 0) > 0 || (liveHolds ?? 0) > 0) {
      logStep("Disconnect refused: open payments", { academyProfileId, openInvoices, liveHolds });
      // 200 + success:false (repo pattern): the client helper surfaces `error` verbatim
      // as the toast message, so the manager sees WHAT is blocking the disconnect.
      return new Response(JSON.stringify({
        success: false,
        reason: "open_payments",
        openInvoices: openInvoices ?? 0,
        liveHolds: liveHolds ?? 0,
        error: `Cannot disconnect yet: ${openInvoices ?? 0} unpaid invoice(s) with a live Mollie payment link and ${liveHolds ?? 0} booking(s) mid-payment. Settle or cancel these first, then try again.`,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    // Soft-disconnect. `.is("disconnected_at", null)` keeps the original stamp on a
    // repeat call; 0 updated rows (no account / already disconnected) is still success —
    // the end state the manager asked for holds either way.
    const { error: updateError } = await supabaseClient
      .from("academy_mollie_accounts")
      .update({ disconnected_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("academy_profile_id", academyProfileId)
      .is("disconnected_at", null);

    if (updateError) {
      logStep("Soft-disconnect failed", { error: updateError.message });
      throw new Error("Failed to disconnect payment account");
    }

    const { error: profileUpdateError } = await supabaseClient
      .from("academy_profiles")
      .update({ mollie_customer_id: null })
      .eq("id", academyProfileId);
    if (profileUpdateError) {
      // Non-blocking: account already disconnected, but stale customer id left behind — alert, don't fail the request.
      logStep("Profile update failed", { error: profileUpdateError.message });
      await notifySlackEdgeError("mollie-disconnect-academy", `academy_profiles mollie_customer_id clear failed: ${profileUpdateError.message}`, { academyProfileId });
    }

    logStep("Academy Mollie disconnected (soft)", { academyProfileId });

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    // Promote silent failure to Slack: Mollie payment-account disconnect failed.
    await notifySlackEdgeError("mollie-disconnect-academy", errorMessage);
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
