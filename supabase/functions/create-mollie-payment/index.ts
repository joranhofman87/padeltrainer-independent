import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import {
  applySplitPayment,
  amountsMatch,
  computeCyclusTotalFromSlots,
  computeSingleSlotPaymentAmount,
  type SlotPricingInput,
} from "../_shared/booking-pricing.ts";
import { mollieIdempotencyKey } from "../_shared/mollie-idempotency.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[CREATE-MOLLIE-PAYMENT] ${step}`, details ? JSON.stringify(details) : "");
};

async function notifySlack(supabase: any, event: string, data: Record<string, unknown>) {
  try {
    await supabase.functions.invoke("slack-notify", {
      body: { event, data },
    });
  } catch (_) {
    // Silent
  }
}

async function writeAuditLog(
  supabase: any,
  log: {
    function_name: string;
    booking_id?: string;
    invoice_id?: string;
    recipient_type?: string;
    mollie_org_id?: string;
    amount?: number;
    status: string;
    error_message?: string;
    mollie_payment_id?: string;
    metadata?: Record<string, unknown>;
  }
) {
  try {
    await supabase.from("payment_audit_log").insert(log);
  } catch (_) {
    logStep("Failed to write audit log", { error: String(_) });
  }
}

async function refreshTokenIfNeeded(
  supabaseClient: any,
  accountData: any,
  entityType: 'trainer' | 'academy',
  entityId: string
): Promise<string | null> {
  const mollieClientId = Deno.env.get("MOLLIE_CLIENT_ID");
  const mollieClientSecret = Deno.env.get("MOLLIE_CLIENT_SECRET");

  if (!mollieClientId || !mollieClientSecret) {
    logStep("Mollie credentials not configured for refresh");
    return accountData.access_token;
  }

  const tokenExpiresAt = new Date(accountData.token_expires_at);
  const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);

  if (tokenExpiresAt > fiveMinutesFromNow) {
    return accountData.access_token;
  }

  logStep("Token expired or expiring soon, refreshing", { expiresAt: tokenExpiresAt.toISOString() });

  if (!accountData.refresh_token) {
    logStep("No refresh token available");
    return accountData.access_token;
  }

  try {
    const tokenResponse = await fetch('https://api.mollie.com/oauth2/tokens', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${btoa(`${mollieClientId}:${mollieClientSecret}`)}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: accountData.refresh_token,
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.json().catch(() => ({}));
      logStep("Token refresh failed", errorData);
      // Mollie rejected the refresh token (e.g. invalid_grant) — the connection is
      // broken and the academy/trainer cannot take online payments until they
      // reconnect. Alert ops; this was previously silent (logStep only).
      await notifySlack(supabaseClient, "edge_function_error", {
        function: "create-mollie-payment",
        error: "Mollie token refresh failed — payments will fail until the account reconnects",
        entityType,
        entityId,
        mollieStatus: tokenResponse.status,
        mollieError: (errorData as { error?: string })?.error ?? null,
      });
      return accountData.access_token;
    }

    const tokens = await tokenResponse.json();
    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    const tableName = entityType === 'trainer' ? 'trainer_mollie_accounts' : 'academy_mollie_accounts';
    const idColumn = entityType === 'trainer' ? 'trainer_id' : 'academy_profile_id';

    await supabaseClient
      .from(tableName)
      .update({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: newExpiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq(idColumn, entityId);

    logStep("Token refreshed successfully");
    return tokens.access_token;
  } catch (error) {
    logStep("Error refreshing token", { error: String(error) });
    return accountData.access_token;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const mollieApiKey = Deno.env.get("MOLLIE_API_KEY");
    if (!mollieApiKey) throw new Error("MOLLIE_API_KEY is not set");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Authenticate user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) throw new Error("Authentication failed");
    
    const user = userData.user;
    logStep("User authenticated", { userId: user.id, email: user.email });

    // Look up the player's profile ID (profiles.id != auth user ID)
    const { data: playerProfile, error: profileError } = await supabase
      .from("profiles")
      .select("id")
      .eq("user_id", user.id)
      .single();

    if (profileError || !playerProfile) {
      throw new Error("Player profile not found");
    }
    logStep("Player profile found", { profileId: playerProfile.id });

    const { slotId, amount: clientAmount, description, trainerId, redirectUrl, bookingIds, notes } = await req.json();
    logStep("Request payload", { slotId, trainerId, bookingIds, clientAmountIgnored: clientAmount });

    if (!slotId || !trainerId) {
      throw new Error("Missing required fields: slotId, trainerId");
    }

    const { data: trainerProfile } = await supabase
      .from("trainer_profiles")
      .select("id, hourly_rate")
      .eq("id", trainerId)
      .single();

    if (!trainerProfile?.id) {
      return new Response(
        JSON.stringify({ error: "Trainer not found" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const trainerProfileId = trainerProfile.id;
    const hourlyRate = trainerProfile.hourly_rate != null ? Number(trainerProfile.hourly_rate) : null;
    logStep("Trainer profile lookup", { trainerId, trainerProfileId });

    const requestedBookingIds: string[] = Array.isArray(bookingIds)
      ? bookingIds.filter((id: unknown) => typeof id === "string")
      : [];

    let expectedAmount: number;
    let preExistingBookingIds: string[] = [];
    // The slot's academy (when set) disambiguates a multi-academy trainer so the charge routes to
    // the SAME org the webhook will confirm against (Codex F3). Null → unchanged behaviour.
    let recipientAcademyProfileId: string | null = null;

    if (requestedBookingIds.length > 0) {
      const { data: existingBookings, error: bookingsError } = await supabase
        .from("bookings")
        .select(`
          id, player_id, payment_status, status, slot_id,
          availability_slots!inner(
            id, trainer_id, academy_profile_id, cyclus_id, price_per_session, start_time, end_time,
            max_participants, allow_single_booking
          )
        `)
        .in("id", requestedBookingIds);

      if (bookingsError || !existingBookings?.length) {
        return new Response(
          JSON.stringify({ error: "Bookings not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (existingBookings.length !== requestedBookingIds.length) {
        return new Response(
          JSON.stringify({ error: "Invalid booking IDs" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      for (const b of existingBookings) {
        if (b.player_id !== playerProfile.id) {
          return new Response(
            JSON.stringify({ error: "Forbidden: booking does not belong to player" }),
            { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        if (!["pending"].includes(b.payment_status)) {
          return new Response(
            JSON.stringify({ error: "Booking is not pending payment" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        // 'payment_pending' = a STRICT rebook HOLD (A1/A2) — it IS payable (the player is paying for
        // it right now); the webhook commits it to confirmed/paid. Excluding it broke strict accept.
        if (!["pending", "confirmed", "payment_pending"].includes(b.status)) {
          return new Response(
            JSON.stringify({ error: "Booking is not eligible for payment" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        const slot = b.availability_slots as SlotPricingInput & {
          id: string;
          trainer_id: string;
          cyclus_id: string | null;
        };
        if (slot.trainer_id !== trainerId) {
          return new Response(
            JSON.stringify({ error: "Trainer does not match booking slot" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      if (!existingBookings.some((row) => row.slot_id === slotId)) {
        return new Response(
          JSON.stringify({ error: "slotId must match a booking in bookingIds" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const slots = existingBookings.map((b) => b.availability_slots as SlotPricingInput & { cyclus_id: string | null; academy_profile_id: string | null });
      // All slots in a cyclus share one academy; use it to disambiguate a multi-academy trainer.
      recipientAcademyProfileId = slots[0]?.academy_profile_id ?? null;
      const cyclusIds = [...new Set(slots.map((s) => s.cyclus_id).filter(Boolean))];
      let splitPayment = false;

      if (cyclusIds.length === 1 && cyclusIds[0]) {
        const { data: cycle } = await supabase
          .from("cycles")
          .select("settings")
          .eq("id", cyclusIds[0])
          .maybeSingle();
        const settings = (cycle?.settings as Record<string, unknown>) || {};
        splitPayment = settings.split_payment === true;
      }

      const total = computeCyclusTotalFromSlots(slots, hourlyRate);
      if (splitPayment) {
        const slotIds = [...new Set(existingBookings.map((b) => b.slot_id))];
        // Split by DISTINCT participants, not booking rows. A multi-session
        // cycle has players×sessions rows, so counting rows divided the cycle
        // far too many ways and massively undercharged each payer.
        const { data: participantRows } = await supabase
          .from("bookings")
          .select("player_id, guest_player_id")
          .in("slot_id", slotIds)
          // Include strict HOLDS ('payment_pending') as committed participants — else the FIRST
          // payer of a split+strict cycle is divided by too few players and overcharged.
          .in("status", ["pending", "confirmed", "payment_pending"]);
        const distinctPlayers = new Set(
          (participantRows || [])
            .map((b) => b.player_id ?? b.guest_player_id)
            .filter(Boolean),
        ).size;
        expectedAmount = applySplitPayment(total, distinctPlayers || 1);
      } else {
        expectedAmount = total;
      }

      preExistingBookingIds = requestedBookingIds;
      logStep("Server-computed cyclus amount", { expectedAmount, splitPayment, total });
    } else {
      const { data: slot, error: slotError } = await supabase
        .from("availability_slots")
        .select("id, trainer_id, academy_profile_id, price_per_session, start_time, end_time, max_participants, allow_single_booking")
        .eq("id", slotId)
        .single();

      if (slotError || !slot) {
        return new Response(
          JSON.stringify({ error: "Slot not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (slot.trainer_id !== trainerId) {
        return new Response(
          JSON.stringify({ error: "Trainer does not match slot" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      recipientAcademyProfileId = (slot as { academy_profile_id: string | null }).academy_profile_id ?? null;
      expectedAmount = computeSingleSlotPaymentAmount(slot, hourlyRate, 1);
      logStep("Server-computed single-slot amount", { expectedAmount });
    }

    if (expectedAmount <= 0) {
      return new Response(
        JSON.stringify({ error: "Invalid payment amount" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (clientAmount != null && !amountsMatch(expectedAmount, Number(clientAmount))) {
      logStep("Client amount ignored (mismatch)", { clientAmount, expectedAmount });
    }

    // Check if trainer is part of an active academy
    let recipientAccessToken: string | null = null;
    let recipientType: 'trainer' | 'academy' | null = null;
    let mollieOrgId: string | null = null;
    let platformFee = 1.00; // Default to starter fee (€1.00)

    if (trainerProfileId) {
      // First check if trainer is part of an active academy. When the slot names an academy,
      // filter by it so a multi-academy trainer routes to the RIGHT one; the webhook applies the
      // identical filter off the same slot.academy_profile_id, so charge org == confirm org
      // (Codex F3). Null → no-op, unchanged.
      let academyTrainerQuery = supabase
        .from("academy_trainers")
        .select(`
          academy_profile_id,
          status,
          academy:academy_profiles(id, platform_fee_override)
        `)
        .eq("trainer_profile_id", trainerProfileId)
        .eq("status", "active");
      if (recipientAcademyProfileId) {
        academyTrainerQuery = academyTrainerQuery.eq("academy_profile_id", recipientAcademyProfileId);
      }
      const { data: academyTrainer } = await academyTrainerQuery.maybeSingle();

      if (academyTrainer?.academy_profile_id) {
        logStep("Trainer is part of academy", { academyId: academyTrainer.academy_profile_id });
        
        // Get academy's Mollie account (need access_token for Platform model)
        const { data: academyMollie } = await supabase
          .from("academy_mollie_accounts")
          .select("mollie_organization_id, charges_enabled, access_token, refresh_token, token_expires_at")
          .eq("academy_profile_id", academyTrainer.academy_profile_id)
          .eq("onboarding_complete", true)
          .single();

        if (academyMollie?.access_token && academyMollie?.charges_enabled) {
          recipientAccessToken = await refreshTokenIfNeeded(supabase, academyMollie, 'academy', academyTrainer.academy_profile_id);
          recipientType = 'academy';
          mollieOrgId = academyMollie.mollie_organization_id;
          logStep("Using academy Mollie account", { organizationId: academyMollie.mollie_organization_id });

          // Check academy's platform fee override
          const academy = academyTrainer.academy as { platform_fee_override?: number | null };
          if (academy?.platform_fee_override !== null && academy?.platform_fee_override !== undefined) {
            platformFee = Number(academy.platform_fee_override);
            logStep("Using academy fee override", { platformFee });
          } else {
            // Use academy tier fee (€0.50 for academies)
            const { data: plan } = await supabase
              .from("subscription_plans")
              .select("platform_fee_flat")
              .eq("tier", "academy")
              .eq("plan_type", "trainer")
              .eq("is_active", true)
              .single();

            if (plan?.platform_fee_flat !== null && plan?.platform_fee_flat !== undefined) {
              platformFee = Number(plan.platform_fee_flat);
            }
            logStep("Using academy tier fee", { platformFee });
          }
        }
      }
    }

    // If not routed to academy, check trainer's own Mollie account
    if (!recipientAccessToken && trainerProfileId) {
      const { data: trainerMollie } = await supabase
        .from("trainer_mollie_accounts")
        .select("mollie_organization_id, access_token, refresh_token, token_expires_at")
        .eq("trainer_id", trainerProfileId)
        .eq("onboarding_complete", true)
        .single();

      if (trainerMollie?.access_token) {
        recipientAccessToken = await refreshTokenIfNeeded(supabase, trainerMollie, 'trainer', trainerProfileId);
        recipientType = 'trainer';
        mollieOrgId = trainerMollie.mollie_organization_id;
        logStep("Using trainer Mollie account", { organizationId: trainerMollie.mollie_organization_id });

        // Get trainer's fee override or tier-based default
        const { data: trainerProfileData } = await supabase
          .from("trainer_profiles")
          .select("platform_fee_override, subscription_status")
          .eq("id", trainerProfileId)
          .single();

        if (trainerProfileData?.platform_fee_override !== null && trainerProfileData?.platform_fee_override !== undefined) {
          platformFee = Number(trainerProfileData.platform_fee_override);
          logStep("Using trainer fee override", { platformFee });
        } else {
          // Look up fee from subscription_plans based on status
          const tier = trainerProfileData?.subscription_status === "active" 
            ? "professional" 
            : "starter";
            
          const { data: plan } = await supabase
            .from("subscription_plans")
            .select("platform_fee_flat")
            .eq("tier", tier)
            .eq("plan_type", "trainer")
            .eq("is_active", true)
            .single();
            
          if (plan?.platform_fee_flat !== null && plan?.platform_fee_flat !== undefined) {
            platformFee = Number(plan.platform_fee_flat);
          }
          logStep("Using tier-based fee", { tier, platformFee });
        }
      }
    }

    // CRITICAL: If no connected Mollie account found, refuse to create payment
    // This prevents funds from accidentally going to the platform account
    if (!recipientAccessToken) {
      const errorMsg = "No connected payment account found for this trainer/academy. Payment cannot be processed.";
      logStep("BLOCKED: No Mollie account", { trainerId, trainerProfileId });
      
      await writeAuditLog(supabase, {
        function_name: "create-mollie-payment",
        recipient_type: null,
        amount: expectedAmount,
        status: "blocked_no_account",
        error_message: errorMsg,
        metadata: { trainerId, trainerProfileId, slotId },
      });

      await notifySlack(supabase, "edge_function_error", {
        function: "create-mollie-payment",
        error: errorMsg,
        trainerId,
      });

      return new Response(
        JSON.stringify({ error: "no_mollie_account", message: "Online betaling is niet beschikbaar. De trainer heeft nog geen betaalaccount gekoppeld." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let bookingId: string;
    const allBookingIds: string[] = [...preExistingBookingIds];
    // If we supersede a prior payment below (drift-cancel / non-open fall-through), its
    // id salts the idempotency key so a re-price-back-to-original within Mollie's 1h
    // window can't replay the now-dead checkout. Unset on the plain timeout-retry path
    // (no prior id), so that path stays deterministic and Mollie replays as intended.
    let recreatedAfterPaymentId: string | null = null;

    if (allBookingIds.length > 0) {
      bookingId = allBookingIds[0];
      logStep("Using existing bookings", { bookingIds: allBookingIds });

      // M-15: before minting a payment, reuse/refuse based on the bookings' current
      // payment. A sequential retry (user clicks "pay" again) or a paid-but-not-yet-
      // webhooked state otherwise creates a SECOND payment; the DB keeps only the
      // newest id, so the webhook can't route the first — real money taken, booking
      // stays unpaid, and a duplicate payable checkout exists.
      const { data: priorState } = await supabase
        .from("bookings")
        .select("mollie_payment_id, payment_status")
        .eq("id", bookingId)
        .maybeSingle();

      const probeTestParam = mollieApiKey.startsWith("test_") ? "?testmode=true" : "";

      if (priorState?.payment_status === "paid") {
        logStep("Booking already paid — refusing new payment", { bookingId });
        return new Response(
          JSON.stringify({ error: "already_paid", message: "Deze boeking is al betaald." }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (priorState?.mollie_payment_id) {
        // Consumed only if we fall through to create a fresh payment (the reuse-open and
        // already-paid branches return early); marks the payment this request supersedes.
        recreatedAfterPaymentId = priorState.mollie_payment_id;
        try {
          const probe = await fetch(
            `https://api.mollie.com/v2/payments/${priorState.mollie_payment_id}${probeTestParam}`,
            { headers: { Authorization: `Bearer ${recipientAccessToken}` } }
          );
          if (probe.ok) {
            const prior = await probe.json();
            const priorValue = Number(prior.amount?.value);
            if (prior.status === "paid") {
              logStep("Prior payment already paid — refusing new payment", { paymentId: prior.id });
              return new Response(
                JSON.stringify({ error: "already_paid", message: "Deze boeking is al betaald." }),
                { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
              );
            }
            if (prior.status === "open" && Number.isFinite(priorValue) && Math.abs(priorValue - expectedAmount) <= 0.01) {
              logStep("Reusing existing open payment for bookings", { paymentId: prior.id });
              return new Response(
                JSON.stringify({ paymentId: prior.id, bookingId, checkoutUrl: prior._links?.checkout?.href, existing: true }),
                { headers: { ...corsHeaders, "Content-Type": "application/json" } }
              );
            }
            if (prior.status === "open") {
              // Amount drifted — cancel the stale checkout before issuing a fresh one.
              try {
                await fetch(`https://api.mollie.com/v2/payments/${priorState.mollie_payment_id}${probeTestParam}`, {
                  method: "DELETE",
                  headers: { Authorization: `Bearer ${recipientAccessToken}` },
                });
                logStep("Cancelled stale open payment (amount drift)", { paymentId: prior.id });
              } catch (cancelErr) {
                logStep("Failed to cancel stale payment", { error: String(cancelErr) });
              }
            }
          }
        } catch (probeErr) {
          logStep("Error probing prior payment, will create new", { error: String(probeErr) });
        }
      }

      // Distribute the charged total across the bookings to the cent so their
      // sum equals exactly what Mollie is charged. The webhook verifies
      // sum(payment_amount) == amount paid; naive round(total/N) per row drifts
      // by up to N/2 cents and made that guard reject legitimate payments.
      const totalCents = Math.round(expectedAmount * 100);
      const n = allBookingIds.length;
      const baseCents = Math.floor(totalCents / n);
      const remainderCents = totalCents - baseCents * n;
      for (let i = 0; i < n; i++) {
        const cents = baseCents + (i < remainderCents ? 1 : 0);
        const { error: amountUpdateError } = await supabase
          .from("bookings")
          .update({ payment_amount: cents / 100 })
          .eq("id", allBookingIds[i]);
        if (amountUpdateError) {
          throw new Error(`Failed to set payment amount: ${amountUpdateError.message}`);
        }
      }
      logStep("Payment amounts distributed across cyclus bookings", { totalCents, count: n });
    } else {
      // Capacity-gated insert: the service-role client bypasses
      // enforce_booking_slot_tier, so route through book_slot_for_payment which
      // takes the per-slot advisory lock + capacity check before inserting.
      // The page no longer inserts the booking (Option A boundary), so forward
      // the player's note here.
      const baseArgs = { _slot_id: slotId, _player_id: playerProfile.id, _payment_amount: expectedAmount };
      const noteVal = typeof notes === "string" && notes.trim() ? notes.trim() : null;
      let { data: newBookingId, error: bookingError } = await supabase.rpc("book_slot_for_payment", {
        ...baseArgs,
        _notes: noteVal,
      });
      // Deploy-gap resilience: if the migration adding `_notes` isn't applied yet,
      // PostgREST can't find the 4-arg overload (PGRST202 / 42883). Retry the
      // pre-notes 3-arg signature so booking creation never breaks on deploy order.
      if (
        bookingError &&
        (bookingError.code === "PGRST202" ||
          bookingError.code === "42883" ||
          (bookingError.message || "").includes("book_slot_for_payment"))
      ) {
        logStep("book_slot_for_payment _notes overload missing — retrying 3-arg", {});
        ({ data: newBookingId, error: bookingError } = await supabase.rpc("book_slot_for_payment", baseArgs));
      }

      if (bookingError) {
        if ((bookingError.message || "").includes("slot_full")) {
          logStep("Refusing payment — slot full", { slotId });
          return new Response(JSON.stringify({ error: "slot_full" }), {
            status: 409,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        throw new Error(`Failed to create booking: ${bookingError.message}`);
      }
      bookingId = newBookingId as string;
      allBookingIds.push(bookingId);
      logStep("Booking created", { bookingId, payment_amount: expectedAmount });
    }

    const origin = redirectUrl || req.headers.get("origin") || "https://padeltrainer.ai";

    // Build payment request
    const paymentData: Record<string, unknown> = {
      amount: {
        currency: "EUR",
        value: expectedAmount.toFixed(2),
      },
      description: description || `Padel lesson booking`,
      redirectUrl: `${origin}/app/booking-success?booking_id=${bookingId}`,
      cancelUrl: `${origin}/app/booking-cancelled?booking_id=${bookingId}`,
      webhookUrl: `${supabaseUrl}/functions/v1/mollie-webhook`,
      metadata: {
        booking_id: bookingId,
        // Canonically ordered: Mollie diffs the RAW body against the Idempotency-Key,
        // so booking_ids order MUST be deterministic across a retry. It is stable today
        // (allBookingIds = the client-supplied array), but sorting a copy pins the
        // invariant so a future refactor sourcing it from a DB read can't reintroduce a
        // same-key/different-body 400. Order is set-semantic to the webhook.
        booking_ids: [...allBookingIds].sort(),
        player_id: playerProfile.id,
        trainer_id: trainerId,
        recipient_type: recipientType,
      },
    };

    // Fetch the connected account's profile ID (required by Mollie for OAuth payments)
    let mollieProfileId: string | null = null;
    try {
      const profileResp = await fetch('https://api.mollie.com/v2/profiles', {
        headers: { 'Authorization': `Bearer ${recipientAccessToken}` },
      });
      if (profileResp.ok) {
        const profileData = await profileResp.json();
        if (profileData._embedded?.profiles?.length > 0) {
          mollieProfileId = profileData._embedded.profiles[0].id;
          logStep("Mollie profile found via list", { profileId: mollieProfileId });
        }
      } else {
        const profileErrorText = await profileResp.text();
        logStep("Could not fetch Mollie profiles", { status: profileResp.status, error: profileErrorText });
      }
    } catch (err) {
      logStep("Error fetching Mollie profiles", { error: String(err) });
    }

    if (!mollieProfileId) {
      const errorMsg = "No Mollie profile found for connected account. Payment cannot be processed.";
      logStep("BLOCKED: No Mollie profile", { recipientType, mollieOrgId });

      await writeAuditLog(supabase, {
        function_name: "create-mollie-payment",
        booking_id: bookingId,
        recipient_type: recipientType,
        mollie_org_id: mollieOrgId,
        amount: expectedAmount,
        status: "blocked_no_profile",
        error_message: errorMsg,
      });

      return new Response(
        JSON.stringify({ error: "missing_mollie_profile", message: "Betaalprofiel niet geconfigureerd." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Cap fee: must be strictly less than amount minus Mollie's transaction costs
    const maxFee = Math.max(0, expectedAmount - 0.30);
    const effectiveFee = Math.min(platformFee, maxFee);

    paymentData.profileId = mollieProfileId;
    if (effectiveFee > 0) {
      paymentData.applicationFee = {
        amount: {
          currency: "EUR",
          value: effectiveFee.toFixed(2),
        },
        description: "Platform fee",
      };
    }
    logStep("Application fee configured", { recipientType, effectiveFee, profileId: mollieProfileId, mollieOrgId });

    // Detect test mode and add testmode flag for OAuth tokens
    const isTestMode = mollieApiKey.startsWith("test_");
    if (isTestMode) {
      paymentData.testmode = true;
      logStep("Test mode enabled for OAuth payment");
    }

    // G2: idempotency key = fingerprint of the exact body (see _shared/mollie-idempotency.ts).
    // A timeout + retry that re-sends the SAME body replays the ORIGINAL payment (no
    // duplicate checkout); a genuinely different body (a fresh pre-booking id, or a
    // split amount that drifted under concurrency) gets a NEW key, so Mollie never
    // 400s on same-key/different-body. The existing-bookings re-pay path — the classic
    // double-charge vector — has a stable body and is fully covered. The salt (id of any
    // just-superseded payment) keeps a re-price-back-to-original within 1h from replaying
    // the now-dead checkout.
    const idempotencyKey = await mollieIdempotencyKey(
      recreatedAfterPaymentId ? `cmp:recreate:${recreatedAfterPaymentId}` : "cmp",
      paymentData,
    );

    // Create payment via Mollie API using connected account's token
    const mollieResponse = await fetch("https://api.mollie.com/v2/payments", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${recipientAccessToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(paymentData),
    });

    if (!mollieResponse.ok) {
      const errorText = await mollieResponse.text();
      
      await writeAuditLog(supabase, {
        function_name: "create-mollie-payment",
        booking_id: bookingId,
        recipient_type: recipientType,
        mollie_org_id: mollieOrgId,
        amount: expectedAmount,
        status: "error",
        error_message: errorText.slice(0, 500),
      });

      throw new Error(`Mollie API error: ${errorText}`);
    }

    const payment = await mollieResponse.json();
    // Mollie flags a deduped retry with this header — logging it proves the G2 guard fired.
    const idempotentReplayed = mollieResponse.headers.get("Idempotent-Replayed") === "true";
    logStep("Mollie payment created", { paymentId: payment.id, recipientType, mollieOrgId, idempotentReplayed });

    // Update booking(s) with Mollie payment ID
    await supabase
      .from("bookings")
      .update({ mollie_payment_id: payment.id })
      .in("id", allBookingIds);

    // Write success audit log
    await writeAuditLog(supabase, {
      function_name: "create-mollie-payment",
      booking_id: bookingId,
      recipient_type: recipientType,
      mollie_org_id: mollieOrgId,
      amount: expectedAmount,
      status: "success",
      mollie_payment_id: payment.id,
      metadata: { bookingIds: allBookingIds, profileId: mollieProfileId, fee: effectiveFee, idempotentReplayed },
    });

    // Slack notification for successful payment creation
    await notifySlack(supabase, "payment_created", {
      type: "booking",
      recipientType,
      mollieOrgId,
      amount: `€${expectedAmount.toFixed(2)}`,
      fee: `€${effectiveFee.toFixed(2)}`,
      bookings: allBookingIds.length,
      paymentId: payment.id,
    });

    return new Response(
      JSON.stringify({
        paymentId: payment.id,
        bookingId: bookingId,
        checkoutUrl: payment._links.checkout.href,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    await notifySlack(
      createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!),
      "edge_function_error",
      { function: "create-mollie-payment", error: message.slice(0, 500) }
    );
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
