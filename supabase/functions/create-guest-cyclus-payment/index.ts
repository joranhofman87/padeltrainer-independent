// Anonymous guest WHOLE-CYCLUS pay-first. A public visitor pays upfront for every
// remaining session of a cyclus and is only booked once the webhook commits. The
// multi-session sibling of create-guest-slot-payment; same server-authoritative
// trust model, extended to N sessions held atomically:
//
//   - Slots (all FUTURE sessions of the cyclus) are read server-side by cyclus_id.
//   - VISIBILITY: every session must be public-tier (else refuse) — no priority/
//     member-window leak.
//   - SINGLE TRAINER: all sessions must share one trainer, so the org that CHARGES
//     equals the (single) org the webhook resolves to CONFIRM. Mixed-trainer
//     cycluses are refused (they can't be routed to one Mollie org safely).
//   - AMOUNT recomputed server-side (computeCyclusTotalFromSlots + optional split)
//     and DISTRIBUTED across the sessions so sum(payment_amount)==the Mollie charge.
//   - Seats held ATOMICALLY by book_guest_cyclus_for_payment (all-or-nothing); a
//     full session rolls the whole thing back (never a partial paid series).
//   - IDENTITY is always a guest_players row; metadata.booking_ids (NO invoice_id);
//     mollie_payment_id + a stable public_token persisted; TTL sweep + best-effort
//     soft-cancel backstop on failure.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { corsHeadersFor } from "../_shared/cors.ts";
import { applySplitPayment, computeCyclusTotalFromSlots, computeCyclusExtrasTotal, resolveSplitDivisorFromSlots, hasNonUniformCapacity, type ExtraCost, type SlotPricingInput } from "../_shared/booking-pricing.ts";
import { resolveSlotTier } from "../_shared/slot-tier.ts";
import { isCyclusBookingAllowed } from "../_shared/cyclus-booking.ts";
import { resolveOrCreateGuestPlayer } from "../_shared/guest-players.ts";
import { recordGuestWhatsAppOptIn, type ConsentWriteClient } from "../_shared/guest-whatsapp-optin.ts";
import { resolveRegistrationNameFields } from "../_shared/profileName.ts";
import { classifyMollieCreateError, distributeAmountCents, resolveSlotRecipient, softCancelGuestHolds, throttleGuestPayment } from "../_shared/guest-payment.ts";
import { mollieIdempotencyKey } from "../_shared/mollie-idempotency.ts";

type Supa = SupabaseClient;
const ENDPOINT = "create-guest-cyclus-payment";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[CREATE-GUEST-CYCLUS-PAYMENT] ${step}`, details ? JSON.stringify(details) : "");
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
    const cyclusId = typeof body?.cyclusId === "string" ? body.cyclusId.trim() : "";
    const email = (typeof body?.email === "string" ? body.email.trim() : "").toLowerCase();
    const phone = typeof body?.phone === "string" && body.phone.trim() ? body.phone.trim() : null;
    // Strict === true: a missing or truthy-ish value must never read as consent.
    const whatsappOptIn = body?.whatsappOptIn === true;
    const notes = typeof body?.notes === "string" && body.notes.trim() ? body.notes.trim() : null;
    const name = resolveRegistrationNameFields({ firstName: body?.firstName, lastName: body?.lastName, fullName: body?.fullName });

    if (!cyclusId) return json({ error: "cyclus_required" }, 400);
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

    // 1. Server-side read: all FUTURE sessions of the cyclus.
    const nowIso = new Date().toISOString();
    const { data: slots } = await supabase
      .from("availability_slots")
      .select(
        "id, trainer_id, academy_profile_id, cyclus_name, price_per_session, start_time, end_time, max_participants, allow_single_booking, extra_costs, is_public, priority_window_ends_at, member_window_ends_at, public_release_status",
      )
      .eq("cyclus_id", cyclusId)
      .gt("start_time", nowIso)
      .order("start_time", { ascending: true });
    if (!slots || slots.length === 0) return json({ error: "cyclus_not_bookable" }, 404);

    // 2. Visibility: every session must be PUBLISHED (is_public) AND public-tier. is_public is the
    // primary published flag the public read filters on and the tier windows do NOT consider it, so a
    // private session with no active window would otherwise resolve to 'public' and be bookable.
    for (const s of slots) {
      if (s.is_public !== true) {
        logStep("Refused — a session is not public (is_public)", { cyclusId, slotId: s.id });
        return json({ error: "slot_not_bookable" }, 403);
      }
      const tier = resolveSlotTier({
        priorityWindowEndsAt: s.priority_window_ends_at,
        hasPendingClaim: true,
        memberWindowEndsAt: s.member_window_ends_at,
        publicReleaseStatus: s.public_release_status,
      });
      if (tier !== "public") {
        logStep("Refused — a session is not public", { cyclusId, slotId: s.id, tier });
        return json({ error: "slot_not_bookable" }, 403);
      }
    }

    // 3. Single-trainer requirement (so charge org == confirm org for the whole set).
    const trainerId = slots[0].trainer_id as string | null;
    if (!trainerId || slots.some((s) => s.trainer_id !== trainerId)) {
      logStep("Refused — cyclus has no single trainer", { cyclusId });
      return json({ error: "no_mollie_account", message: "Online betaling is niet beschikbaar voor deze cyclus." }, 400);
    }

    // 4. Recipient — same predicate as mollie-webhook will use to CONFIRM. All slots in a cyclus
    //    share one academy, so slots[0].academy_profile_id disambiguates a multi-academy trainer
    //    (Codex F3); the webhook resolves the same academy off any of these slots.
    const { accessToken, recipientType, mollieOrgId, platformFee } = await resolveSlotRecipient(
      supabase,
      trainerId,
      slots[0].academy_profile_id as string | null,
    );
    if (!accessToken || !recipientType) {
      return json({ error: "no_mollie_account", message: "Online betaling is niet beschikbaar voor deze cyclus." }, 400);
    }

    // 5. Server-authoritative total + optional split.
    let hourlyRate: number | null = null;
    const { data: tp } = await supabase.from("trainer_profiles").select("hourly_rate").eq("id", trainerId).maybeSingle();
    hourlyRate = tp?.hourly_rate != null ? Number(tp.hourly_rate) : null;
    const baseTotal = computeCyclusTotalFromSlots(slots as unknown as SlotPricingInput[], hourlyRate);
    if (!(baseTotal > 0)) return json({ error: "invalid_amount" }, 400);

    const { data: cycle } = await supabase.from("cycles").select("settings").eq("id", cyclusId).maybeSingle();
    // Owner switch: a cyclus can be restricted to INDIVIDUAL sessions only (settings.
    // allow_cyclus_booking=false, e.g. RL Padel's drop-in model). The dialog hides the
    // whole-series option, but this endpoint is verify_jwt=false — enforce it here.
    if (!isCyclusBookingAllowed(cycle?.settings)) {
      logStep("Refused — whole-cyclus booking disabled for this cycle", { cyclusId });
      return json({ error: "cyclus_not_bookable" }, 403);
    }
    const settings = (cycle?.settings as Record<string, unknown>) || {};
    const splitPayment = settings.split_payment === true;

    // Fold extras into the charge so it collects what the invoice bills (one_time once, per_session
    // per session, each ÷ split). Same extras source as auto-create-invoice: cycle settings, else
    // first slot (audit Batch 2 — charge/invoice extras must agree; owner: charge the extras).
    const cycleExtraCosts: ExtraCost[] | null =
      (settings.extra_costs as ExtraCost[] | null) ??
      ((slots[0] as { extra_costs?: ExtraCost[] | null })?.extra_costs ?? null);
    const total = baseTotal + computeCyclusExtrasTotal(cycleExtraCosts, slots.length);

    // 6. Guest identity — always a guest_players row.


    const owner = slots[0].academy_profile_id
      ? { academyProfileId: slots[0].academy_profile_id as string }
      : { trainerId };
    const { guestPlayerId } = await resolveOrCreateGuestPlayer(supabase, { email, name, phone, owner, source: "public_booking" });

    // WhatsApp opt-in: only if the guest ticked the box next to the number they just typed.
    // Tenant comes from the SLOT above, never from the client — the client sends a boolean and
    // nothing else. Never throws: a consent write must not be able to fail a paid booking.
    if (whatsappOptIn === true) {
      const optIn = await recordGuestWhatsAppOptIn(supabase as unknown as ConsentWriteClient, {
        optIn: whatsappOptIn,
        phone,
        guestPlayerId,
        academyProfileId: slots[0].academy_profile_id as string | null,
        trainerId: trainerId,
        source: "public_booking",
      });
      if (!optIn.ok && optIn.reason === "error") {
        console.error("whatsapp opt-in failed", { reason: optIn.reason, detail: optIn.detail });
      }
    }

    const slotIds = slots.map((s) => s.id as string);

    let expectedAmount = total;
    if (splitPayment) {
      // G5: split by the cycle's COURT CAPACITY (frozen), not the live participant count.
      // A pure function of the slot rows → stable across re-clicks and concurrent joins,
      // and never overcharges (each guest pays exactly total ÷ seats). divisor 1 ⇒ no split.
      const divisor = resolveSplitDivisorFromSlots(slots);
      if (hasNonUniformCapacity(slots)) {
        logStep("WARN: split cycle has non-uniform slot capacity — using MAX (never overcharges)", {
          cyclusId,
          divisor,
          capacities: slots.map((s) => s.max_participants),
        });
      }
      expectedAmount = applySplitPayment(total, divisor);
    }
    if (!(expectedAmount > 0)) return json({ error: "invalid_amount" }, 400);

    // Distribute the charge across the sessions (whole cents; sums back exactly).
    const amounts = distributeAmountCents(expectedAmount, slotIds.length);

    // Already-paid guard: don't re-charge a guest who already paid for this cyclus.
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
      return json({ error: "already_booked", message: "Je hebt deze cyclus al geboekt.", token: existingPaid.public_token }, 409);
    }

    // 7. Atomic multi-session hold — the one mutation boundary.
    const { data: idsData, error: rpcError } = await supabase.rpc("book_guest_cyclus_for_payment", {
      _guest_player_id: guestPlayerId,
      _slot_ids: slotIds,
      _amounts: amounts,
      _hold_minutes: 20,
      _notes: notes,
    });
    if (rpcError) {
      // Every refusal this RPC can raise is mapped — the mutation boundary is the ONLY place
      // the guest cutoff is enforced (see create-guest-slot-payment).
      if ((rpcError.message || "").includes("booking_cutoff")) {
        logStep("Refused — booking cutoff", { cyclusId });
        return json({ error: "booking_cutoff", message: "Deze training kan niet meer online geboekt worden. Neem contact op met de trainer." }, 400);
      }
      if ((rpcError.message || "").includes("slot_full")) {
        logStep("Refused — a session is full", { cyclusId });
        return json({ error: "slot_full" }, 409);
      }
      // A session was hidden between our read and the RPC's lock.
      if ((rpcError.message || "").includes("slot_not_public")) {
        logStep("Refused — a session is no longer public (RPC boundary)", { cyclusId });
        return json({ error: "slot_unavailable", message: "Deze cyclus is niet meer beschikbaar." }, 409);
      }
      if ((rpcError.message || "").includes("invalid_input")) {
        logStep("Refused — invalid input at the RPC boundary", { cyclusId });
        return json({ error: "invalid_input" }, 400);
      }
      throw new Error(`Failed to reserve cyclus: ${rpcError.message}`);
    }
    // Sort into a CANONICAL order immediately. The RPC returns ids in input-slot order
    // on the create path but via an unordered array_agg on the idempotent re-click
    // branch, so the order is not stable across a retry. Since these ids go into the
    // Mollie payment body (metadata.booking_ids) and Mollie diffs the RAW body against
    // the Idempotency-Key, an unstable order would make a plain timeout-retry a
    // same-key/different-body 400. Sorting here fixes the order for the body AND for
    // every index-based use below (the per-booking amount split is order-immaterial —
    // all rows are this guest's and the webhook checks the SUM).
    bookingIds = [...((idsData as string[]) ?? [])].sort();
    if (bookingIds.length === 0) throw new Error("No bookings returned from cyclus hold");
    logStep("Guest cyclus holds created", { cyclusId, count: bookingIds.length, expectedAmount });

    // M-15 idempotency across the set: reuse/refuse based on the holds' current payment.
    const { data: priorRows } = await supabase
      .from("bookings")
      .select("mollie_payment_id, payment_status, public_token")
      .in("id", bookingIds);
    const rows = priorRows ?? [];
    if (rows.some((r) => r.payment_status === "paid")) {
      return json({ error: "already_paid", message: "Deze cyclus is al betaald." }, 409);
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
          if (prior.status === "paid") return json({ error: "already_paid", message: "Deze cyclus is al betaald." }, 409);
          if (prior.status === "open" && Number.isFinite(priorValue) && Math.abs(priorValue - expectedAmount) <= 0.01) {
            logStep("Reusing existing open cyclus payment", { paymentId: prior.id });
            return json({ checkoutUrl: prior._links?.checkout?.href, paymentId: prior.id, token: priorToken, existing: true });
          }
          if (prior.status === "open") {
            try {
              await fetch(`https://api.mollie.com/v2/payments/${priorPaymentId}${probeTestParam}`, {
                method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` },
              });
            } catch (_) {
              logStep("Failed to cancel stale cyclus payment (will mint fresh)", { cyclusId });
            }
          }
        }
      } catch (probeErr) {
        logStep("Error probing prior cyclus payment, will mint fresh", { error: String(probeErr) });
      }
    }

    // Re-distribute the (possibly re-split) charge across the RETURNED bookings so
    // stored sum(payment_amount) ALWAYS equals the Mollie amount we mint below. The
    // RPC only stamps amounts on FRESH inserts — a re-click that reuses live holds
    // (after the split headcount changed) would otherwise keep stale amounts, and
    // the webhook's sum(payment_amount)==paid guard would then block the commit,
    // stranding captured money. Mirrors create-mollie-payment's per-booking
    // distribution. Keyed on bookingIds (not the pre-RPC slotIds) so reuse is covered.
    const finalAmounts = distributeAmountCents(expectedAmount, bookingIds.length);
    for (let i = 0; i < bookingIds.length; i++) {
      await supabase.from("bookings").update({ payment_amount: finalAmounts[i] }).eq("id", bookingIds[i]);
    }

    // Stable, durable confirmation token shared across the cyclus's session bookings
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
    const redirectUrl = `${appUrl}/booking/${publicToken}?status=success`;
    const webhookUrl = `${supabaseUrl}/functions/v1/mollie-webhook`;

    const paymentData: Record<string, unknown> = {
      amount: { currency: "EUR", value: expectedAmount.toFixed(2) },
      description: slots[0].cyclus_name ? `Cyclus — ${slots[0].cyclus_name}` : "Padel cyclus",
      redirectUrl,
      webhookUrl,
      profileId: mollieProfileId,
      metadata: {
        booking_ids: bookingIds, // tells mollie-webhook to commit ALL holds (NO invoice_id)
        guest_player_id: guestPlayerId,
        recipient_type: recipientType,
        cyclus_id: cyclusId,
      },
    };
    if (effectiveFee > 0) {
      paymentData.applicationFee = { amount: { currency: "EUR", value: effectiveFee.toFixed(2) }, description: "Platform fee" };
    }
    if (mollieApiKey.startsWith("test_")) paymentData.testmode = true;

    // G2: idempotency key = fingerprint of the exact body. The hold RPC dedups
    // re-clicks to the SAME bookingIds set (sorted to a canonical order above so the raw
    // body is byte-stable across a retry) and the token is stable, so a retry re-sends an
    // identical body → Mollie replays the ORIGINAL payment. Salted with any superseded
    // payment id (kept on the holds until the fresh POST succeeds, like cmp/cip) so a
    // split-divisor ROUND-TRIP within 1h (a participant joins then leaves → amount
    // returns to a prior value) can't replay the now-cancelled earlier checkout.
    const idempotencyKey = await mollieIdempotencyKey(
      priorPaymentId ? `gcp:recreate:${priorPaymentId}` : "gcp",
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
      // Surface a clear, safe reason (e.g. the academy hasn't activated a payment method)
      // instead of throwing into the opaque server_error 500. Holds already released above.
      logStep("Mollie create failed", { status: mollieRes.status, body: errText.slice(0, 300) });
      return json({ error: classifyMollieCreateError(errText) }, 400);
    }

    const payment = await mollieRes.json();
    // Persist mollie_payment_id on every session's booking BEFORE audit/slack.
    await supabase.from("bookings").update({ mollie_payment_id: payment.id }).in("id", bookingIds);

    await writeAuditLog(supabase, {
      function_name: ENDPOINT, recipient_type: recipientType, mollie_org_id: mollieOrgId,
      amount: expectedAmount, status: "success", mollie_payment_id: payment.id,
      metadata: { profileId: mollieProfileId, fee: effectiveFee, sessions: bookingIds.length, guest: true, idempotentReplayed: mollieRes.headers.get("Idempotent-Replayed") === "true" },
    });
    await notifySlack(supabase, "payment_created", {
      type: "guest_cyclus", recipientType, mollieOrgId,
      amount: `€${expectedAmount.toFixed(2)}`, sessions: bookingIds.length, paymentId: payment.id,
    });
    logStep("Cyclus payment created", { paymentId: payment.id, sessions: bookingIds.length });

    return json({ checkoutUrl: payment._links?.checkout?.href, paymentId: payment.id, token: publicToken });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    if (bookingIds.length) await softCancelGuestHolds(supabase, bookingIds);
    await notifySlack(supabase, "edge_function_error", { function: ENDPOINT, error: message.slice(0, 500) });
    return json({ error: "server_error" }, 500);
  }
});
