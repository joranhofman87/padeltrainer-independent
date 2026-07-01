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
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { corsHeadersFor } from "../_shared/cors.ts";
import { computeSingleSlotPaymentAmount, type SlotPricingInput } from "../_shared/booking-pricing.ts";
import { resolveSlotTier } from "../_shared/slot-tier.ts";
import { resolveOrCreateGuestPlayer } from "../_shared/guest-players.ts";
import { resolveRegistrationNameFields } from "../_shared/profileName.ts";

type Supa = SupabaseClient;

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

// Refresh a connected account's OAuth token if it's within 5 min of expiry.
// (Mirrors create-invoice-payment.refreshTokenIfNeeded; fails safe to the old
// token on any error so a transient hiccup never blocks a payment.)
async function refreshTokenIfNeeded(
  supabase: Supa,
  account: { access_token: string | null; refresh_token?: string | null; token_expires_at?: string | null },
  entityType: "trainer" | "academy",
  entityId: string,
): Promise<string | null> {
  const clientId = Deno.env.get("MOLLIE_CLIENT_ID");
  const clientSecret = Deno.env.get("MOLLIE_CLIENT_SECRET");
  if (!clientId || !clientSecret) return account.access_token;
  const expiresAt = account.token_expires_at ? new Date(account.token_expires_at) : null;
  if (expiresAt && expiresAt > new Date(Date.now() + 5 * 60 * 1000)) return account.access_token;
  if (!account.refresh_token) return account.access_token;
  try {
    const resp = await fetch("https://api.mollie.com/oauth2/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: account.refresh_token }),
    });
    if (!resp.ok) return account.access_token;
    const tokens = await resp.json();
    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    const table = entityType === "trainer" ? "trainer_mollie_accounts" : "academy_mollie_accounts";
    const idCol = entityType === "trainer" ? "trainer_id" : "academy_profile_id";
    await supabase.from(table).update({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expires_at: newExpiresAt,
      updated_at: new Date().toISOString(),
    }).eq(idCol, entityId);
    return tokens.access_token;
  } catch {
    return account.access_token;
  }
}

// Flat platform fee for a tier's plan (academy €0.50 / trainer starter|professional).
async function tierFlat(supabase: Supa, tier: string): Promise<number | null> {
  const { data: plan } = await supabase
    .from("subscription_plans")
    .select("platform_fee_flat")
    .eq("tier", tier)
    .eq("plan_type", "trainer")
    .eq("is_active", true)
    .maybeSingle();
  return plan?.platform_fee_flat != null ? Number(plan.platform_fee_flat) : null;
}

// Resolve the charging recipient the SAME way mollie-webhook.resolveAccessToken +
// create-mollie-payment do: the slot's trainer -> their ACTIVE academy membership
// -> that academy's Mollie, else the trainer's OWN Mollie. Keyed off the slot's
// trainer_id (never client input). Using the identical predicate to the webhook is
// load-bearing: the org that CHARGES here must equal the org that later CONFIRMS
// the paid hold, or an academy slot whose trainer is no longer an active member
// would be charged on one org and confirmed on another → the payment strands and
// the guest is charged for a seat that never commits. (This is why we do NOT route
// by slot.academy_profile_id — the webhook's booking branch never reads it.)
async function resolveSlotRecipient(
  supabase: Supa,
  trainerProfileId: string,
): Promise<{ accessToken: string | null; recipientType: "academy" | "trainer" | null; mollieOrgId: string | null; platformFee: number }> {
  let accessToken: string | null = null;
  let recipientType: "academy" | "trainer" | null = null;
  let mollieOrgId: string | null = null;
  let platformFee = 1.0;

  const { data: academyTrainer } = await supabase
    .from("academy_trainers")
    .select("academy_profile_id, academy:academy_profiles(id, platform_fee_override)")
    .eq("trainer_profile_id", trainerProfileId)
    .eq("status", "active")
    .maybeSingle();

  if (academyTrainer?.academy_profile_id) {
    const { data: academyMollie } = await supabase
      .from("academy_mollie_accounts")
      .select("mollie_organization_id, charges_enabled, access_token, refresh_token, token_expires_at")
      .eq("academy_profile_id", academyTrainer.academy_profile_id)
      .eq("onboarding_complete", true)
      .maybeSingle();
    if (academyMollie?.access_token && academyMollie?.charges_enabled) {
      accessToken = await refreshTokenIfNeeded(supabase, academyMollie, "academy", academyTrainer.academy_profile_id);
      recipientType = "academy";
      mollieOrgId = academyMollie.mollie_organization_id ?? null;
      const academy = academyTrainer.academy as { platform_fee_override?: number | null } | null;
      platformFee = academy?.platform_fee_override != null
        ? Number(academy.platform_fee_override)
        : ((await tierFlat(supabase, "academy")) ?? 1.0);
    }
  }

  if (!accessToken) {
    const { data: trainerMollie } = await supabase
      .from("trainer_mollie_accounts")
      .select("mollie_organization_id, access_token, refresh_token, token_expires_at")
      .eq("trainer_id", trainerProfileId)
      .eq("onboarding_complete", true)
      .maybeSingle();
    if (trainerMollie?.access_token) {
      accessToken = await refreshTokenIfNeeded(supabase, trainerMollie, "trainer", trainerProfileId);
      recipientType = "trainer";
      mollieOrgId = trainerMollie.mollie_organization_id ?? null;
      const { data: tp } = await supabase
        .from("trainer_profiles").select("platform_fee_override, subscription_status").eq("id", trainerProfileId).maybeSingle();
      platformFee = tp?.platform_fee_override != null
        ? Number(tp.platform_fee_override)
        : ((await tierFlat(supabase, tp?.subscription_status === "active" ? "professional" : "starter")) ?? 1.0);
    }
  }

  return { accessToken, recipientType, mollieOrgId, platformFee };
}

// Best-effort release of an uncommitted hold on any post-hold failure. Guarded on
// status='payment_pending' so a hold the webhook already committed is never
// cancelled; payment_status is left untouched so a late webhook still hits the
// paid-on-cancelled refund alert. Swallows errors — the TTL sweep is the backstop.
async function softCancelHold(supabase: Supa, bookingId: string) {
  try {
    await supabase.from("bookings").update({ status: "cancelled" })
      .eq("id", bookingId).eq("status", "payment_pending");
  } catch (_) {
    logStep("soft-cancel failed (TTL sweep will reclaim)", { bookingId });
  }
}

// Best-effort per-email+endpoint throttle on the shared rate_limits table (same
// pattern as submit-guest-intake). Fails OPEN so a DB hiccup never blocks a real
// booking. Returns true when allowed.
async function throttle(supabase: Supa, identifier: string, max: number, windowMin: number): Promise<boolean> {
  const windowStart = new Date(Date.now() - windowMin * 60 * 1000);
  try {
    const { data: existing } = await supabase
      .from("rate_limits").select("id, request_count, window_start")
      .eq("identifier", identifier).eq("endpoint", "create-guest-slot-payment").maybeSingle();
    if (existing && new Date(existing.window_start) > windowStart) {
      if (existing.request_count >= max) return false;
      await supabase.from("rate_limits").update({ request_count: existing.request_count + 1 }).eq("id", existing.id);
      return true;
    }
    await supabase.from("rate_limits").upsert(
      { identifier, endpoint: "create-guest-slot-payment", request_count: 1, window_start: new Date().toISOString() },
      { onConflict: "identifier,endpoint" },
    );
    return true;
  } catch (_err) {
    return true; // fail open
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

serve(async (req) => {
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
    const notes = typeof body?.notes === "string" && body.notes.trim() ? body.notes.trim() : null;
    const name = resolveRegistrationNameFields({
      firstName: body?.firstName, lastName: body?.lastName, fullName: body?.fullName,
    });

    if (!slotId) return json({ error: "slot_required" }, 400);
    if (!EMAIL_RE.test(email)) return json({ error: "invalid_email" }, 400);
    if (!name.full_name) return json({ error: "name_required" }, 400);

    // Rate-limit on IP (trusted last hop) AND email, both fail-open. The email key
    // is caller-supplied and trivially rotated, so the IP key is the real abuse
    // control; the email key catches IP rotation. Mirrors submit-guest-intake's
    // dual-key approach for this fully-anonymous money surface. X-Forwarded-For:
    // earlier hops are caller-controlled; the LAST entry is appended by the trusted
    // edge proxy, so key on that one.
    const forwardedHops = (req.headers.get("x-forwarded-for") || "").split(",").map((h) => h.trim()).filter(Boolean);
    const clientIp = forwardedHops[forwardedHops.length - 1] || "unknown";
    if (clientIp !== "unknown" && !(await throttle(supabase, `ip:${clientIp}`, 15, 60))) {
      return json({ error: "rate_limited", message: "Too many attempts. Please try again later." }, 429);
    }
    if (!(await throttle(supabase, `email:${email}`, 5, 60))) {
      return json({ error: "rate_limited", message: "Too many attempts. Please try again later." }, 429);
    }

    // 1. Server-side slot read — everything below derives from this row.
    const { data: slot } = await supabase
      .from("availability_slots")
      .select(
        "id, trainer_id, academy_profile_id, price_per_session, start_time, end_time, max_participants, allow_single_booking, cyclus_name, priority_window_ends_at, member_window_ends_at, public_release_status",
      )
      .eq("id", slotId)
      .maybeSingle();
    if (!slot) return json({ error: "slot_not_found" }, 404);

    // 2. Visibility guard: guests may book ONLY public-tier slots. hasPendingClaim
    // is set conservatively true so any live priority window blocks the guest.
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

    // 3. Server-authoritative amount. hourly_rate is only a fallback for slots
    // without an explicit price_per_session.
    let hourlyRate: number | null = null;
    if (slot.trainer_id) {
      const { data: tp } = await supabase.from("trainer_profiles").select("hourly_rate").eq("id", slot.trainer_id).maybeSingle();
      hourlyRate = tp?.hourly_rate != null ? Number(tp.hourly_rate) : null;
    }
    const expectedAmount = computeSingleSlotPaymentAmount(slot as unknown as SlotPricingInput, hourlyRate, 1);
    if (!(expectedAmount > 0)) return json({ error: "invalid_amount" }, 400);

    // 4. Recipient — resolved the SAME way mollie-webhook will later CONFIRM the
    // paid hold (trainer → active-academy → academy Mollie, else trainer Mollie),
    // so the charging org always equals the confirming org.
    if (!slot.trainer_id) return json({ error: "no_mollie_account" }, 400);
    const { accessToken, recipientType, mollieOrgId, platformFee } = await resolveSlotRecipient(
      supabase,
      slot.trainer_id as string,
    );
    if (!accessToken || !recipientType) {
      logStep("Refused — no connected Mollie account", { slotId });
      return json({ error: "no_mollie_account", message: "Online betaling is niet beschikbaar voor deze training." }, 400);
    }

    // 5. Guest identity — always a guest_players row (never an existing player_id).
    const owner = slot.academy_profile_id
      ? { academyProfileId: slot.academy_profile_id as string }
      : { trainerId: slot.trainer_id as string };
    const { guestPlayerId } = await resolveOrCreateGuestPlayer(supabase, {
      email, name, phone, owner, source: "public_booking",
    });

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
      if ((bookingError.message || "").includes("slot_full")) {
        logStep("Refused — slot full", { slotId });
        return json({ error: "slot_full" }, 409);
      }
      throw new Error(`Failed to reserve seat: ${bookingError.message}`);
    }
    bookingId = newBookingId as string;
    logStep("Guest hold created", { bookingId, expectedAmount, recipientType });

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
          `https://api.mollie.com/v2/payments/${priorState.mollie_payment_id}${probeTestParam}`,
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
              await fetch(`https://api.mollie.com/v2/payments/${priorState.mollie_payment_id}${probeTestParam}`, {
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
      const profileResp = await fetch("https://api.mollie.com/v2/profiles", {
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
      await softCancelHold(supabase, bookingId);
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

    const mollieRes = await fetch("https://api.mollie.com/v2/payments", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(paymentData),
    });
    if (!mollieRes.ok) {
      const errText = await mollieRes.text();
      await softCancelHold(supabase, bookingId);
      await writeAuditLog(supabase, {
        function_name: "create-guest-slot-payment", booking_id: bookingId, recipient_type: recipientType,
        mollie_org_id: mollieOrgId, amount: expectedAmount, status: "error", error_message: errText.slice(0, 500),
      });
      throw new Error(`Mollie error: ${errText}`);
    }

    const payment = await mollieRes.json();
    // Persist mollie_payment_id FIRST (before audit/slack that could throw) so the
    // webhook can route by it in addition to metadata.booking_ids.
    await supabase.from("bookings").update({ mollie_payment_id: payment.id }).eq("id", bookingId);

    await writeAuditLog(supabase, {
      function_name: "create-guest-slot-payment", booking_id: bookingId, recipient_type: recipientType,
      mollie_org_id: mollieOrgId, amount: expectedAmount, status: "success", mollie_payment_id: payment.id,
      metadata: { profileId: mollieProfileId, fee: effectiveFee, guest: true },
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
    if (bookingId) await softCancelHold(supabase, bookingId);
    await notifySlack(supabase, "edge_function_error", { function: "create-guest-slot-payment", error: message.slice(0, 500) });
    return json({ error: "server_error" }, 500);
  }
});
