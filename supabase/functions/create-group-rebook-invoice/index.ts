// Group-captain rebooking, Phase 3 (UPFRONT pay-first): the captain pays the fixed group/court
// price ONCE, BEFORE assigning the roster. We book ONLY the captain's own seat (their teammates'
// priority claims stay pending = the slot stays held), mint ONE invoice for the captain at the
// FULL unsplit price (price_per_session × weeks — invoicing only the captain's single-player
// bookings, so the split auto-detect never fires), and hand back a Mollie checkout. After paying,
// the captain assigns/changes the roster via rebook_group_manage (covered bookings).
//
// Token-gated (the claim_token is the capability) so it works for logged-OUT captains opening the
// email link; everything DB-side runs as the service role after the token check.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);
    const serviceAuth = { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey };

    const { token } = await req.json();
    if (!token || typeof token !== "string") return json({ ok: false, error: "token is required" }, 400);

    // Token gate: a valid, still-pending GROUP claim. The holder is the captain.
    const { data: claim } = await admin
      .from("slot_priority_claims")
      .select("id, player_id, guest_player_id, rebook_group_id, status")
      .eq("claim_token", token)
      .maybeSingle();
    if (!claim) return json({ ok: false, error: "claim_not_found" }, 404);
    if (!claim.rebook_group_id) return json({ ok: false, reason: "not_a_group" });
    if (claim.status !== "pending") return json({ ok: false, reason: "already_responded", status: claim.status });

    // 1) Book ONLY the captain's own seat (group accept filters to the captain's player); the
    //    teammates' claims stay 'pending' so the slot remains held for them.
    const { data: accepted, error: acceptErr } = await admin.rpc("respond_to_priority_claim", {
      _token: token, _action: "accept",
    });
    if (acceptErr) return json({ ok: false, reason: "accept_failed", message: String(acceptErr) });
    const acc = accepted as { ok?: boolean; reason?: string } | null;
    if (!acc?.ok) return json({ ok: false, reason: acc?.reason ?? "accept_failed" });

    // 2) Collect the captain's just-created booking ids (one per week).
    let q = admin.from("slot_priority_claims")
      .select("booking_id")
      .eq("rebook_group_id", claim.rebook_group_id)
      .eq("status", "claimed")
      .not("booking_id", "is", null);
    q = claim.player_id ? q.eq("player_id", claim.player_id) : q.eq("guest_player_id", claim.guest_player_id!);
    const { data: capClaims } = await q;
    const bookingIds = [...new Set((capClaims ?? []).map((r: { booking_id: string | null }) => r.booking_id).filter(Boolean))] as string[];
    if (bookingIds.length === 0) return json({ ok: false, reason: "nothing_booked" });

    // 3) Mint ONE invoice for the captain at the FULL price (OMIT splitAmongPlayers; single-player
    //    batch so the split auto-detect cannot fire) → price_per_session × weeks = the court price.
    const { data: aci, error: aciErr } = await admin.functions.invoke("auto-create-invoice", {
      body: { bookingIds, asDraft: false },
      headers: serviceAuth,
    });
    if (aciErr) return json({ ok: false, reason: "mint_failed", message: String(aciErr) });
    if ((aci as { skipped?: boolean })?.skipped) {
      return json({ ok: false, reason: (aci as { reason?: string })?.reason ?? "business_incomplete" });
    }

    // 4) Read back the invoice + its public pay token (handles fresh + deduped re-runs).
    const { data: invoice } = await admin
      .from("invoices")
      .select("id, public_token, status")
      .overlaps("booking_ids", bookingIds)
      .neq("status", "cancelled")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!invoice?.public_token) return json({ ok: false, reason: "no_invoice" });

    // 5) Create the Mollie checkout (best-effort). If unavailable, the client falls back to the
    //    /pay/:token bank-transfer page with the same publicToken.
    let checkoutUrl: string | undefined;
    try {
      const { data: pay } = await admin.functions.invoke("create-invoice-payment", {
        body: { publicToken: invoice.public_token, invoiceId: invoice.id },
        headers: serviceAuth,
      });
      checkoutUrl = (pay as { paymentUrl?: string })?.paymentUrl;
    } catch (_) { /* fall through to the invoice/bank-transfer page */ }

    return json({ ok: true, invoiceId: invoice.id, publicToken: invoice.public_token, status: invoice.status, checkoutUrl });
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    await notifySlackEdgeError("create-group-rebook-invoice", message);
    return json({ ok: false, error: "internal_error", message }, 500);
  }
});
