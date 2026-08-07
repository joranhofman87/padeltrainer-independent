// Mint (or re-fetch) the payable invoice for a LOGGED-IN player who accepted an
// "upfront / pay directly" rebook but has no online (Mollie) checkout available —
// so they get an invoice with bank-transfer instructions instead of a dead-end.
//
// Security: the caller may only invoice their OWN bookings (every booking's
// player_id must resolve to the caller's profile). Minting itself runs as service
// role via auto-create-invoice (whose own auth is manager-only), AFTER that gate —
// the exact pattern create-registration-invoice uses for event registrations.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";
import { resolveSplitDivisorFromSlots } from "../_shared/booking-pricing.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ ok: false, error: "Authentication required" }, 401);

    const admin = createClient(supabaseUrl, serviceKey);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await admin.auth.getUser(token);
    if (authError || !user) return json({ ok: false, error: "Unauthorized" }, 401);

    const { bookingIds } = await req.json();
    const ids: string[] = Array.isArray(bookingIds) ? [...new Set(bookingIds.filter(Boolean))] : [];
    if (ids.length === 0) return json({ ok: false, error: "bookingIds is required" }, 400);

    const { data: profile } = await admin
      .from("profiles")
      .select("id")
      .eq("user_id", user.id)
      .single();
    if (!profile) return json({ ok: false, error: "No profile for caller" }, 403);

    // Ownership gate: every requested booking must belong to the caller, and be
    // still payable (a paid/cancelled booking must never be re-invoiced here).
    const { data: bookings } = await admin
      .from("bookings")
      .select("id, slot_id, player_id, payment_status, status")
      .in("id", ids);
    if (!bookings || bookings.length === 0) return json({ ok: false, error: "Bookings not found" }, 404);
    if (!bookings.every((b) => b.player_id === profile.id)) {
      return json({ ok: false, error: "Not your bookings" }, 403);
    }
    const payable = bookings.filter(
      (b) => b.payment_status === "pending" && ["pending", "confirmed"].includes(String(b.status)),
    );
    const payableIds = payable.map((b) => b.id);
    if (payableIds.length === 0) return json({ ok: false, reason: "nothing_payable" });

    // Split divisor — computed exactly like the Mollie upfront path (create-mollie-payment)
    // so the manual invoice equals what online checkout would charge. G5: on split_payment
    // slots, divide by the cycle's frozen COURT CAPACITY (max seats), NOT the live player
    // count — otherwise this fallback invoice would over-bill (÷ live players > ÷ capacity
    // when the group isn't full) and disagree with the Mollie charge. Without any split,
    // auto-create-invoice would bill the FULL price (an N× overcharge on shared cycles).
    const payableSlotIds = [...new Set(payable.map((b) => b.slot_id).filter(Boolean))] as string[];
    let splitAmongPlayers: number | undefined;
    if (payableSlotIds.length > 0) {
      const { data: slotRows } = await admin
        .from("availability_slots")
        .select("split_payment, max_participants")
        .in("id", payableSlotIds);
      if ((slotRows ?? []).some((s) => s.split_payment === true)) {
        const divisor = resolveSplitDivisorFromSlots(
          (slotRows ?? []) as { max_participants?: number | null }[],
        );
        if (divisor > 1) splitAmongPlayers = divisor;
      }
    }

    // Mint as service role. auto-create-invoice resolves academy ownership + line items
    // and with asDraft:false produces a 'sent' invoice (public_token via the column
    // default) + PDF (the email is sent separately below). It SKIPS a non-draft invoice
    // when the academy's invoice business profile is incomplete — return that reason.
    const serviceAuth = { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey };
    const { data: aci, error: aciErr } = await admin.functions.invoke("auto-create-invoice", {
      body: { bookingIds: payableIds, asDraft: false, ...(splitAmongPlayers ? { splitAmongPlayers } : {}) },
      headers: serviceAuth,
    });
    if (aciErr) return json({ ok: false, reason: "mint_failed", message: String(aciErr) });
    if (aci?.skipped) return json({ ok: false, reason: aci.reason ?? "business_incomplete" });

    // Read back the invoice covering these bookings (handles both fresh-create and
    // the idempotent existing-invoice case) to return its public pay token.
    const { data: invoice } = await admin
      .from("invoices")
      .select("id, public_token, status")
      .overlaps("booking_ids", payableIds)
      .neq("status", "cancelled")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!invoice?.public_token) return json({ ok: false, reason: "no_invoice" });

    // Email the invoice (PDF + pay link / bank-transfer instructions) to the player.
    // Non-blocking: the invoice already exists and is shown on /pay/{token}, so an
    // email hiccup must never fail the accept. Skip for an already-paid invoice.
    if (invoice.status !== "paid" && invoice.status !== "cancelled") {
      // Non-blocking, but NOT silent (Codex round-6 #4): supabase-js `functions.invoke` RESOLVES with
      // `error` set on a non-2xx (it does NOT throw), so the old bare try/catch swallowed a failed
      // invoice email entirely. Inspect BOTH the resolved error and any thrown error and alert — a
      // dropped bank-transfer invoice email otherwise leaves no trace (the invoice stays visible at
      // /pay/{token}, so we still never fail the accept on it).
      try {
        const { error: emailErr } = await admin.functions.invoke("send-invoice-email", { body: { invoiceId: invoice.id }, headers: serviceAuth });
        if (emailErr) {
          await notifySlackEdgeError("create-rebook-invoice", "send-invoice-email returned an error (non-blocking; invoice still at /pay/{token})", { invoiceId: invoice.id, error: String(emailErr.message ?? emailErr) });
        }
      } catch (e) {
        await notifySlackEdgeError("create-rebook-invoice", "send-invoice-email threw (non-blocking; invoice still at /pay/{token})", { invoiceId: invoice.id, error: String((e as Error)?.message ?? e) });
      }
    }

    return json({ ok: true, invoiceId: invoice.id, publicToken: invoice.public_token, status: invoice.status });
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    // Player-triggered, but the failure (no bank-transfer invoice minted) can strand an
    // accepted rebook — alert so the money-path break is never silent.
    await notifySlackEdgeError("create-rebook-invoice", message);
    return json({ ok: false, error: "internal_error", message }, 500);
  }
});
