// Anonymous guest MULTI-SESSION CART pay-first ("winkelwagen"). A public visitor
// selects N separate individual sessions, pays once, and is only booked when the
// webhook commits. The arbitrary-slot-set sibling of create-guest-cyclus-payment;
// same server-authoritative trust model (design:
// docs/audits/MULTI_SESSION_CART_BOOKING_AUDIT.md §6.2):
//
//   - The client supplies ONLY slot ids + contact details. Slots are re-read
//     server-side; prices, ownership, visibility and eligibility re-derived
//     (_shared/cart-payment.ts — Deno-tested).
//   - SINGLE RECIPIENT ORG: every slot must share one trainer AND one academy
//     (null academy = trainer-own bucket), so the org that CHARGES equals the org
//     the webhook resolves to CONFIRM. Mixed carts are refused (mixed_recipient).
//   - v1 EXCLUSIONS: split_payment sessions (per-seat total÷N — a full-price cart
//     hold would over-collect) and cyclus sessions without allow_single_booking
//     (whole-cyclus path only). Both also enforced in the RPC.
//   - AMOUNT = Σ per-item single-slot price (+ that slot's extra costs), identical
//     to create-guest-slot-payment — a cart of one prices exactly like the single
//     flow. Distributed across the holds so sum(payment_amount)==the Mollie charge.
//   - Seats held ATOMICALLY by book_guest_cart_for_payment (all-or-nothing); any
//     stale/full item rolls the whole cart back and the response names the
//     offending ids ({ error, slotIds }) so the UI can prune + retry.
//   - IDENTITY is always a guest_players row; metadata.booking_ids (NO invoice_id);
//     mollie_payment_id + a stable shared public_token persisted; TTL sweep +
//     best-effort soft-cancel backstop on failure.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { corsHeadersFor } from "../_shared/cors.ts";
import {
  type CartSlotRow,
  mapCartRpcError,
  normalizeCartSlotIds,
  priceCartItems,
  validateCartSlots,
} from "../_shared/cart-payment.ts";
import { resolveOrCreateGuestPlayer } from "../_shared/guest-players.ts";
import { recordGuestWhatsAppOptIn, type ConsentWriteClient } from "../_shared/guest-whatsapp-optin.ts";
import { resolveRegistrationNameFields } from "../_shared/profileName.ts";
import { classifyMollieCreateError, distributeAmountCents, resolveSlotRecipient, softCancelGuestHolds, throttleGuestPayment } from "../_shared/guest-payment.ts";
import { mollieIdempotencyKey } from "../_shared/mollie-idempotency.ts";

type Supa = SupabaseClient;
const ENDPOINT = "create-guest-cart-payment";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[CREATE-GUEST-CART-PAYMENT] ${step}`, details ? JSON.stringify(details) : "");
};

async function notifySlack(supabase: Supa, event: string, data: Record<string, unknown>) {
  try {
    await supabase.functions.invoke("slack-notify", { body: { event, data } });
  } catch (_) {
    // best-effort
  }
}

async function writeAuditLog(
  supabase: Supa,
  log: {
    function_name: string; recipient_type?: string | null; mollie_org_id?: string | null;
    amount?: number; status: string; error_message?: string; mollie_payment_id?: string; metadata?: Record<string, unknown>;
  },
) {
  try {
    await supabase.from("payment_audit_log").insert(log);
  } catch (_) {
    logStep("Failed to write audit log", { error: String(_) });
  }
}

/** HTTP status per cart refusal: stale/contended items are 409 (retryable after prune). */
function refusalStatus(error: string): number {
  if (error === "slot_unavailable" || error === "slot_full" || error === "already_booked") return 409;
  if (error === "slot_not_bookable") return 403;
  return 400;
}

Deno.serve(async (req) => {
  const corsHeaders = corsHeadersFor(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const mollieApiKey = Deno.env.get("MOLLIE_API_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  let bookingIds: string[] = [];
  try {
    const body = await req.json().catch(() => ({}));
    const email = (typeof body?.email === "string" ? body.email.trim() : "").toLowerCase();
    const phone = typeof body?.phone === "string" && body.phone.trim() ? body.phone.trim() : null;
    // Strict === true: a missing or truthy-ish value must never read as consent.
    const whatsappOptIn = body?.whatsappOptIn === true;
    const notes = typeof body?.notes === "string" && body.notes.trim() ? body.notes.trim() : null;
    // U2: the booker's own id for THIS checkout attempt. It is what makes the Player create
    // idempotent — a double tap, a network replay or a returning Mollie redirect carries the same
    // id and gets the same Player, where before the address and the name were used to recognise a
    // repeat. Required, because an attribute may not stand in for it.
    const creationRequestId = typeof body?.creationRequestId === "string" ? body.creationRequestId.trim() : "";
    if (!UUID_RE.test(creationRequestId)) {
      return json({ error: "invalid_creation_request_id", message: "Vernieuw de pagina en probeer opnieuw." }, 400);
    }
    const name = resolveRegistrationNameFields({ firstName: body?.firstName, lastName: body?.lastName, fullName: body?.fullName });

    const normalized = normalizeCartSlotIds(body?.slotIds);
    if ("error" in normalized) {
      if (normalized.error === "cart_too_large") {
        await writeAuditLog(supabase, { function_name: ENDPOINT, status: "cart_too_large" });
      }
      return json(normalized, refusalStatus(normalized.error));
    }
    const slotIds = normalized.slotIds;
    if (!EMAIL_RE.test(email)) return json({ error: "invalid_email" }, 400);
    if (!phone) return json({ error: "phone_required" }, 400);
    if (!name.full_name) return json({ error: "name_required" }, 400);

    // Dual fail-open rate limit (trusted-last-hop IP + email).
    const hops = (req.headers.get("x-forwarded-for") || "").split(",").map((h) => h.trim()).filter(Boolean);
    const clientIp = hops[hops.length - 1] || "unknown";
    if (clientIp !== "unknown" && !(await throttleGuestPayment(supabase, ENDPOINT, `ip:${clientIp}`, 15, 60))) {
      return json({ error: "rate_limited", message: "Too many attempts. Please try again later." }, 429);
    }
    if (!(await throttleGuestPayment(supabase, ENDPOINT, `email:${email}`, 5, 60))) {
      return json({ error: "rate_limited", message: "Too many attempts. Please try again later." }, 429);
    }

    // 1. Server-side read of the EXACT requested slots — future sessions only. A
    // missing/past/deleted id simply doesn't come back and is reported below.
    const nowIso = new Date().toISOString();
    const { data: slotRows } = await supabase
      .from("availability_slots")
      .select(
        "id, trainer_id, academy_profile_id, cyclus_id, cyclus_name, price_per_session, start_time, end_time, max_participants, allow_single_booking, whole_slot_booking, split_payment, extra_costs, is_public, priority_window_ends_at, member_window_ends_at, public_release_status",
      )
      .in("id", slotIds)
      .gt("start_time", nowIso);
    const slots = (slotRows ?? []) as unknown as CartSlotRow[];

    // 2.–4. Eligibility, visibility and the single-recipient-org guard — the pure,
    // Deno-tested core. Refusals name the offending ids so the UI can prune.
    const refusal = validateCartSlots(slotIds, slots);
    if (refusal) {
      logStep("Refused pre-hold", { ...refusal, requested: slotIds.length });
      if (["slot_unavailable", "mixed_recipient", "split_not_supported"].includes(refusal.error)) {
        await writeAuditLog(supabase, {
          function_name: ENDPOINT, status: refusal.error,
          metadata: { slotIds: refusal.slotIds ?? null, requested: slotIds.length },
        });
      }
      return json(refusal, refusalStatus(refusal.error));
    }

    // validateCartSlots guarantees ONE payment recipient: either one academy (whose member
    // trainers may mix in the cart) or one trainer-own account. slots[0] therefore carries
    // the recipient; its trainer doubles as the membership check inside resolveSlotRecipient.
    const trainerId = slots[0].trainer_id as string;
    const academyProfileId = slots[0].academy_profile_id ?? null;

    // Recipient — same predicate as mollie-webhook will use to CONFIRM (charge==confirm).
    const { accessToken, recipientType, mollieOrgId, platformFee } = await resolveSlotRecipient(
      supabase,
      trainerId,
      academyProfileId,
    );
    if (!accessToken || !recipientType) {
      return json({ error: "no_mollie_account", message: "Online betaling is niet beschikbaar voor deze sessies." }, 400);
    }

    // 5. Server-authoritative pricing: Σ per-item single-slot price + extras. NO split.
    // Hourly fallback rates are PER TRAINER — an academy cart may mix its trainers.
    const cartTrainerIds = [...new Set(slots.map((s) => s.trainer_id).filter(Boolean))] as string[];
    const { data: tps } = await supabase
      .from("trainer_profiles")
      .select("id, hourly_rate")
      .in("id", cartTrainerIds);
    const hourlyRateByTrainer: Record<string, number | null> = {};
    (tps ?? []).forEach((tp: { id: string; hourly_rate: number | null }) => {
      hourlyRateByTrainer[tp.id] = tp.hourly_rate != null ? Number(tp.hourly_rate) : null;
    });
    const { itemAmounts, total: expectedAmount } = priceCartItems(slotIds, slots, hourlyRateByTrainer);
    if (!(expectedAmount > 0)) return json({ error: "invalid_amount" }, 400);

    // 6. Guest identity — always a guest_players row, owned by the cart's single org.


    const owner = academyProfileId ? { academyProfileId } : { trainerId };
    const { guestPlayerId } = await resolveOrCreateGuestPlayer(supabase, { email, name, phone, owner, source: "public_booking", creationRequestId });

    // WhatsApp opt-in: only if the guest ticked the box next to the number they just typed.
    // Tenant comes from the SLOT above, never from the client — the client sends a boolean and
    // nothing else. Never throws: a consent write must not be able to fail a paid booking.
    if (whatsappOptIn === true) {
      const optIn = await recordGuestWhatsAppOptIn(supabase as unknown as ConsentWriteClient, {
        optIn: whatsappOptIn,
        phone,
        guestPlayerId,
        academyProfileId: academyProfileId,
        trainerId: trainerId,
        source: "public_booking",
      });
      if (!optIn.ok && optIn.reason === "error") {
        console.error("whatsapp opt-in failed", { reason: optIn.reason, detail: optIn.detail });
      }
    }

    // Already-paid guard: don't re-charge a guest who already paid for any selected session.
    const { data: existingPaid } = await supabase
      .from("bookings")
      .select("public_token")
      .in("slot_id", slotIds)
      .eq("guest_player_id", guestPlayerId)
      .eq("payment_status", "paid")
      .neq("status", "cancelled")
      .limit(1)
      .maybeSingle();
    if (existingPaid) {
      return json({ error: "already_booked", message: "Je hebt een van deze sessies al geboekt.", token: existingPaid.public_token }, 409);
    }

    // 7. Atomic multi-session hold — the one mutation boundary (all-or-nothing).
    const { data: idsData, error: rpcError } = await supabase.rpc("book_guest_cart_for_payment", {
      _guest_player_id: guestPlayerId,
      _slot_ids: slotIds,
      _amounts: itemAmounts,
      _hold_minutes: 20,
      _notes: notes,
    });
    if (rpcError) {
      const mapped = mapCartRpcError(rpcError);
      if (mapped) {
        logStep("Refused at hold", { ...mapped });
        if (mapped.error === "slot_full" || mapped.error === "slot_unavailable") {
          await writeAuditLog(supabase, {
            function_name: ENDPOINT, recipient_type: recipientType, mollie_org_id: mollieOrgId,
            status: mapped.error, metadata: { slotIds: mapped.slotIds ?? null },
          });
        }
        return json(mapped, refusalStatus(mapped.error));
      }
      throw new Error(`Failed to reserve cart: ${rpcError.message}`);
    }
    // Canonical order immediately — the RPC's idempotent re-click branch returns an
    // unordered array_agg, and these ids feed the Mollie Idempotency-Key'd body (an
    // unstable order would turn a timeout-retry into a same-key/different-body 400).
    bookingIds = [...((idsData as string[]) ?? [])].sort();
    if (bookingIds.length === 0) throw new Error("No bookings returned from cart hold");
    logStep("Guest cart holds created", { count: bookingIds.length, expectedAmount });

    // M-15 idempotency across the set: reuse/refuse based on the holds' current payment.
    const { data: priorRows } = await supabase
      .from("bookings")
      .select("mollie_payment_id, payment_status, public_token")
      .in("id", bookingIds);
    const rows = priorRows ?? [];
    if (rows.some((r) => r.payment_status === "paid")) {
      return json({ error: "already_paid", message: "Deze sessies zijn al betaald." }, 409);
    }
    const priorPaymentId = rows.map((r) => r.mollie_payment_id).find(Boolean) ?? null;
    const priorToken = rows.map((r) => r.public_token).find(Boolean) ?? null;
    const probeTestParam = mollieApiKey.startsWith("test_") ? "?testmode=true" : "";
    if (priorPaymentId) {
      try {
        const probe = await fetch(`https://api.mollie.com/v2/payments/${priorPaymentId}${probeTestParam}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (probe.ok) {
          const prior = await probe.json();
          const priorValue = Number(prior.amount?.value);
          if (prior.status === "paid") return json({ error: "already_paid", message: "Deze sessies zijn al betaald." }, 409);
          if (prior.status === "open" && Number.isFinite(priorValue) && Math.abs(priorValue - expectedAmount) <= 0.01) {
            logStep("Reusing existing open cart payment", { paymentId: prior.id });
            return json({ checkoutUrl: prior._links?.checkout?.href, paymentId: prior.id, token: priorToken, existing: true });
          }
          if (prior.status === "open") {
            try {
              await fetch(`https://api.mollie.com/v2/payments/${priorPaymentId}${probeTestParam}`, {
                method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` },
              });
            } catch (_) {
              logStep("Failed to cancel stale cart payment (will mint fresh)");
            }
          }
        }
      } catch (probeErr) {
        logStep("Error probing prior cart payment, will mint fresh", { error: String(probeErr) });
      }
    }

    // Re-distribute the charge across the RETURNED bookings so stored
    // sum(payment_amount) ALWAYS equals the Mollie amount minted below — the RPC only
    // stamps amounts on FRESH inserts, and a re-click that reuses live holds (after a
    // price changed) would otherwise keep stale amounts and trip the webhook's
    // sum(payment_amount)==paid guard, stranding captured money.
    const finalAmounts = distributeAmountCents(expectedAmount, bookingIds.length);
    for (let i = 0; i < bookingIds.length; i++) {
      await supabase.from("bookings").update({ payment_amount: finalAmounts[i] }).eq("id", bookingIds[i]);
    }

    // The charge already includes each slot's extra costs (priceCartItems), so flag the
    // holds for auto-create-invoice's extras skip — same as create-guest-slot-payment.
    // Known pre-existing caveat (shared with the single-slot flow, NOT widened here):
    // shouldSkipExtrasForPaidExtrasBookings never fires for an all-one-cyclus booking
    // set, so a uniform same-cyclus cart with extras can overstate the INVOICE (the
    // charge itself is correct). Rare config; tracked in the design audit §8.
    const { error: flagError } = await supabase
      .from("bookings")
      .update({ amount_includes_extras: true })
      .in("id", bookingIds);
    if (flagError) {
      logStep("Could not set amount_includes_extras (non-fatal)", { error: flagError.message });
    }

    // Stable, durable confirmation token shared across the cart's bookings
    // (the token index is non-unique — see 20260704180000). Set once; reused on re-click.
    const publicToken = priorToken ?? crypto.randomUUID();
    if (!priorToken) {
      await supabase.from("bookings").update({ public_token: publicToken }).in("id", bookingIds);
    }

    // Mollie profile for the connected account.
    let mollieProfileId: string | null = null;
    try {
      const profileResp = await fetch("https://api.mollie.com/v2/profiles", { headers: { Authorization: `Bearer ${accessToken}` } });
      if (profileResp.ok) {
        const profileData = await profileResp.json();
        if (profileData._embedded?.profiles?.length > 0) mollieProfileId = profileData._embedded.profiles[0].id;
      }
    } catch (err) {
      logStep("Error fetching Mollie profile", { error: String(err) });
    }
    if (!mollieProfileId) {
      await softCancelGuestHolds(supabase, bookingIds);
      await writeAuditLog(supabase, {
        function_name: ENDPOINT, recipient_type: recipientType, mollie_org_id: mollieOrgId,
        amount: expectedAmount, status: "blocked_no_profile", error_message: "No Mollie profile for connected account",
      });
      return json({ error: "missing_mollie_profile", message: "Betaalprofiel niet geconfigureerd." }, 400);
    }

    const effectiveFee = Math.min(platformFee, Math.max(0, expectedAmount - 0.3));
    const appUrl = Deno.env.get("APP_URL") || "https://padeltrainer.ai";
    // /booking/:token is intentionally NOT language-prefixed (mirrors the other guest flows).
    const redirectUrl = `${appUrl}/booking/${publicToken}?status=success`;
    const webhookUrl = `${supabaseUrl}/functions/v1/mollie-webhook`;

    const paymentData: Record<string, unknown> = {
      amount: { currency: "EUR", value: expectedAmount.toFixed(2) },
      description: bookingIds.length > 1 ? `Padel training (${bookingIds.length} sessies)` : "Padel training",
      redirectUrl,
      webhookUrl,
      profileId: mollieProfileId,
      metadata: {
        booking_ids: bookingIds, // tells mollie-webhook to commit ALL holds (NO invoice_id)
        guest_player_id: guestPlayerId,
        recipient_type: recipientType,
        cart: true,
      },
    };
    if (effectiveFee > 0) {
      paymentData.applicationFee = { amount: { currency: "EUR", value: effectiveFee.toFixed(2) }, description: "Platform fee" };
    }
    if (mollieApiKey.startsWith("test_")) paymentData.testmode = true;

    // G2: idempotency key = fingerprint of the exact body. bookingIds are canonical-
    // sorted and the token is stable, so a plain retry re-sends an identical body →
    // Mollie replays the ORIGINAL payment. Salted with any superseded payment id so a
    // price round-trip within 1h can't replay a now-cancelled earlier checkout.
    const idempotencyKey = await mollieIdempotencyKey(
      priorPaymentId ? `gcart:recreate:${priorPaymentId}` : "gcart",
      paymentData,
    );
    const mollieRes = await fetch("https://api.mollie.com/v2/payments", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(paymentData),
    });
    if (!mollieRes.ok) {
      const errText = await mollieRes.text();
      await softCancelGuestHolds(supabase, bookingIds);
      await writeAuditLog(supabase, {
        function_name: ENDPOINT, recipient_type: recipientType, mollie_org_id: mollieOrgId,
        amount: expectedAmount, status: "error", error_message: errText.slice(0, 500),
      });
      logStep("Mollie create failed", { status: mollieRes.status, body: errText.slice(0, 300) });
      return json({ error: classifyMollieCreateError(errText) }, 400);
    }

    const payment = await mollieRes.json();
    // Persist mollie_payment_id on every booking BEFORE audit/slack.
    await supabase.from("bookings").update({ mollie_payment_id: payment.id }).in("id", bookingIds);

    await writeAuditLog(supabase, {
      function_name: ENDPOINT, recipient_type: recipientType, mollie_org_id: mollieOrgId,
      amount: expectedAmount, status: "success", mollie_payment_id: payment.id,
      metadata: { profileId: mollieProfileId, fee: effectiveFee, sessions: bookingIds.length, guest: true, cart: true, idempotentReplayed: mollieRes.headers.get("Idempotent-Replayed") === "true" },
    });
    await notifySlack(supabase, "payment_created", {
      type: "guest_cart", recipientType, mollieOrgId,
      amount: `€${expectedAmount.toFixed(2)}`, sessions: bookingIds.length, paymentId: payment.id,
    });
    logStep("Cart payment created", { paymentId: payment.id, sessions: bookingIds.length });

    return json({ checkoutUrl: payment._links?.checkout?.href, paymentId: payment.id, token: publicToken });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    if (bookingIds.length) await softCancelGuestHolds(supabase, bookingIds);
    await notifySlack(supabase, "edge_function_error", { function: ENDPOINT, error: message.slice(0, 500) });
    return json({ error: "server_error" }, 500);
  }
});
