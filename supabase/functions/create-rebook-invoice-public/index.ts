// Slice A — UPFRONT no-login SINGLE-claim rebook payment. A player rebooking JUST themselves (no
// group) pays their OWN full cycle at checkout WITHOUT logging in. Token-gated (the claim_token is the
// capability); everything DB-side runs as the service role after the token check. Mirrors
// create-group-rebook-invoice, but scopes to the claimant's cyclus-wide claims (by identity, not a
// group) and mints ONE full-price invoice over only the claimant's own bookings.
//
// Lifecycle (see docs/audits/SLICE_A_NOLOGIN_REBOOK_PAYMENT_DESIGN.md): claims are marked 'claimed'
// at ACCEPT here (respond_to_priority_claim), NOT by the webhook. Full price is structural — a single
// claimant identity means auto-create-invoice's split auto-detect cannot fire. Idempotency is the
// unique partial index on invoices.rebook_cyclus_id (one active invoice per claimant+cyclus).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";
import { withTimeout } from "../_shared/edge-timeout.ts";

// Deadlines for downstream invokes so a HANG becomes a deterministic failure (release seats + alert)
// instead of a silent isolate kill that strands a strict HOLD with no invoice/payment. Well under the
// platform wall-clock; well over the normal path (auto-create-invoice mints in ~1-3s, then does PDF +
// bookkeeper email — the mint row exists before those, so a timeout falls through to the read-back).
const MINT_TIMEOUT_MS = 30_000;
const CHECKOUT_TIMEOUT_MS = 20_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

interface RebookInvoice { id: string; public_token: string; status: string }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);
    const serviceAuth = { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey };

    /** The single active (non-cancelled) rebook invoice for this claimant + cyclus, or null. The
     *  unique partial index on invoices(rebook_cyclus_id, COALESCE(player_id, guest_player_id)) WHERE
     *  status<>'cancelled' guarantees at most one. */
    const activeRebookInvoice = async (
      cyclusId: string, playerId: string | null, guestId: string | null,
    ): Promise<RebookInvoice | null> => {
      let q = admin.from("invoices")
        .select("id, public_token, status")
        .eq("rebook_cyclus_id", cyclusId)
        .neq("status", "cancelled")
        .order("created_at", { ascending: false })
        .limit(1);
      q = playerId ? q.eq("player_id", playerId) : q.eq("guest_player_id", guestId!);
      const { data } = await q.maybeSingle();
      return (data as RebookInvoice | null)?.public_token ? (data as RebookInvoice) : null;
    };

    /** Best-effort Mollie checkout for an UNPAID invoice (paid needs none; the client falls back to
     *  the /pay/:token bank-transfer page with the same publicToken). */
    const startCheckout = async (inv: RebookInvoice): Promise<string | undefined> => {
      if (inv.status === "paid") return undefined;
      try {
        const { data: pay } = await withTimeout(admin.functions.invoke("create-invoice-payment", {
          body: { publicToken: inv.public_token, invoiceId: inv.id },
          headers: serviceAuth,
        }), CHECKOUT_TIMEOUT_MS, "create-invoice-payment");
        return (pay as { paymentUrl?: string })?.paymentUrl;
      } catch (_) { return undefined; }
    };

    /** Undo the seats we just booked (invoice already cancelled by the caller): cancel the bookings and
     *  reset their claims to pending so the claimant can pay the winning invoice / retry. */
    const undoSeats = async (bookingIds: string[]) => {
      await admin.from("bookings").update({ status: "cancelled" }).in("id", bookingIds);
      await admin.from("slot_priority_claims")
        .update({ status: "pending", booking_id: null, responded_at: null })
        .in("booking_id", bookingIds);
    };

    const { token } = await req.json();
    if (!token || typeof token !== "string") return json({ ok: false, error: "token is required" }, 400);

    // Token gate: a valid claim. The holder is the claimant; their identity (never client input) scopes
    // everything below. Groups have their own path (create-group-rebook-invoice).
    const { data: claim } = await admin
      .from("slot_priority_claims")
      .select("id, player_id, guest_player_id, slot_id, rebook_group_id, status")
      .eq("claim_token", token)
      .maybeSingle();
    if (!claim) return json({ ok: false, error: "claim_not_found" }, 404);
    // A grouped claim normally routes to the captain-pays-all path (create-group-rebook-invoice). But a
    // SOLO group — this claimant is the group's ONLY member (a one-player series, or a group that
    // attrited to one) — has NO captain button in the UI (it renders only for >1 member), so its "keep
    // my spot" dead-ends for a logged-out / guest player (the login-required member path can't start a
    // checkout, and a guest can never log in). Delegate a solo group to the group fn: it books the one
    // member's seats at full price — exactly what the deferred split would bill a 1-member group
    // (headcount 1 ⇒ P×S) — and works logged-out. Multi-member groups still refuse → is_group.
    if (claim.rebook_group_id) {
      const { data: groupClaims } = await admin
        .from("slot_priority_claims")
        .select("player_id, guest_player_id")
        .eq("rebook_group_id", claim.rebook_group_id);
      const distinctPlayers = new Set(
        (groupClaims ?? [])
          .map((c: { player_id: string | null; guest_player_id: string | null }) => c.player_id ?? c.guest_player_id)
          .filter(Boolean),
      );
      if (distinctPlayers.size > 1) return json({ ok: false, reason: "is_group" });
      try {
        const { data: grp } = await withTimeout(
          admin.functions.invoke("create-group-rebook-invoice", { body: { token }, headers: serviceAuth }),
          MINT_TIMEOUT_MS + CHECKOUT_TIMEOUT_MS, "create-group-rebook-invoice-delegate",
        );
        return json(grp ?? { ok: false, reason: "strict_mollie_unavailable" });
      } catch (_) {
        return json({ ok: false, reason: "strict_mollie_unavailable" });
      }
    }

    const pid = (claim.player_id as string | null) ?? null;
    const gid = (claim.guest_player_id as string | null) ?? null;
    if (!pid && !gid) return json({ ok: false, reason: "unscoped_claim" });

    // Resolve the cyclus the claim belongs to (its slot's cyclus).
    const { data: slot } = await admin
      .from("availability_slots").select("cyclus_id").eq("id", claim.slot_id).maybeSingle();
    const cyclusId = (slot?.cyclus_id as string | null) ?? null;
    if (!cyclusId) return json({ ok: false, reason: "no_cyclus" });

    // Is this a STRICT pay-first cycle (settings.rebook_strict_mollie)? Resolved BEFORE the accept loop
    // so the "already started" early-return below can enforce strict too — otherwise a strict cycle
    // whose checkout can't (re)start would fall into the bank/invoice fallback (a seat reserved with no
    // online payment). The accept loop still derives its own `strict` from the accept RPC (authoritative).
    const { data: cyc } = await admin.from("cycles").select("settings").eq("id", cyclusId).maybeSingle();
    const cycleStrict = (cyc?.settings as { rebook_strict_mollie?: boolean } | null)?.rebook_strict_mollie === true;

    // DOUBLE-PAY GUARD (sequential): any active rebook invoice already covers this claimant+cyclus →
    // hand THAT one back (re-click / returning). The unique index makes a 2nd active one impossible.
    const existing = await activeRebookInvoice(cyclusId, pid, gid);
    if (existing) {
      const checkoutUrl = await startCheckout(existing);
      // STRICT: never return the bank-fallback publicToken without a live checkout — the client would
      // show "your spot is reserved, pay by invoice", i.e. a held seat with no online payment. If the
      // checkout can't (re)start, report strict_mollie_unavailable → the client offers a retry, not a
      // fallback. The seat is a TTL hold, so it self-releases if the player never completes payment.
      if (cycleStrict && !checkoutUrl) return json({ ok: false, reason: "strict_mollie_unavailable" });
      return json({ ok: true, alreadyStarted: true, invoiceId: existing.id, publicToken: existing.public_token, status: existing.status, checkoutUrl });
    }

    // FULL-CYCLE SCOPE (F2/A-4): all the CLAIMANT's claims across this cyclus, by identity — derived
    // server-side, never client-supplied booking IDs.
    const { data: cyclusSlots } = await admin
      .from("availability_slots").select("id").eq("cyclus_id", cyclusId);
    const cyclusSlotIds = (cyclusSlots ?? []).map((s: { id: string }) => s.id);
    if (cyclusSlotIds.length === 0) return json({ ok: false, reason: "no_cyclus_slots" });

    let mq = admin.from("slot_priority_claims")
      .select("claim_token, status")
      .in("slot_id", cyclusSlotIds)
      .in("status", ["pending", "claimed"])
      .is("rebook_group_id", null); // single path only — never sweep the claimant's GROUP claims
    mq = pid ? mq.eq("player_id", pid) : mq.eq("guest_player_id", gid!);
    const { data: myClaims } = await mq;
    if (!myClaims || myClaims.length === 0) return json({ ok: false, reason: "no_claims" });

    // Accept each still-pending claim (books the claimant's own seat; strict → a TTL HOLD). The legacy
    // single-claim RPC path books one slot per call. A failed sibling (e.g. slot_full) must not block
    // the rest.
    // Authoritative strict flag = the cycle's own setting (settings.rebook_strict_mollie), NOT just
    // the accept RPC's per-row `strict`. If the RPC ever fails to stamp `strict` on a strict cycle,
    // deriving it from acc.strict alone would silently bypass pay-first enforcement and leave a seat
    // reserved without payment — so a strict cycle is ALWAYS treated as strict here.
    let strict = cycleStrict;
    const requestedPending = (myClaims as { claim_token: string; status: string }[]).filter((mc) => mc.status === "pending").length;
    for (const mc of myClaims as { claim_token: string; status: string }[]) {
      if (mc.status !== "pending") continue;
      const { data: acc, error: accErr } = await admin.rpc("respond_to_priority_claim", {
        _token: mc.claim_token, _action: "accept",
      });
      if (accErr) continue;
      if ((acc as { strict?: boolean } | null)?.strict === true) strict = true;
    }

    // Collect the claimant's now-claimed booking ids across the cyclus.
    let bq = admin.from("slot_priority_claims")
      .select("booking_id")
      .in("slot_id", cyclusSlotIds)
      .eq("status", "claimed")
      .not("booking_id", "is", null)
      .is("rebook_group_id", null);
    bq = pid ? bq.eq("player_id", pid) : bq.eq("guest_player_id", gid!);
    const { data: booked } = await bq;
    const bookingIds = [...new Set((booked ?? []).map((r: { booking_id: string | null }) => r.booking_id).filter(Boolean))] as string[];
    if (bookingIds.length === 0) return json({ ok: false, reason: "nothing_booked" });
    // RB-P2-05: some sessions in the cyclus may have been full at accept time and skipped
    // (the accept loop continues past a slot_full sibling). Surface the count so the client can
    // tell the player "N sessions were full" instead of a silent partial booking + partial invoice.
    const skippedFull = Math.max(0, requestedPending - bookingIds.length);

    // After we've booked seats, a mint failure must RELEASE the seats on a STRICT cycle (no seat
    // without an online payment) and report strict_mollie_unavailable; a NON-strict cycle keeps the
    // seat as a reserved commitment (the academy follows up / the client shows "reserved").
    const failAfterAccept = async (reason: string): Promise<Response> => {
      // Money-adjacent: a claimant tried to pay upfront and we couldn't complete it. Alert LOUDLY so
      // this class of failure ("Mollie won't load" / seat silently reserved) is never invisible again.
      await notifySlackEdgeError("create-rebook-invoice-public", `rebook pay-first failed: ${reason}`, {
        token: token.slice(0, 8), cyclusId, strict, reason,
      });
      if (strict) { await undoSeats(bookingIds); return json({ ok: false, reason: "strict_mollie_unavailable" }); }
      return json({ ok: false, reason });
    };

    // Mint ONE invoice over ONLY this claimant's own bookings. We intentionally OMIT
    // splitAmongPlayers so auto-create-invoice's split auto-detect applies the shared-court
    // divisor: a SOLO claimant rebooking their own seat pays their 1/capacity share, matching
    // the authed sibling create-rebook-invoice ("without any split ... would be an N× overcharge
    // on shared cycles"). Only the whole-group captain (create-group-rebook-invoice) pays full
    // court price, because that one payment covers every seat. auto-create-invoice is guest-aware.
    // A mint HANG (a downstream lock / stuck fetch) must not run out the isolate's wall-clock — that
    // kills us before failAfterAccept, stranding the strict holds with no invoice. On timeout we do NOT
    // fail immediately: auto-create-invoice inserts the invoice row BEFORE its slower PDF + email steps,
    // so the row may already exist — fall through to the read-back and only release if it truly didn't.
    let aci: unknown = null;
    let aciErr: unknown = null;
    let mintTimedOut = false;
    try {
      const r = await withTimeout(admin.functions.invoke("auto-create-invoice", {
        body: { bookingIds, asDraft: false },
        headers: serviceAuth,
      }), MINT_TIMEOUT_MS, "auto-create-invoice");
      aci = (r as { data: unknown }).data;
      aciErr = (r as { error: unknown }).error;
    } catch (_) {
      mintTimedOut = true;
    }
    if (!mintTimedOut) {
      if (aciErr) return await failAfterAccept("mint_failed");
      if ((aci as { skipped?: boolean })?.skipped) {
        return await failAfterAccept((aci as { reason?: string })?.reason ?? "business_incomplete");
      }
    }

    // Read back the invoice, scoped to the claimant identity (their bookings are theirs alone).
    let rb = admin.from("invoices")
      .select("id, public_token, status")
      .overlaps("booking_ids", bookingIds)
      .neq("status", "cancelled")
      .order("created_at", { ascending: false })
      .limit(1);
    rb = pid ? rb.eq("player_id", pid) : rb.eq("guest_player_id", gid!);
    const { data: invoice } = await rb.maybeSingle();
    if (!invoice?.public_token) return await failAfterAccept(mintTimedOut ? "mint_timeout" : "no_invoice");

    // Tag rebook_cyclus_id → trips the unique index if a concurrent mint already won. On conflict:
    // cancel OUR duplicate invoice (VERIFY the cancel) and hand back the winner. We do NOT undo the
    // bookings here: this is the SAME claimant double-clicking, so the winning invoice bills these very
    // bookings — cancelling them would strand the winner. Exactly one invoice stays payable.
    const { error: tagErr } = await admin.from("invoices")
      .update({ rebook_cyclus_id: cyclusId }).eq("id", invoice.id);
    if (tagErr) {
      const { error: cancelErr } = await admin.from("invoices").update({ status: "cancelled" }).eq("id", invoice.id);
      if (cancelErr) return json({ ok: false, reason: "mint_conflict", message: String(cancelErr) });
      const winner = await activeRebookInvoice(cyclusId, pid, gid);
      if (winner) {
        const checkoutUrl = await startCheckout(winner);
        // STRICT: same guard as the double-pay early-return — never hand back a bank-fallback
        // publicToken without a live checkout (that would reserve a seat with no online payment).
        if (strict && !checkoutUrl) return json({ ok: false, reason: "strict_mollie_unavailable" });
        return json({ ok: true, alreadyStarted: true, invoiceId: winner.id, publicToken: winner.public_token, status: winner.status, checkoutUrl });
      }
      return json({ ok: false, reason: "retry" });
    }

    // Start the Mollie checkout. Non-strict: best-effort — the client falls back to /pay/:token
    // (bank transfer) with the same publicToken. STRICT: mandatory — if none, ABORT: cancel invoice,
    // cancel HOLDS, reset claims to pending (no seat without an online payment; no bank fallback).
    const checkoutUrl = await startCheckout(invoice as RebookInvoice);
    if (strict && !checkoutUrl) {
      await notifySlackEdgeError("create-rebook-invoice-public", "strict rebook: Mollie checkout would not start — seat released", {
        token: token.slice(0, 8), cyclusId, invoiceId: invoice.id,
      });
      await admin.from("invoices").update({ status: "cancelled" }).eq("id", invoice.id);
      await undoSeats(bookingIds);
      return json({ ok: false, reason: "strict_mollie_unavailable" });
    }
    return json({ ok: true, invoiceId: invoice.id, publicToken: invoice.public_token, status: invoice.status, checkoutUrl, skippedFull });
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    await notifySlackEdgeError("create-rebook-invoice-public", message);
    return json({ ok: false, error: "internal_error", message }, 500);
  }
});
