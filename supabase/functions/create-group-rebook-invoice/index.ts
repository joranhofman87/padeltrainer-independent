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
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";
import { withTimeout } from "../_shared/edge-timeout.ts";

// Deadlines for downstream invokes so a HANG becomes a deterministic failure (release the captain's
// holds + alert) instead of a silent isolate kill that strands a strict seat with no invoice/payment.
const MINT_TIMEOUT_MS = 30_000;
const CHECKOUT_TIMEOUT_MS = 20_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

interface GroupInvoice { id: string; public_token: string; status: string; booking_ids?: string[] | null }

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
        .select("id, public_token, status, booking_ids")
        .eq("rebook_group_id", groupId)
        .neq("status", "cancelled")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return (data as GroupInvoice | null)?.public_token ? (data as GroupInvoice) : null;
    };

    /** ZOMBIE GUARD (mirrors create-rebook-invoice-public): an UNPAID group invoice whose bookings
     *  were ALL released by the TTL cron must never be re-served — cancel it and mint fresh. Never
     *  touches a paid invoice; fail-safe (treated as live) on a read error. */
    const isZombieInvoice = async (inv: GroupInvoice): Promise<boolean> => {
      const ids = inv.booking_ids ?? [];
      if (inv.status === "paid" || ids.length === 0) return false;
      const { data: live, error } = await admin
        .from("bookings").select("id").in("id", ids).neq("status", "cancelled").limit(1);
      if (error || live === null) return false;
      if (live.length > 0) return false;
      await admin.from("invoices").update({ status: "cancelled" }).eq("id", inv.id).neq("status", "paid");
      return true;
    };

    /** Best-effort Mollie checkout for an UNPAID invoice (paid invoices need none; the client falls
     *  back to the /pay/:token bank-transfer page with the same publicToken). */
    const startCheckout = async (inv: GroupInvoice): Promise<string | undefined> => {
      if (inv.status === "paid") return undefined;
      try {
        const { data: pay } = await withTimeout(admin.functions.invoke("create-invoice-payment", {
          body: { publicToken: inv.public_token, invoiceId: inv.id },
          headers: serviceAuth,
        }), CHECKOUT_TIMEOUT_MS, "create-invoice-payment");
        return (pay as { paymentUrl?: string })?.paymentUrl;
      } catch (_) { return undefined; }
    };

    const { token } = await req.json();
    if (!token || typeof token !== "string") return json({ ok: false, error: "token is required" }, 400);

    // Token gate: a valid, still-pending GROUP claim. The holder is the captain.
    const { data: claim } = await admin
      .from("slot_priority_claims")
      .select("id, player_id, guest_player_id, slot_id, rebook_group_id, status")
      .eq("claim_token", token)
      .maybeSingle();
    if (!claim) return json({ ok: false, error: "claim_not_found" }, 404);
    if (!claim.rebook_group_id) return json({ ok: false, reason: "not_a_group" });

    // Authoritative strict flag = the cycle's own setting (settings.rebook_strict_mollie), NOT just the
    // accept RPC's per-row `strict`. If the RPC ever fails to stamp `strict` on a strict cycle, deriving
    // it from acc.strict alone would silently bypass pay-first enforcement and leave a group seat
    // reserved without payment — so a strict cycle is ALWAYS treated as strict here (mirrors #442 on the
    // single-claim path). Resolved up front so the double-pay guard below can enforce strict too.
    const { data: gslot } = await admin
      .from("availability_slots").select("cyclus_id").eq("id", claim.slot_id).maybeSingle();
    const cyclusId = (gslot?.cyclus_id as string | null) ?? null;
    let cycleStrict = false;
    if (cyclusId) {
      const { data: cyc } = await admin.from("cycles").select("settings").eq("id", cyclusId).maybeSingle();
      cycleStrict = (cyc?.settings as { rebook_strict_mollie?: boolean } | null)?.rebook_strict_mollie === true;
    }

    // DOUBLE-PAY GUARD (sequential): the rebooking invite goes to EVERY group member, so any of them
    // can click "pay for the group". If this group already has an active invoice (someone paid-first,
    // or this caller returning), hand THAT one back — never mint a second. The unique partial index
    // on invoices(rebook_group_id) WHERE status<>'cancelled' makes a 2nd active invoice impossible.
    const existing = await activeGroupInvoice(claim.rebook_group_id);
    if (existing && !(await isZombieInvoice(existing))) {
      // Already PAID: success, not a failure — a teammate clicking after the captain paid must see
      // the paid state, never "couldn't start payment, no spot was reserved".
      if (existing.status === "paid") {
        return json({ ok: true, alreadyStarted: true, alreadyPaid: true, invoiceId: existing.id, publicToken: existing.public_token, status: existing.status });
      }
      const checkoutUrl = await startCheckout(existing);
      // STRICT: never return the bank-fallback publicToken without a live checkout — that would reserve a
      // seat with no online payment. Report strict_mollie_unavailable → the client offers a retry, not a
      // fallback. The seat is a TTL hold, so it self-releases if payment never completes.
      if (cycleStrict && !checkoutUrl) return json({ ok: false, reason: "strict_mollie_unavailable" });
      return json({ ok: true, alreadyStarted: true, invoiceId: existing.id, publicToken: existing.public_token, status: existing.status, checkoutUrl });
    }
    // (A zombie was cancelled above → fall through to a fresh accept + mint.)

    if (claim.status !== "pending") return json({ ok: false, reason: "already_responded", status: claim.status });

    // I1 CROSS-GUARD (audit): a member may have already PAID for just their own seat via the authed
    // just-my-spot path — those payments are NOT tagged to the group (no group invoice exists yet),
    // so the double-pay guard above can't see them. The captain's full-court payment would then
    // double-collect that seat. Refuse + alert LOUDLY; staff resolves (deducting a member's share is
    // a manual money decision, not an automatic one). Fail CLOSED on a check error — this guards money.
    // Members with a still-UNPAID invoice/checkout deliberately do NOT block the captain here (F05):
    // the mollie-webhook group-paid branch settles them the moment the captain's payment lands —
    // cancels their invoice, covers their seat paid-by-captain, and expires their open checkout.
    {
      const gq = admin.from("slot_priority_claims")
        .select("booking_id, player_id, guest_player_id")
        .eq("rebook_group_id", claim.rebook_group_id)
        .eq("status", "claimed")
        .not("booking_id", "is", null);
      const { data: claimedRows, error: gqErr } = await gq;
      if (gqErr) return json({ ok: false, reason: "retry" }, 503);
      const captainKey = claim.player_id ? `p:${claim.player_id}` : `g:${claim.guest_player_id}`;
      const otherBookingIds = (claimedRows ?? [])
        .filter((r: { player_id: string | null; guest_player_id: string | null }) =>
          (r.player_id ? `p:${r.player_id}` : `g:${r.guest_player_id}`) !== captainKey)
        .map((r: { booking_id: string | null }) => r.booking_id)
        .filter(Boolean) as string[];
      if (otherBookingIds.length > 0) {
        const { data: paidRows, error: pbErr } = await admin
          .from("bookings").select("id")
          .in("id", otherBookingIds)
          .eq("payment_status", "paid")
          .neq("status", "cancelled")
          .limit(1);
        if (pbErr) return json({ ok: false, reason: "retry" }, 503);
        if ((paidRows ?? []).length > 0) {
          await notifySlackEdgeError("create-group-rebook-invoice", "group pay refused: a member already paid for their own seat — captain full-court payment would double-collect", {
            token: token.slice(0, 8), groupId: claim.rebook_group_id,
          });
          return json({ ok: false, reason: "member_already_paid" });
        }
      }
    }

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
    // Authoritative from the cycle setting OR the RPC flag (either being true ⇒ strict), so a missing
    // per-row `strict` can never downgrade a strict cycle to a bank fallback.
    const strict = cycleStrict || acc.strict === true;

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

    /** Release the captain's just-booked HOLDS: cancel the bookings and reset their group claims to
     *  pending so the seat is free again (strict keeps NO seat without an online payment). */
    const releaseCaptainHolds = async (ids: string[]) => {
      await admin.from("bookings").update({ status: "cancelled" }).in("id", ids);
      await admin.from("slot_priority_claims")
        .update({ status: "pending", booking_id: null, responded_at: null })
        .eq("rebook_group_id", claim.rebook_group_id).in("booking_id", ids);
    };

    // After booking the captain's seats, a mint failure must RELEASE them on a STRICT cycle (no seat
    // without an online payment) and report strict_mollie_unavailable; a NON-strict cycle keeps the
    // seat as a reserved commitment. Either way, alert LOUDLY — this money-adjacent failure ("Mollie
    // won't load" / seat silently reserved) must never be invisible.
    const failAfterMint = async (reason: string): Promise<Response> => {
      await notifySlackEdgeError("create-group-rebook-invoice", `group rebook pay-first failed: ${reason}`, {
        token: token.slice(0, 8), groupId: claim.rebook_group_id, strict, reason,
      });
      if (strict) { await releaseCaptainHolds(bookingIds); return json({ ok: false, reason: "strict_mollie_unavailable" }); }
      // NON-strict: the captain's seats stay booked as a reserved commitment (the academy follows
      // up manually — it was alerted above). Tell the client explicitly so it can show the honest
      // "reserved, you'll receive an invoice" copy for THIS case only, and a real error otherwise.
      return json({ ok: false, reason, reserved: true });
    };

    // 3) Mint ONE invoice for the captain at the FULL court price. splitAmongPlayers:1 forces
    //    no-split: auto-create-invoice otherwise auto-detects a split from slot.split_payment=true
    //    (÷ court capacity, NOT payer count), which would bill the captain 1/capacity for the whole
    //    court in this pay-once-for-the-group model. (1 ⇒ helper returns null ⇒ full price.)
    //    A mint HANG must not run out the isolate's wall-clock (a silent kill would strand the strict
    //    holds); on timeout, fall through to the read-back — the invoice row may already exist (it is
    //    inserted before the slower PDF + email steps) — and only release if it truly didn't.
    let aci: unknown = null;
    let aciErr: unknown = null;
    let mintTimedOut = false;
    try {
      const r = await withTimeout(admin.functions.invoke("auto-create-invoice", {
        body: { bookingIds, asDraft: false, splitAmongPlayers: 1 },
        headers: serviceAuth,
      }), MINT_TIMEOUT_MS, "auto-create-invoice");
      aci = (r as { data: unknown }).data;
      aciErr = (r as { error: unknown }).error;
    } catch (_) {
      mintTimedOut = true;
    }
    if (!mintTimedOut) {
      if (aciErr) return await failAfterMint("mint_failed");
      if ((aci as { skipped?: boolean })?.skipped) {
        return await failAfterMint((aci as { reason?: string })?.reason ?? "business_incomplete");
      }
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
    if (!invoice?.public_token) return await failAfterMint(mintTimedOut ? "mint_timeout" : "no_invoice");

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
        // PAID winner (concurrent payment already completed) = success, not a strict failure.
        if (winner.status === "paid") {
          return json({ ok: true, alreadyStarted: true, alreadyPaid: true, invoiceId: winner.id, publicToken: winner.public_token, status: winner.status });
        }
        const checkoutUrl = await startCheckout(winner);
        // STRICT: never hand back the bank-fallback publicToken without a live checkout — that would
        // reserve a seat with no online payment. Mirrors the single-claim fn + the double-pay guard +
        // the main checkout-fail block below; this race branch was the one strict leak left open.
        if (strict && !checkoutUrl) return json({ ok: false, reason: "strict_mollie_unavailable" });
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
      await notifySlackEdgeError("create-group-rebook-invoice", "strict group rebook: Mollie checkout would not start — seats released", {
        token: token.slice(0, 8), groupId: claim.rebook_group_id, invoiceId: invoice.id,
      });
      await admin.from("invoices").update({ status: "cancelled" }).eq("id", invoice.id);
      await releaseCaptainHolds(bookingIds);
      return json({ ok: false, reason: "strict_mollie_unavailable" });
    }
    return json({ ok: true, invoiceId: invoice.id, publicToken: invoice.public_token, status: invoice.status, checkoutUrl });
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    await notifySlackEdgeError("create-group-rebook-invoice", message);
    return json({ ok: false, error: "internal_error", message }, 500);
  }
});
