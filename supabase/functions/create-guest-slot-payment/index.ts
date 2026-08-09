// Anonymous guest single-slot PAY-FIRST. A public (unauthenticated) visitor on
// an academy/trainer page picks a slot, enters name/email/phone, and pays — only
// a paid webhook commits the seat. This is the anonymous sibling of
// create-mollie-payment; every trust decision is made SERVER-SIDE here because
// the caller is anonymous:
//
//   1. The slot (trainer, academy, price, capacity, windows) is read from the DB
//      by id — never taken from the client.
//   2. VISIBILITY: a guest may only book a PUBLIC-tier slot (resolveSlotTier ===
//      "public"); priority/member-window and held/pending slots are refused, so a
//      guest can't jump a members-only queue.
//   3. AMOUNT is recomputed server-side (computeSingleSlotPaymentAmount) and the
//      Mollie charge equals it exactly — the webhook's sum(payment_amount)==paid
//      guard depends on this.
//   4. RECIPIENT is academy-first XOR: an academy slot routes to the ACADEMY's
//      Mollie only (never the trainer's personal account — that would mis-route
//      the academy's money if the trainer later left); a trainer's own slot routes
//      to the trainer. (Do NOT copy create-mollie-payment's trainer-first order.)
//   5. IDENTITY is always a guest_players row (never an existing player_id — an
//      anonymous caller must not attach a booking to someone else's account).
//   6. The seat is inserted ONLY by book_guest_slot_for_payment (advisory lock +
//      capacity recount = the one mutation boundary) as a short-TTL hold.
//
// metadata.booking_ids (NO invoice_id) tells mollie-webhook to commit the hold;
// mollie_payment_id is persisted so the webhook can also route by it. On any
// post-hold failure the hold is best-effort soft-cancelled; the TTL sweep
// (release_expired_guest_slot_holds) is the backstop.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { corsHeadersFor } from "../_shared/cors.ts";
import { computeSingleSlotPaymentAmount, sumSlotExtraCosts, type ExtraCost, type SlotPricingInput } from "../_shared/booking-pricing.ts";
import { resolveSlotTier } from "../_shared/slot-tier.ts";
import { legacyGuestRefForCheckout, resolvePlayerForCheckout } from "../_shared/guest-players.ts";
import { recordGuestWhatsAppOptIn, type ConsentWriteClient } from "../_shared/guest-whatsapp-optin.ts";
import { resolveRegistrationNameFields } from "../_shared/profileName.ts";
import { classifyMollieCreateError, resolveSlotRecipient, softCancelGuestHolds, throttleGuestPayment } from "../_shared/guest-payment.ts";
import { mollieIdempotencyKey } from "../_shared/mollie-idempotency.ts";

type Supa = SupabaseClient;
const ENDPOINT = "create-guest-slot-payment";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Prod default unchanged; a local mock (scripts/db/mock-mollie.mjs) sets MOLLIE_API_BASE
// so the pay→webhook money path can run end-to-end with no real gateway.
const MOLLIE_API_BASE = Deno.env.get("MOLLIE_API_BASE") ?? "https://api.mollie.com";

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[CREATE-GUEST-SLOT-PAYMENT] ${step}`, details ? JSON.stringify(details) : "");
};

async function notifySlack(supabase: Supa, event: string, data: Record<string, unknown>) {
  try {
    await supabase.functions.invoke("slack-notify", { body: { event, data } });
  } catch (_) {
    // Silent — Slack is best-effort.
  }
}

async function writeAuditLog(
  supabase: Supa,
  log: {
    function_name: string;
    booking_id?: string;
    recipient_type?: string | null;
    mollie_org_id?: string | null;
    amount?: number;
    status: string;
    error_message?: string;
    mollie_payment_id?: string;
    metadata?: Record<string, unknown>;
  },
) {
  try {
    await supabase.from("payment_audit_log").insert(log);
  } catch (_) {
    logStep("Failed to write audit log", { error: String(_) });
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  const corsHeaders = corsHeadersFor(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const mollieApiKey = Deno.env.get("MOLLIE_API_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  let bookingId: string | null = null;
  try {
    const body = await req.json().catch(() => ({}));
    const slotId = typeof body?.slotId === "string" ? body.slotId.trim() : "";
    const rawEmail = typeof body?.email === "string" ? body.email.trim() : "";
    const email = rawEmail.toLowerCase();
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
    const name = resolveRegistrationNameFields({
      firstName: body?.firstName, lastName: body?.lastName, fullName: body?.fullName,
    });

    if (!slotId) return json({ error: "slot_required" }, 400);
    // CONTACT, not identity (U2, owner 2026-08-09). This flow has to reach the registrant — a
    // pay link or a confirmation goes to this address — so it requires one as workflow input.
    // The PLAYER may still have none: the create command takes NULL, and no address ever
    // selects, merges or reuses an identity here or anywhere.
    if (!EMAIL_RE.test(email)) return json({ error: "invalid_email" }, 400);
    if (!phone) return json({ error: "phone_required" }, 400);
    if (!name.full_name) return json({ error: "name_required" }, 400);

    // Rate-limit on IP (trusted last hop) AND email, both fail-open. The email key
    // is caller-supplied and trivially rotated, so the IP key is the real abuse
    // control; the email key catches IP rotation. Mirrors submit-guest-intake's
    // dual-key approach for this fully-anonymous money surface. X-Forwarded-For:
    // earlier hops are caller-controlled; the LAST entry is appended by the trusted
    // edge proxy, so key on that one.
    const forwardedHops = (req.headers.get("x-forwarded-for") || "").split(",").map((h) => h.trim()).filter(Boolean);
    const clientIp = forwardedHops[forwardedHops.length - 1] || "unknown";
    if (clientIp !== "unknown" && !(await throttleGuestPayment(supabase, ENDPOINT, `ip:${clientIp}`, 15, 60))) {
      return json({ error: "rate_limited", message: "Too many attempts. Please try again later." }, 429);
    }
    if (!(await throttleGuestPayment(supabase, ENDPOINT, `email:${email}`, 5, 60))) {
      return json({ error: "rate_limited", message: "Too many attempts. Please try again later." }, 429);
    }

    // 1. Server-side slot read — everything below derives from this row.
    const { data: slot } = await supabase
      .from("availability_slots")
      .select(
        "id, trainer_id, academy_profile_id, price_per_session, start_time, end_time, max_participants, allow_single_booking, whole_slot_booking, split_payment, extra_costs, is_public, cyclus_id, cyclus_name, priority_window_ends_at, member_window_ends_at, public_release_status",
      )
      .eq("id", slotId)
      .maybeSingle();
    if (!slot) return json({ error: "slot_not_found" }, 404);

    // 2. Visibility guard. FIRST: is_public — the primary published flag the public read filters on
    // (usePublicAvailability .eq('is_public', true)). The tier windows below do NOT consider it, so a
    // private slot with no active window would otherwise resolve to 'public' and be bookable via a
    // crafted slotId. Then: guests may book ONLY public-tier slots; hasPendingClaim is set
    // conservatively true so any live priority window blocks the guest.
    if (slot.is_public !== true) {
      logStep("Refused — slot not public (is_public)", { slotId });
      return json({ error: "slot_not_bookable" }, 403);
    }
    const tier = resolveSlotTier({
      priorityWindowEndsAt: slot.priority_window_ends_at,
      hasPendingClaim: true,
      memberWindowEndsAt: slot.member_window_ends_at,
      publicReleaseStatus: slot.public_release_status,
    });
    if (tier !== "public") {
      logStep("Refused — slot not public", { slotId, tier });
      return json({ error: "slot_not_bookable" }, 403);
    }
    if (new Date(slot.start_time).getTime() <= Date.now()) {
      return json({ error: "slot_in_past" }, 400);
    }
    // Single-session booking of a CYCLUS session is only offered when the owner enabled
    // allow_single_booking (per-seat) OR whole_slot_booking (one booking claims the ENTIRE session
    // at full price — capacity stays 1). Mirror the dialog here — this endpoint is public
    // (verify_jwt=false), so a crafted call must not bypass it. Critically, a split_payment
    // session is per-seat and priced total÷N via the cyclus path; the whole-slot unlock NEVER
    // applies to it — a full-price single hold would over-collect (#352). The RPC enforces the
    // same at the mutation boundary (single_booking_not_allowed); this is the clean early refusal.
    if (
      slot.cyclus_id &&
      slot.allow_single_booking !== true &&
      !(slot.whole_slot_booking === true && slot.split_payment !== true)
    ) {
      logStep("Refused — single-session booking not allowed for this cyclus session", { slotId });
      return json({ error: "slot_not_bookable" }, 403);
    }

    // 3. Server-authoritative amount. hourly_rate is only a fallback for slots
    // without an explicit price_per_session.
    let hourlyRate: number | null = null;
    if (slot.trainer_id) {
      const { data: tp } = await supabase.from("trainer_profiles").select("hourly_rate").eq("id", slot.trainer_id).maybeSingle();
      hourlyRate = tp?.hourly_rate != null ? Number(tp.hourly_rate) : null;
    }
    // Base session price + the slot's extra costs (balls, court hire, …) — the guest is quoted
    // price_per_session + extrasTotal on the card/dialog, so the charge must include the extras too.
    const expectedAmount =
      computeSingleSlotPaymentAmount(slot as unknown as SlotPricingInput, hourlyRate, 1) +
      sumSlotExtraCosts(slot.extra_costs as ExtraCost[] | null);
    if (!(expectedAmount > 0)) return json({ error: "invalid_amount" }, 400);

    // 4. Recipient — resolved the SAME way mollie-webhook will later CONFIRM the
    // paid hold (trainer → active-academy → academy Mollie, else trainer Mollie),
    // so the charging org always equals the confirming org.
    if (!slot.trainer_id) return json({ error: "no_mollie_account" }, 400);
    const { accessToken, recipientType, mollieOrgId, platformFee } = await resolveSlotRecipient(
      supabase,
      slot.trainer_id as string,
      slot.academy_profile_id as string | null,
    );
    if (!accessToken || !recipientType) {
      logStep("Refused — no connected Mollie account", { slotId });
      return json({ error: "no_mollie_account", message: "Online betaling is niet beschikbaar voor deze training." }, 400);
    }

    // 5. Guest identity — always a guest_players row (never an existing player_id).


    const owner = slot.academy_profile_id
      ? { academyProfileId: slot.academy_profile_id as string }
      : { trainerId: slot.trainer_id as string };
    // The checkout resolves a CANONICAL Player. The legacy column `bookings` still requires is derived
    // from it by the authorized adapter, and exists only for the length of this insert.
    const { personId } = await resolvePlayerForCheckout(supabase, {
      email, name, phone, owner, source: "public_booking", creationRequestId,
    });
    const guestPlayerId = await legacyGuestRefForCheckout(supabase, personId, owner);

    // WhatsApp opt-in: only if the guest ticked the box next to the number they just typed.
    // Tenant comes from the SLOT above, never from the client — the client sends a boolean and
    // nothing else. Never throws: a consent write must not be able to fail a paid booking.
    if (whatsappOptIn === true) {
      const optIn = await recordGuestWhatsAppOptIn(supabase as unknown as ConsentWriteClient, {
        optIn: whatsappOptIn,
        phone,
        guestPlayerId,
        academyProfileId: slot.academy_profile_id as string | null,
        trainerId: slot.trainer_id as string | null,
        source: "public_booking",
      });
      if (!optIn.ok && optIn.reason === "error") {
        console.error("whatsapp opt-in failed", { reason: optIn.reason, detail: optIn.detail });
      }
    }

    // Already-paid guard: the RPC dedups only a LIVE payment_pending hold, so on a
    // multi-seat slot a guest who ALREADY paid for a seat here could otherwise mint
    // a second payment by re-booking under the same identity. Refuse if this guest
    // already holds a paid, non-cancelled booking on this slot (send them to their
    // existing confirmation instead of charging again).
    const { data: existingPaid } = await supabase
      .from("bookings")
      .select("id, public_token")
      .eq("slot_id", slotId)
      .eq("guest_player_id", guestPlayerId)
      .eq("payment_status", "paid")
      .neq("status", "cancelled")
      .limit(1)
      .maybeSingle();
    if (existingPaid) {
      logStep("Guest already has a paid booking on this slot", { slotId, guestPlayerId });
      return json({ error: "already_booked", message: "Je hebt deze training al geboekt.", token: existingPaid.public_token }, 409);
    }

    // 6. The seat — the one mutation boundary (advisory lock + capacity recount).
    const { data: newBookingId, error: bookingError } = await supabase.rpc("book_guest_slot_for_payment", {
      _slot_id: slotId,
      _guest_player_id: guestPlayerId,
      _payment_amount: expectedAmount,
      _hold_minutes: 20,
      _notes: notes,
    });
    if (bookingError) {
      // EVERY refusal this RPC can raise is mapped. The mutation boundary is the ONLY place the
      // guest cutoff is enforced — an edge pre-check was tried and removed, because it sat above
      // the live-hold reuse and refused guests finishing a checkout they began outside the
      // cutoff. So an unmapped token here is a generic 500 for a rule we have clear copy for.
      if ((bookingError.message || "").includes("booking_cutoff")) {
        logStep("Refused — booking cutoff", { slotId });
        return json({ error: "booking_cutoff", message: "Deze training kan niet meer online geboekt worden. Neem contact op met de trainer." }, 400);
      }
      if ((bookingError.message || "").includes("slot_full")) {
        logStep("Refused — slot full", { slotId });
        return json({ error: "slot_full" }, 409);
      }
      // Mutation-boundary guard (should be unreachable — the early guard above already refused this):
      // a single-session hold on a cyclus session without allow_single_booking.
      if ((bookingError.message || "").includes("single_booking_not_allowed")) {
        logStep("Refused — single_booking_not_allowed (RPC boundary)", { slotId });
        return json({ error: "slot_not_bookable" }, 403);
      }
      // Concurrent-change paths: the slot was hidden, or a paid rebook group took the court,
      // between our read and the RPC's advisory lock. Both have a clean guest-facing meaning.
      if ((bookingError.message || "").includes("slot_not_public")) {
        logStep("Refused — slot no longer public (RPC boundary)", { slotId });
        return json({ error: "slot_unavailable", message: "Deze training is niet meer beschikbaar." }, 409);
      }
      if ((bookingError.message || "").includes("reserved_group")) {
        logStep("Refused — court reserved by a paid group (RPC boundary)", { slotId });
        return json({ error: "slot_unavailable", message: "Deze training is niet meer beschikbaar." }, 409);
      }
      throw new Error(`Failed to reserve seat: ${bookingError.message}`);
    }
    bookingId = newBookingId as string;
    logStep("Guest hold created", { bookingId, expectedAmount, recipientType });

    // The guest charge already includes sumSlotExtraCosts (see expectedAmount above), so
    // stamp the booking to stop auto-create-invoice / invoiceSync re-appending the extras
    // (P2-7 double-count). Best-effort: a missing column just falls back to today's behavior.
    {
      const { error: flagError } = await supabase
        .from("bookings")
        .update({ amount_includes_extras: true })
        .eq("id", bookingId);
      if (flagError) {
        logStep("Could not set amount_includes_extras (non-fatal)", { error: flagError.message });
      }
    }

    // M-15 idempotency: a re-click returns the SAME hold row (the RPC dedups a live
    // hold). Before minting again, reuse/refuse based on the hold's current payment
    // so we never create a SECOND Mollie payment that orphans the first — the row
    // keeps only the newest id, so the webhook could not route the older one (real
    // money taken, seat never confirmed).
    const { data: priorState } = await supabase
      .from("bookings")
      .select("mollie_payment_id, payment_status, public_token")
      .eq("id", bookingId)
      .maybeSingle();
    if (priorState?.payment_status === "paid") {
      return json({ error: "already_paid", message: "Deze boeking is al betaald." }, 409);
    }
    const probeTestParam = mollieApiKey.startsWith("test_") ? "?testmode=true" : "";
    if (priorState?.mollie_payment_id) {
      try {
        const probe = await fetch(
          `${MOLLIE_API_BASE}/v2/payments/${priorState.mollie_payment_id}${probeTestParam}`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (probe.ok) {
          const prior = await probe.json();
          const priorValue = Number(prior.amount?.value);
          if (prior.status === "paid") {
            return json({ error: "already_paid", message: "Deze boeking is al betaald." }, 409);
          }
          if (prior.status === "open" && Number.isFinite(priorValue) && Math.abs(priorValue - expectedAmount) <= 0.01) {
            logStep("Reusing existing open payment", { paymentId: prior.id, bookingId });
            return json({
              checkoutUrl: prior._links?.checkout?.href,
              paymentId: prior.id,
              token: priorState.public_token,
              existing: true,
            });
          }
          if (prior.status === "open") {
            // Amount drifted — cancel the stale checkout before issuing a fresh one.
            try {
              await fetch(`${MOLLIE_API_BASE}/v2/payments/${priorState.mollie_payment_id}${probeTestParam}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${accessToken}` },
              });
            } catch (_) {
              logStep("Failed to cancel stale payment (will mint fresh anyway)", { bookingId });
            }
          }
        }
      } catch (probeErr) {
        logStep("Error probing prior payment, will mint fresh", { error: String(probeErr) });
      }
    }

    // Confirmation token — stable across re-clicks (reuse the one an earlier attempt
    // set). Durable on the row so the login-free confirm page (/booking/:token) can
    // read the booking after the Mollie redirect.
    const publicToken = priorState?.public_token ?? crypto.randomUUID();
    if (!priorState?.public_token) {
      await supabase.from("bookings").update({ public_token: publicToken }).eq("id", bookingId);
    }

    // Mollie profile for the connected account (required for OAuth payments).
    let mollieProfileId: string | null = null;
    try {
      const profileResp = await fetch(`${MOLLIE_API_BASE}/v2/profiles`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (profileResp.ok) {
        const profileData = await profileResp.json();
        if (profileData._embedded?.profiles?.length > 0) mollieProfileId = profileData._embedded.profiles[0].id;
      }
    } catch (err) {
      logStep("Error fetching Mollie profile", { error: String(err) });
    }
    if (!mollieProfileId) {
      await softCancelGuestHolds(supabase, [bookingId]);
      await writeAuditLog(supabase, {
        function_name: "create-guest-slot-payment", booking_id: bookingId, recipient_type: recipientType,
        mollie_org_id: mollieOrgId, amount: expectedAmount, status: "blocked_no_profile",
        error_message: "No Mollie profile for connected account",
      });
      return json({ error: "missing_mollie_profile", message: "Betaalprofiel niet geconfigureerd." }, 400);
    }

    // Fee: strictly below amount minus Mollie's transaction cost.
    const effectiveFee = Math.min(platformFee, Math.max(0, expectedAmount - 0.3));

    const appUrl = Deno.env.get("APP_URL") || "https://padeltrainer.ai";
    // /booking/:token is intentionally NOT language-prefixed (mirrors /pay/:token).
    const redirectUrl = `${appUrl}/booking/${publicToken}?status=success`;
    const webhookUrl = `${supabaseUrl}/functions/v1/mollie-webhook`;

    const paymentData: Record<string, unknown> = {
      amount: { currency: "EUR", value: expectedAmount.toFixed(2) },
      description: slot.cyclus_name ? `Training — ${slot.cyclus_name}` : "Padel training",
      redirectUrl,
      webhookUrl,
      profileId: mollieProfileId,
      metadata: {
        booking_id: bookingId,
        booking_ids: [bookingId], // tells mollie-webhook to commit the hold (NO invoice_id)
        guest_player_id: guestPlayerId,
        recipient_type: recipientType,
      },
    };
    if (effectiveFee > 0) {
      paymentData.applicationFee = { amount: { currency: "EUR", value: effectiveFee.toFixed(2) }, description: "Platform fee" };
    }
    if (mollieApiKey.startsWith("test_")) paymentData.testmode = true;

    // G2: idempotency key = fingerprint of the exact body. The hold RPC dedups
    // re-clicks to the SAME bookingId and the token is stable, so a retry re-sends an
    // identical body → Mollie replays the ORIGINAL payment (no duplicate checkout).
    const idempotencyKey = await mollieIdempotencyKey("gsp", paymentData);
    const mollieRes = await fetch(`${MOLLIE_API_BASE}/v2/payments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(paymentData),
    });
    if (!mollieRes.ok) {
      const errText = await mollieRes.text();
      await softCancelGuestHolds(supabase, [bookingId]);
      await writeAuditLog(supabase, {
        function_name: "create-guest-slot-payment", booking_id: bookingId, recipient_type: recipientType,
        mollie_org_id: mollieOrgId, amount: expectedAmount, status: "error", error_message: errText.slice(0, 500),
      });
      // Surface a clear, safe reason (e.g. the academy hasn't activated a payment method)
      // instead of throwing into the opaque server_error 500. Hold already released above.
      logStep("Mollie create failed", { status: mollieRes.status, body: errText.slice(0, 300) });
      return json({ error: classifyMollieCreateError(errText) }, 400);
    }

    const payment = await mollieRes.json();
    // Persist mollie_payment_id FIRST (before audit/slack that could throw) so the
    // webhook can route by it in addition to metadata.booking_ids.
    await supabase.from("bookings").update({ mollie_payment_id: payment.id }).eq("id", bookingId);

    await writeAuditLog(supabase, {
      function_name: "create-guest-slot-payment", booking_id: bookingId, recipient_type: recipientType,
      mollie_org_id: mollieOrgId, amount: expectedAmount, status: "success", mollie_payment_id: payment.id,
      metadata: { profileId: mollieProfileId, fee: effectiveFee, guest: true, idempotentReplayed: mollieRes.headers.get("Idempotent-Replayed") === "true" },
    });
    await notifySlack(supabase, "payment_created", {
      type: "guest_booking", recipientType, mollieOrgId,
      amount: `€${expectedAmount.toFixed(2)}`, fee: `€${effectiveFee.toFixed(2)}`, paymentId: payment.id,
    });
    logStep("Payment created", { paymentId: payment.id, bookingId });

    return json({ checkoutUrl: payment._links?.checkout?.href, paymentId: payment.id, token: publicToken });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    if (bookingId) await softCancelGuestHolds(supabase, [bookingId]);
    await notifySlack(supabase, "edge_function_error", { function: "create-guest-slot-payment", error: message.slice(0, 500) });
    return json({ error: "server_error" }, 500);
  }
});
