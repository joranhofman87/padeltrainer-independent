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

interface GroupInvoice { id: string; public_token: string; status: string }

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);
    const serviceAuth = { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey };

    /** The single active (non-cancelled) invoice tagged to this group, or null. The unique partial
     *  index on invoices(rebook_group_id) WHERE status<>'cancelled' guarantees at most one. */
    const activeGroupInvoice = async (groupId: string): Promise<GroupInvoice | null> => {
      const { data } = await admin
        .from("invoices")
        .select("id, public_token, status")
        .eq("rebook_group_id", groupId)
        .neq("status", "cancelled")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return (data as GroupInvoice | null)?.public_token ? (data as GroupInvoice) : null;
    };

    /** Best-effort Mollie checkout for an UNPAID invoice (paid invoices need none; the client falls
     *  back to the /pay/:token bank-transfer page with the same publicToken). */
    const startCheckout = async (inv: GroupInvoice): Promise<string | undefined> => {
      if (inv.status === "paid") return undefined;
      try {
        const { data: pay } = await admin.functions.invoke("create-invoice-payment", {
          body: { publicToken: inv.public_token, invoiceId: inv.id },
          headers: serviceAuth,
        });
        return (pay as { paymentUrl?: string })?.paymentUrl;
      } catch (_) { return undefined; }
    };

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

    // DOUBLE-PAY GUARD (sequential): the rebooking invite goes to EVERY group member, so any of them
    // can click "pay for the group". If this group already has an active invoice (someone paid-first,
    // or this caller returning), hand THAT one back — never mint a second. The unique partial index
    // on invoices(rebook_group_id) WHERE status<>'cancelled' makes a 2nd active invoice impossible.
    const existing = await activeGroupInvoice(claim.rebook_group_id);
    if (existing) {
      const checkoutUrl = await startCheckout(existing);
      return json({ ok: true, alreadyStarted: true, invoiceId: existing.id, publicToken: existing.public_token, status: existing.status, checkoutUrl });
    }

    if (claim.status !== "pending") return json({ ok: false, reason: "already_responded", status: claim.status });

    // 1) Book ONLY the captain's own seat (group accept filters to the captain's player); the
    //    teammates' claims stay 'pending' so the slot remains held for them.
    const { data: accepted, error: acceptErr } = await admin.rpc("respond_to_priority_claim", {
      _token: token, _action: "accept",
    });
    if (acceptErr) return json({ ok: false, reason: "accept_failed", message: String(acceptErr) });
    const acc = accepted as { ok?: boolean; reason?: string; strict?: boolean } | null;
    if (!acc?.ok) return json({ ok: false, reason: acc?.reason ?? "accept_failed" });
    // STRICT pay-first (A5): respond_to_priority_claim created the captain's seats as HOLDS (A2).
    // Strict has NO bank fallback, so a Mollie checkout MUST start below — else we abort + release.
    const strict = acc.strict === true;

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

    // 4) Read back the invoice + its public pay token (handles fresh + deduped re-runs). Scope to
    //    the captain's recipient identity — the captain's bookings are theirs alone, so this can
    //    only ever match the invoice we just minted, never another member's.
    let rb = admin
      .from("invoices")
      .select("id, public_token, status")
      .overlaps("booking_ids", bookingIds)
      .neq("status", "cancelled")
      .order("created_at", { ascending: false })
      .limit(1);
    rb = claim.player_id ? rb.eq("player_id", claim.player_id) : rb.eq("guest_player_id", claim.guest_player_id!);
    const { data: invoice } = await rb.maybeSingle();
    if (!invoice?.public_token) return json({ ok: false, reason: "no_invoice" });

    // 5) Tag the invoice to the group → discoverable by the double-pay guard + trips the unique
    //    partial index if a concurrent payer already won. On conflict (or any tag error): cancel our
    //    duplicate, undo the seat we just booked (back to pending so this member can pay the winning
    //    invoice instead), and hand back the winner — so exactly ONE invoice is ever payable.
    const { error: tagErr } = await admin.from("invoices")
      .update({ rebook_group_id: claim.rebook_group_id }).eq("id", invoice.id);
    if (tagErr) {
      // Lost the unique-index race (or a transient tag error). Our just-minted invoice must NEVER be
      // payable. Cancel it and VERIFY that succeeded before handing out any pay link — if the cancel
      // fails we surface an error and never expose this invoice's token (it stays dormant, link-less).
      const { error: cancelErr } = await admin.from("invoices")
        .update({ status: "cancelled" }).eq("id", invoice.id);
      if (cancelErr) return json({ ok: false, reason: "mint_conflict", message: String(cancelErr) });
      // Best-effort: release the seat we just booked so this member can pay the winning invoice.
      await admin.from("bookings").update({ status: "cancelled" }).in("id", bookingIds);
      await admin.from("slot_priority_claims")
        .update({ status: "pending", booking_id: null, responded_at: null })
        .eq("rebook_group_id", claim.rebook_group_id).in("booking_id", bookingIds);
      // Hand back the winner if it's already tagged; otherwise the client retries → the guard wins.
      const winner = await activeGroupInvoice(claim.rebook_group_id);
      if (winner) {
        const checkoutUrl = await startCheckout(winner);
        return json({ ok: true, alreadyStarted: true, invoiceId: winner.id, publicToken: winner.public_token, status: winner.status, checkoutUrl });
      }
      return json({ ok: false, reason: "retry" });
    }

    // 6) Create the Mollie checkout. Non-strict: best-effort — if unavailable, the client falls back
    //    to the /pay/:token bank-transfer page with the same publicToken. STRICT: mandatory — if no
    //    Mollie checkout could start, ABORT: cancel the invoice, cancel the captain's HOLDS, and reset
    //    their claims to pending (no seat without an online payment; no bank fallback).
    const checkoutUrl = await startCheckout(invoice as GroupInvoice);
    if (strict && !checkoutUrl) {
      await admin.from("invoices").update({ status: "cancelled" }).eq("id", invoice.id);
      await admin.from("bookings").update({ status: "cancelled" }).in("id", bookingIds);
      await admin.from("slot_priority_claims")
        .update({ status: "pending", booking_id: null, responded_at: null })
        .eq("rebook_group_id", claim.rebook_group_id).in("booking_id", bookingIds);
      return json({ ok: false, reason: "strict_mollie_unavailable" });
    }
    return json({ ok: true, invoiceId: invoice.id, publicToken: invoice.public_token, status: invoice.status, checkoutUrl });
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    await notifySlackEdgeError("create-group-rebook-invoice", message);
    return json({ ok: false, error: "internal_error", message }, 500);
  }
});
