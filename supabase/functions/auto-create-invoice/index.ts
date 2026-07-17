import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { requireUser, corsHeaders as sharedCors } from "../_shared/auth.ts";
import { getEnvServiceRoleKey } from "../_shared/service-role-auth.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";
import {
  isInvoiceBusinessProfileComplete,
  resolveAutoCreateBusinessGate,
} from "../_shared/invoice-business.ts";
import {
  resolveInvoiceUnitPrice,
  splitAmongPlayersForInvoiceCreate,
} from "../_shared/invoice-split-pricing.ts";
import { resolveSplitDivisorFromSlots, shouldSkipExtrasForPaidExtrasBookings } from "../_shared/booking-pricing.ts";
import { applyDedupRecipientScope, type RecipientScopableQuery } from "../_shared/invoice-dedupe-recipient.ts";

const corsHeaders = sharedCors;

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[AUTO-CREATE-INVOICE] ${step}`, details ? JSON.stringify(details) : "");
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const supabase = auth.supabase;

  try {

    const body = await req.json();
    const bookingIds: string[] = body.bookingIds || (body.bookingId ? [body.bookingId] : []);
    const asDraft: boolean = body.asDraft === true;
    const requestedSplitAmongPlayers: number | null = body.splitAmongPlayers || null;

    if (bookingIds.length === 0) {
      logStep("No booking IDs provided");
      return new Response(JSON.stringify({ error: "No booking IDs" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logStep("Processing bookings", { bookingIds, asDraft, requestedSplitAmongPlayers });

    // Fetch all bookings with details
    const { data: bookings, error: bookingsError } = await supabase
      .from("bookings")
      .select(`
        id,
        player_id,
        guest_player_id,
        slot_id,
        payment_amount,
        payment_status,
        availability_slots!inner(
          trainer_id,
          academy_profile_id,
          start_time,
          end_time,
          location_id,
          price_per_session,
          cyclus_id,
          cyclus_name,
          prices_include_vat,
          extra_costs,
          split_payment,
          max_participants,
          locations(name, city)
        )
      `)
      .in("id", bookingIds);

    if (bookingsError || !bookings || bookings.length === 0) {
      logStep("Failed to fetch bookings", { error: bookingsError?.message });
      return new Response(JSON.stringify({ error: "Bookings not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get trainer ID from first booking
    const slot = bookings[0].availability_slots as any;
    const trainerId = slot.trainer_id;

    // Authorization: caller must be admin, the slot's trainer, or a manager
    // of the slot's academy. Service-role calls (cron) bypass this check.
    if (!auth.isServiceRole) {
      const userId = auth.user.id;
      const trainerSlotIds = new Set(bookings.map((b: any) => b.availability_slots?.trainer_id).filter(Boolean));
      const academyIds = new Set(bookings.map((b: any) => b.availability_slots?.academy_profile_id).filter(Boolean));

      const [{ data: trainerProfile }, { data: adminRow }] = await Promise.all([
        supabase.from("trainer_profiles").select("id").eq("user_id", userId).maybeSingle(),
        supabase.from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle(),
      ]);
      const isAdmin = !!adminRow;
      const callerTrainerId = trainerProfile?.id ?? null;
      const ownsAllAsTrainer = callerTrainerId
        ? [...trainerSlotIds].every((tid) => tid === callerTrainerId)
        : false;

      let ownsViaAcademy = false;
      if (!isAdmin && !ownsAllAsTrainer && academyIds.size > 0) {
        const { data: managed } = await supabase
          .from("academy_managers")
          .select("academy_profile_id")
          .eq("user_id", userId);
        const managedSet = new Set((managed ?? []).map((m: any) => m.academy_profile_id));
        ownsViaAcademy = [...academyIds].every((aid) => managedSet.has(aid));
      }

      if (!isAdmin && !ownsAllAsTrainer && !ownsViaAcademy) {
        logStep("Forbidden: caller does not own these bookings", { userId });
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }


    // Auto-detect split payment from slot if not explicitly passed. G5: split by the
    // cycle's COURT CAPACITY (frozen), not the live player count — same divisor as the
    // charge path + recalc_cycle_split_count, so a mixed Mollie/invoice cycle stays
    // consistent. divisor 1 ⇒ no split.
    let splitAmongPlayers: number | null = requestedSplitAmongPlayers;
    if (!splitAmongPlayers && slot.split_payment === true) {
      const divisor = resolveSplitDivisorFromSlots(
        bookings.map((b) => b.availability_slots as { max_participants?: number | null }),
      );
      if (divisor > 1) {
        splitAmongPlayers = divisor;
        logStep("Auto-detected split from slot capacity", { splitAmongPlayers });
      }
    }

    // Do not divide already-split booking.payment_amount again (per-player invoice batches)
    splitAmongPlayers = splitAmongPlayersForInvoiceCreate(bookings, splitAmongPlayers);
    const splitLabel =
      requestedSplitAmongPlayers && requestedSplitAmongPlayers > 1
        ? ` (1/${requestedSplitAmongPlayers})`
        : splitAmongPlayers && splitAmongPlayers > 1
          ? ` (1/${splitAmongPlayers})`
          : "";

    // Invoice party = the SLOT's academy_profile_id, the SAME key the CHARGE uses
    // (resolveSlotRecipient / create-mollie-payment), so charge-org == invoice-org. An
    // INDEPENDENT slot (academy_profile_id null) invoices the TRAINER — it must NOT fall
    // back to the trainer's academy via an unfiltered academy_trainers lookup, which would
    // stamp the receipt (number sequence + business identity/IBAN) to the academy while the
    // money went to the trainer. length 1 = one academy; 0 = all independent; >1 = a mixed
    // anomaly → trainer (never silently pick one academy over another).
    const slotAcademyIds = [
      ...new Set(
        bookings
          .map((b) => (b.availability_slots as { academy_profile_id?: string | null })?.academy_profile_id)
          .filter(Boolean),
      ),
    ] as string[];
    const academyProfileId: string | null = slotAcademyIds.length === 1 ? slotAcademyIds[0] : null;

    // Fetch trainer profile with business info
    const { data: trainerProfile, error: trainerError } = await supabase
      .from("trainer_profiles")
      .select("id, user_id, business_name, business_address, kvk_number, btw_number, iban, bic, payment_terms_days, default_vat_rate, invoice_forward_emails, invoice_prefix, invoice_next_number, invoice_include_year")
      .eq("id", trainerId)
      .single();

    if (trainerError || !trainerProfile) {
      logStep("Trainer profile not found", { trainerId });
      return new Response(JSON.stringify({ error: "Trainer not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // If academy exists, try to use academy business info for invoicing
    let invoiceProfile: {
      business_name: string | null;
      business_address: string | null;
      kvk_number: string | null;
      btw_number: string | null;
      iban: string | null;
      bic: string | null;
      payment_terms_days: number | null;
      default_vat_rate: number | null;
      invoice_forward_emails: string[] | null;
      invoice_prefix: string | null;
      invoice_next_number: number | null;
    } = trainerProfile;
    let invoiceProfileTable = "trainer_profiles";
    let invoiceProfileId = trainerId;

    if (academyProfileId) {
      const { data: academyProfile } = await supabase
        .from("academy_profiles")
        .select("business_name, business_address, kvk_number, btw_number, iban, bic, payment_terms_days, default_vat_rate, invoice_forward_emails, invoice_prefix, invoice_next_number, invoice_include_year")
        .eq("id", academyProfileId)
        .single();

      if (academyProfile) {
        invoiceProfile = academyProfile;
        invoiceProfileTable = "academy_profiles";
        invoiceProfileId = academyProfileId;
        logStep("Using academy profile for invoice", { academyProfileId });
      }
    }

    const businessGate = resolveAutoCreateBusinessGate(asDraft, invoiceProfile);
    if (businessGate.skip) {
      logStep("Business info incomplete, skipping non-draft invoice", {
        profileTable: invoiceProfileTable,
        profileId: invoiceProfileId,
        asDraft,
        complete: isInvoiceBusinessProfileComplete(invoiceProfile),
      });
      return new Response(
        JSON.stringify({ skipped: true, reason: businessGate.reason ?? "incomplete_business_info" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    const incompleteBusinessProfile = businessGate.incompleteBusinessProfile;
    if (incompleteBusinessProfile) {
      logStep("Creating draft with incomplete business profile", {
        profileTable: invoiceProfileTable,
        profileId: invoiceProfileId,
      });
    }

    // Get player info — support both player_id and guest_player_id
    const playerId = bookings[0].player_id;
    const guestPlayerId = bookings[0].guest_player_id;
    let playerName = "Unknown Player";
    let playerBusinessName: string | null = null;
    let playerAddress: string | null = null;
    let playerBtwNumber: string | null = null;

    if (playerId || guestPlayerId) {
      // Single source of truth: the person's own name, but billing from the
      // linked profile first (FAM-02), so a snapshot can't go stale against an
      // edited parent profile.
      const { data: identityRows } = await supabase.rpc("get_invoice_recipient_identity", {
        _player_id: playerId ?? null,
        _guest_player_id: guestPlayerId ?? null,
        _academy_profile_id: academyProfileId ?? null,
      });
      const identity = Array.isArray(identityRows) ? identityRows[0] : identityRows;
      if (identity?.full_name) {
        playerName = identity.full_name;
      }
      playerBusinessName = identity?.billing_business_name || null;
      playerAddress = identity?.billing_address || null;
      playerBtwNumber = identity?.billing_btw_number || null;
    }

    // Build line items from bookings
    const vatRate = invoiceProfile.default_vat_rate ?? 21;

    // Check if all bookings belong to the same cyclus — bundle them
    const firstSlot = bookings[0].availability_slots as any;
    const sharedCyclusId = firstSlot.cyclus_id;
    const allSameCyclus = sharedCyclusId && bookings.every((b) => (b.availability_slots as any).cyclus_id === sharedCyclusId);

    let lineItems: { description: string; quantity: number; unit_price: number; date?: string }[];

    const resolveBookingPrice = (b: any): number => {
      const bSlot = b.availability_slots as any;
      return resolveInvoiceUnitPrice({
        paymentAmount: b.payment_amount,
        slotPrice: bSlot.price_per_session,
        splitAmongPlayers: requestedSplitAmongPlayers ?? splitAmongPlayers,
      });
    };

    if (allSameCyclus) {
      const cyclusName = firstSlot.cyclus_name || "Training cyclus";

      // Resolve price from ALL bookings, not just the first one
      const prices = bookings.map(resolveBookingPrice);
      const nonZeroPrices = prices.filter((p) => p > 0);
      const allSamePrice = nonZeroPrices.length > 0 && nonZeroPrices.every((p) => p === nonZeroPrices[0]);

      if (allSamePrice) {
        // All sessions have the same price — use bundled line item
        lineItems = [{
          description: `${cyclusName} (${bookings.length} weken)${splitLabel}`,
          quantity: bookings.length,
          unit_price: nonZeroPrices[0],
        }];
      } else if (nonZeroPrices.length > 0) {
        // Mixed prices or some missing — fall back to per-session line items
        lineItems = bookings.map((b) => {
          const bSlot = b.availability_slots as any;
          const startTime = new Date(bSlot.start_time);
          const locationName = bSlot.locations?.name || "";
          const price = resolveBookingPrice(b);
          return {
            description: `${cyclusName} - ${startTime.toLocaleDateString("nl-NL")} ${startTime.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}${locationName ? ` (${locationName})` : ""}`,
            quantity: 1,
            unit_price: price,
            date: startTime.toISOString().split("T")[0],
          };
        });
      } else {
        // No valid price found at all — skip invoice creation
        logStep("All bookings have zero price, skipping invoice", { bookingIds });
        return new Response(JSON.stringify({ skipped: true, reason: "missing_price_data" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    } else {
      lineItems = bookings.map((b) => {
        const bSlot = b.availability_slots as any;
        const startTime = new Date(bSlot.start_time);
        const locationName = bSlot.locations?.name || "";
        const description = bSlot.cyclus_name
          ? `${bSlot.cyclus_name} - ${startTime.toLocaleDateString("nl-NL")} ${startTime.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}${locationName ? ` (${locationName})` : ""}`
          : `Training sessie - ${startTime.toLocaleDateString("nl-NL")}`;

        const price = resolveBookingPrice(b);

        return {
          description,
          quantity: 1,
          unit_price: price,
          date: startTime.toISOString().split("T")[0],
        };
      });

      // If ALL line items are zero, skip
      if (lineItems.every((li) => li.unit_price === 0)) {
        logStep("All bookings have zero price, skipping invoice", { bookingIds });
        return new Response(JSON.stringify({ skipped: true, reason: "missing_price_data" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Check for extra costs from cycle settings, fall back to slot extra_costs
    let extraCosts: any[] | null = null;

    if (sharedCyclusId) {
      const { data: cycleData } = await supabase
        .from("cycles")
        .select("settings")
        .eq("id", sharedCyclusId)
        .maybeSingle();

      extraCosts = (cycleData?.settings as any)?.extra_costs || null;
    }

    // Fallback: use extra_costs from the first slot if no cycle-level costs
    if (!extraCosts || !Array.isArray(extraCosts) || extraCosts.length === 0) {
      const slotExtraCosts = (bookings[0].availability_slots as any).extra_costs;
      if (slotExtraCosts && Array.isArray(slotExtraCosts)) {
        extraCosts = slotExtraCosts;
      }
    }

    // Skip re-appending extras when payment_amount already includes them — the single-slot
    // pay-first paths (create-mollie-payment single-slot + create-guest-slot-payment) bake
    // sumSlotExtraCosts into payment_amount and stamp amount_includes_extras. Best-effort
    // read: a missing column / read error is treated as "not flagged" so behavior is unchanged
    // until the migration + charge fns are deployed (P1-5 / P2-7).
    let extrasAlreadyCharged = false;
    {
      const { data: extrasFlagRows, error: extrasFlagError } = await supabase
        .from("bookings")
        .select("id, amount_includes_extras")
        .in("id", bookingIds);
      if (extrasFlagError) {
        logStep("amount_includes_extras read failed — appending extras as before (non-fatal)", {
          error: extrasFlagError.message,
        });
      } else {
        extrasAlreadyCharged = shouldSkipExtrasForPaidExtrasBookings(
          (extrasFlagRows ?? []) as { amount_includes_extras?: boolean | null }[],
          allSameCyclus,
        );
      }
    }
    if (extrasAlreadyCharged) {
      logStep("Skipping extra_costs append — payment_amount already includes extras", { bookingIds });
    }

    if (!extrasAlreadyCharged && extraCosts && Array.isArray(extraCosts)) {
      const splitForExtras = requestedSplitAmongPlayers ?? splitAmongPlayers;
      for (const ec of extraCosts) {
        if (ec.description && ec.price > 0) {
          const isOneTime = ec.type === 'one_time';
          const ecUnitPrice = resolveInvoiceUnitPrice({
            paymentAmount: null,
            slotPrice: ec.price,
            splitAmongPlayers: splitForExtras,
          });
          lineItems.push({
            description: isOneTime ? ec.description : `${ec.description} (per sessie)`,
            quantity: isOneTime ? 1 : bookings.length,
            unit_price: ecUnitPrice,
            vat_rate: ec.vat_rate ?? vatRate,
          });
        }
      }
    }

    // Determine if prices include VAT
    const slotPricesIncludeVat = (bookings[0].availability_slots as any).prices_include_vat ?? true;

    // Calculate per-line-item VAT for multi-rate support
    const hasMultipleVatRates = lineItems.some((item: any) => (item.vat_rate ?? vatRate) !== vatRate);

    let subtotal: number;
    let vatAmount: number;
    let totalInclusive: number;
    const vatBreakdown: Record<number, { subtotal: number; vat: number }> = {};

    if (hasMultipleVatRates) {
      // Per-line-item VAT calculation
      let totalSub = 0;
      let totalVat = 0;

      for (const item of lineItems) {
        const lineTotal = item.quantity * item.unit_price;
        const lineVatRate = (item as any).vat_rate ?? vatRate;
        let lineSub: number;
        let lineVat: number;

        if (slotPricesIncludeVat) {
          lineSub = lineTotal / (1 + lineVatRate / 100);
          lineVat = lineTotal - lineSub;
        } else {
          lineSub = lineTotal;
          lineVat = lineSub * (lineVatRate / 100);
        }

        totalSub += lineSub;
        totalVat += lineVat;

        if (!vatBreakdown[lineVatRate]) {
          vatBreakdown[lineVatRate] = { subtotal: 0, vat: 0 };
        }
        vatBreakdown[lineVatRate].subtotal += lineSub;
        vatBreakdown[lineVatRate].vat += lineVat;
      }

      subtotal = Math.round(totalSub * 100) / 100;
      vatAmount = Math.round(totalVat * 100) / 100;
      totalInclusive = slotPricesIncludeVat 
        ? lineItems.reduce((sum, item) => sum + item.quantity * item.unit_price, 0)
        : Math.round((subtotal + vatAmount) * 100) / 100;

      // Round breakdown values
      for (const rate in vatBreakdown) {
        vatBreakdown[rate].subtotal = Math.round(vatBreakdown[rate].subtotal * 100) / 100;
        vatBreakdown[rate].vat = Math.round(vatBreakdown[rate].vat * 100) / 100;
      }
    } else {
      // Single VAT rate (existing behavior)
      const lineItemTotal = lineItems.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
      if (slotPricesIncludeVat) {
        totalInclusive = lineItemTotal;
        subtotal = totalInclusive / (1 + vatRate / 100);
        vatAmount = totalInclusive - subtotal;
      } else {
        subtotal = lineItemTotal;
        vatAmount = subtotal * (vatRate / 100);
        totalInclusive = subtotal + vatAmount;
      }
    }

    // Check if bookings are already paid (e.g. Mollie) — also drives the
    // dedupe paths below, which must sync a pre-existing invoice to paid.
    const allPaid = bookings.every((b) => b.payment_status === "paid");

    // M-27: a deduped draft/sent invoice whose bookings are ALL paid must be
    // synced to paid before we return it — otherwise the paid bookings stay
    // attached to an unpaid invoice and the player is asked to pay again when
    // it is (auto-)sent later. Only safe when every booking ON THE INVOICE is
    // paid: the overlap dedupe can match an invoice billing extra bookings
    // outside this request, so those are verified too.
    const syncDedupedInvoiceToPaid = async (existing: {
      id: string;
      status: string | null;
      sent_at: string | null;
      booking_ids: string[] | null;
      total: number | null;
    }): Promise<void> => {
      if (!allPaid || (existing.status !== "draft" && existing.status !== "sent")) return;
      const extraIds = (existing.booking_ids ?? []).filter((id) => !bookingIds.includes(id));
      let extraPaidSum = 0;
      if (extraIds.length > 0) {
        const { data: extraBookings, error: extraError } = await supabase
          .from("bookings")
          .select("id, payment_status, payment_amount")
          .in("id", extraIds);
        const extraAllPaid = !extraError &&
          (extraBookings ?? []).length === extraIds.length &&
          (extraBookings ?? []).every((b: { payment_status: string | null }) => b.payment_status === "paid");
        if (!extraAllPaid) return;
        extraPaidSum = (extraBookings ?? []).reduce(
          (sum: number, b: { payment_amount: number | null }) => sum + (Number(b.payment_amount) || 0),
          0,
        );
      }
      // Review guard: a draft/sent invoice is editable — its total may have
      // drifted from what the bookings actually paid (extra line items added
      // during review). Only auto-mark paid when the invoice total matches the
      // paid sum within the per-booking cent tolerance; otherwise leave it for
      // a human and log loudly.
      const invoiceBookingCount = (existing.booking_ids ?? []).length || 1;
      const requestPaidSum = bookings
        .filter((b) => (existing.booking_ids ?? []).includes(b.id))
        .reduce((sum, b) => sum + (Number(b.payment_amount) || 0), 0);
      const paidSum = requestPaidSum + extraPaidSum;
      const tolerance = Math.max(0.01, invoiceBookingCount * 0.01);
      if (Math.abs(paidSum - (Number(existing.total) || 0)) > tolerance) {
        logStep("Deduped invoice NOT synced to paid: total drifted from paid sum", {
          invoiceId: existing.id, invoiceTotal: existing.total, paidSum, tolerance,
        });
        return;
      }
      const nowIso = new Date().toISOString();
      const { error: syncError } = await supabase
        .from("invoices")
        .update({ status: "paid", paid_at: nowIso, ...(existing.sent_at ? {} : { sent_at: nowIso }) })
        .eq("id", existing.id)
        .in("status", ["draft", "sent"]);
      if (syncError) {
        logStep("Failed to sync deduped invoice to paid (non-fatal)", { invoiceId: existing.id, error: syncError.message });
        return;
      }
      logStep("Deduped invoice synced to paid", { invoiceId: existing.id });
    };

    // Duplicate guard: check if an active invoice already exists for same trainer + recipient + bookings.
    //
    // DUAL-KEY recipients (both ids set) are DELIBERATELY skipped here and routed to
    // create_invoice_deduped, the single authority. A dual-keyed row belongs to the GUEST
    // (FAM-02) and may be split-frozen; only the RPC resolves that correctly (guest-exclusive,
    // freeze-aware, candidate-side guarded). A player-first fast-path would dedup a guest-owned
    // dual-key booking onto a PROFILE invoice and bypass every one of those protections.
    // Single-key recipients (pure-profile OR guest-only) are unambiguous — this filter matches
    // exactly the RPC's arm A / arm B (arm B is same-guest, freeze-blind, so a guest-only dedup
    // is identical under freeze) — so keep the fast-path for them (it avoids an invoice-number
    // gap on the common re-invoice dedup, which the RPC path cannot).
    const recipientFilter = (playerId && guestPlayerId)
      ? null
      : playerId
        ? { player_id: playerId }
        : guestPlayerId
          ? { guest_player_id: guestPlayerId }
          : null;

    if (recipientFilter) {
      const dupeQuery = supabase
        .from("invoices")
        .select("id, invoice_number, status, sent_at, booking_ids, total")
        .eq("trainer_id", trainerId)
        .not("status", "eq", "cancelled")
        // OVERLAP, not contains: any active invoice that already bills ANY of these
        // bookings is a duplicate risk. The old `.contains` only matched a SUPERSET,
        // so invoice [A] then a request for [A,B] both succeeded → A billed twice.
        .overlaps("booking_ids", bookingIds);

      if (recipientFilter.player_id) {
        // PURE-profile candidate only (== RPC arm A): a dual-key invoice (player_id=P
        // AND guest set) belongs to the GUEST, so a pure-profile create must not dedup
        // onto it. Moot under the single-shape-booking invariant, but keeps this
        // fast-path byte-equal to the RPC's arm A rather than broader.
        dupeQuery.eq("player_id", recipientFilter.player_id).is("guest_player_id", null);
      } else if (recipientFilter.guest_player_id) {
        // == RPC arm B: any active invoice on this guest key (guest-only OR dual-key).
        dupeQuery.eq("guest_player_id", recipientFilter.guest_player_id);
      }

      const { data: existingInvoices } = await dupeQuery;
      if (existingInvoices && existingInvoices.length > 0) {
        // Any overlapping active invoice blocks creation — never re-bill a booking.
        const exactMatch = existingInvoices.find(() => true);
        if (exactMatch) {
          logStep("Duplicate invoice found, skipping creation", {
            existingId: exactMatch.id,
            existingNumber: exactMatch.invoice_number,
          });
          await syncDedupedInvoiceToPaid(exactMatch);
          return new Response(
            JSON.stringify({ success: true, invoiceId: exactMatch.id, invoiceNumber: exactMatch.invoice_number, deduped: true }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }
    }

    // Generate invoice number using profile's custom prefix.
    // M-10: allocation is ATOMIC via the next_invoice_sequence RPC (a single
    // UPDATE ... RETURNING on the profile counter), replacing the old
    // read-increment-write that advanced the counter only AFTER insert — two
    // concurrent creators could mint the same legal number. The max-existing
    // scan is scoped to the NUMBERING profile: academy invoices scan
    // academy-wide (the old trainer-scoped scan missed siblings' numbers).
    const prefix = (invoiceProfile.invoice_prefix ?? "").trim();
    const year = new Date().getFullYear();
    const includeYear = invoiceProfile.invoice_include_year ?? true;
    const likePattern = prefix
      ? (includeYear ? `${prefix}-${year}-%` : `${prefix}-%`)
      : (includeYear ? `${year}-%` : '%');
    const numberingType = invoiceProfileTable === "academy_profiles" ? "academy" : "trainer";

    const buildInvoiceNumber = (sequence: number): string => {
      const seq = String(sequence).padStart(4, "0");
      const numParts: string[] = [];
      if (prefix) numParts.push(prefix);
      if (includeYear) numParts.push(String(year));
      numParts.push(seq);
      return numParts.join("-");
    };

    const allocateInvoiceNumber = async (): Promise<string> => {
      let scanQuery = supabase
        .from("invoices")
        .select("invoice_number")
        .like("invoice_number", likePattern)
        .order("invoice_number", { ascending: false })
        .limit(1);
      scanQuery = numberingType === "academy"
        ? scanQuery.eq("academy_profile_id", invoiceProfileId)
        : scanQuery.eq("trainer_id", trainerId);
      const { data: lastInvoice } = await scanQuery.maybeSingle();

      let minSequence = 1;
      if (lastInvoice?.invoice_number) {
        const parts = lastInvoice.invoice_number.split("-");
        const lastSeq = parseInt(parts[parts.length - 1] || "0");
        if (Number.isFinite(lastSeq)) minSequence = lastSeq + 1;
      }

      const { data: allocated, error: allocError } = await supabase.rpc("next_invoice_sequence", {
        p_profile_type: numberingType,
        p_profile_id: invoiceProfileId,
        p_min: minSequence,
      });
      if (allocError || typeof allocated !== "number") {
        throw new Error(`Failed to allocate invoice number: ${allocError?.message ?? "no sequence returned"}`);
      }
      return buildInvoiceNumber(allocated);
    };

    let invoiceNumber = await allocateInvoiceNumber();

    // Calculate due date
    const paymentTermsDays = invoiceProfile.payment_terms_days || 14;
    const invoiceDate = new Date();
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + paymentTermsDays);

    // Determine invoice status (allPaid computed above the dedupe guard)
    let invoiceStatus: string;
    if (allPaid) {
      invoiceStatus = "paid";
    } else if (asDraft) {
      invoiceStatus = "draft";
    } else {
      invoiceStatus = "sent";
    }

    // Insert invoice. On a NUMBER collision (another creator won the same
    // sequence in the window between scan and insert) re-allocate and retry —
    // the RPC has already advanced the counter, so each retry gets a fresh
    // number. Any other 23505 is the booking-set duplicate guard (handled below).
    // P1-6: creation is now ATOMIC per (trainer, recipient) via create_invoice_deduped,
    // which takes pg_advisory_xact_lock(hashtextextended(trainer||':'||recipient,0)) and does
    // the OVERLAP dedup recheck + INSERT in one transaction. This closes the non-transactional
    // read-then-insert race where two concurrent same-recipient calls with overlapping-but-
    // unequal booking sets (e.g. [A] and [A,B]) both passed the JS pre-check and both inserted,
    // billing booking A on two active invoices. The JS pre-check above stays as a fast-path;
    // the RPC is the real guard. On invoice-NUMBER collision the RPC re-raises 23505 with the
    // unique_invoice_number_per_* constraint name, so the reallocate-and-retry loop still fires.
    const invoicePayload = {
      trainer_id: trainerId,
      academy_profile_id: academyProfileId,
      invoice_number: invoiceNumber,
      invoice_date: invoiceDate.toISOString().split("T")[0],
      due_date: dueDate.toISOString().split("T")[0],
      player_id: playerId,
      guest_player_id: guestPlayerId || null,
      player_name: playerName,
      player_business_name: playerBusinessName,
      player_address: playerAddress,
      player_btw_number: playerBtwNumber,
      line_items: lineItems,
      subtotal: Math.round(subtotal * 100) / 100,
      vat_rate: vatRate,
      vat_amount: Math.round(vatAmount * 100) / 100,
      total: Math.round(totalInclusive * 100) / 100,
      ...(Object.keys(vatBreakdown).length > 0 ? { vat_breakdown: vatBreakdown } : {}),
      prices_include_vat: slotPricesIncludeVat,
      status: invoiceStatus,
      booking_ids: bookingIds,
      // M-33: structural split divisor (forward-only; legacy invoices stay
      // NULL and readers fall back to the "(1/N)" description marker).
      ...((requestedSplitAmongPlayers ?? splitAmongPlayers ?? 1) > 1
        ? { split_count: requestedSplitAmongPlayers ?? splitAmongPlayers }
        : {}),
      ...(allPaid ? { paid_at: new Date().toISOString(), sent_at: new Date().toISOString() } : {}),
    };

    let invoice: { id: string } | null = null;
    let insertError: { code?: string; message: string; details?: string } | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      invoicePayload.invoice_number = invoiceNumber;
      const res = await supabase.rpc("create_invoice_deduped", { _payload: invoicePayload });
      insertError = res.error;
      if (!insertError) {
        const result = res.data as {
          id: string;
          invoice_number: string;
          status: string;
          sent_at: string | null;
          booking_ids: string[] | null;
          total: number | null;
          deduped: boolean;
        } | null;
        // Overlap dedup won under the lock: an active invoice already bills one of these
        // bookings. Sync-to-paid if applicable and return it, same as the pre-check path.
        if (result?.deduped) {
          logStep("Duplicate invoice found under lock, skipping creation", {
            existingId: result.id,
            existingNumber: result.invoice_number,
          });
          await syncDedupedInvoiceToPaid({
            id: result.id,
            status: result.status,
            sent_at: result.sent_at,
            booking_ids: result.booking_ids ?? [],
            total: result.total ?? 0,
          });
          return new Response(
            JSON.stringify({ success: true, invoiceId: result.id, invoiceNumber: result.invoice_number, deduped: true }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        invoice = result ? { id: result.id } : null;
        break;
      }

      const errText = `${insertError.message ?? ""} ${(insertError as { details?: string }).details ?? ""}`;
      const isNumberCollision = insertError.code === "23505" &&
        /unique_invoice_number_per_(trainer|academy)/.test(errText);
      if (!isNumberCollision) break;
      logStep("Invoice number collision — reallocating", { invoiceNumber, attempt });
      invoiceNumber = await allocateInvoiceNumber();
    }

    if (insertError || !invoice) {
      // Race condition lost: unique index rejected the duplicate. Return the winning invoice.
      if (insertError && insertError.code === "23505") {
        const dupeFetch = supabase
          .from("invoices")
          .select("id, invoice_number, status, sent_at, booking_ids, total")
          .eq("trainer_id", trainerId)
          .not("status", "eq", "cancelled")
          .overlaps("booking_ids", bookingIds);
        // Recipient-scoped GUEST-FIRST — the SAME recipient rule as the RPC / the
        // fast-path above (dual-key belongs to the guest). This must NOT be
        // recipient-agnostic: the legacy uniq_invoice_active_player_bookings index
        // covers dual-key rows (its predicate is only `player_id IS NOT NULL`), so a
        // dual-key create can raise 23505 against a PROFILE invoice for the same exact
        // booking set — an agnostic lookup would then return + syncToPaid that
        // guest-owned booking onto the profile invoice the RPC deliberately refused.
        // When the winner isn't the create's own recipient the collision is
        // cross-recipient (a shape-change data inconsistency): no `winner` is found and
        // we fall through to throw + Slack-alert rather than mis-attribute + paid-flip.
        // Recipient scope is the shared, unit-tested guest-first helper. Cast to the
        // minimal query shape — the supabase-js builder's own type is too deep to pass
        // through a typed param (TS2589); it is mutated by reference in place.
        applyDedupRecipientScope(dupeFetch as unknown as RecipientScopableQuery, playerId, guestPlayerId);
        // overlaps can match >1 row; take the first so maybeSingle never throws.
        const { data: winner } = await dupeFetch.limit(1).maybeSingle();
        if (winner) {
          logStep("Race lost - returning existing invoice", { existingId: winner.id, existingNumber: winner.invoice_number });
          await syncDedupedInvoiceToPaid(winner);
          return new Response(
            JSON.stringify({ success: true, invoiceId: winner.id, invoiceNumber: winner.invoice_number, deduped: true }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }
      logStep("Failed to insert invoice", { error: insertError?.message ?? "unknown" });
      throw new Error(`Failed to create invoice: ${insertError?.message ?? "unknown"}`);
    }

    logStep("Invoice created", { invoiceId: invoice.id, invoiceNumber, status: invoiceStatus });

    // Generate PDF (skip for drafts to save resources — can be generated on demand)
    if (invoiceStatus !== "draft") {
      try {
        await supabase.functions.invoke("generate-invoice", {
          body: { invoiceId: invoice.id },
        });
        logStep("PDF generated");
      } catch (pdfErr) {
        logStep("PDF generation failed (non-fatal)", { error: String(pdfErr) });
      }
    }

    // Auto-forward invoice to configured bookkeeping emails. Non-fatal: the
    // invoice is already committed, so a forward failure must never 500.
    // M-30: the key was previously an undefined identifier here — the
    // ReferenceError was swallowed and accountants silently never received
    // forwarded invoices.
    const forwardEmails = invoiceProfile.invoice_forward_emails;
    if (allPaid && forwardEmails && forwardEmails.length > 0) {
      try {
        const supabaseServiceKey = getEnvServiceRoleKey();
        if (!supabaseServiceKey) {
          logStep("Invoice forwarding skipped (non-fatal)", { reason: "missing SUPABASE_SERVICE_ROLE_KEY" });
        } else {
          const forwardRes = await supabase.functions.invoke("forward-invoice", {
            body: { invoiceId: invoice.id },
            headers: {
              Authorization: `Bearer ${supabaseServiceKey}`,
              apikey: supabaseServiceKey,
            },
          });
          if (forwardRes.error) {
            logStep("Invoice forwarding failed (non-fatal)", { error: String(forwardRes.error) });
          } else {
            logStep("Invoice forwarded", { emails: forwardEmails.length, result: forwardRes.data });
          }
        }
      } catch (fwdErr) {
        logStep("Invoice forwarding failed (non-fatal)", { error: String(fwdErr) });
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        invoiceId: invoice.id,
        invoiceNumber,
        ...(incompleteBusinessProfile ? { incompleteBusinessProfile: true } : {}),
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    // Invoice minting can be reached server-side (cron, create-rebook-invoice) where no
    // client surfaces the failure to PostHog — alert so a money-path break is never silent.
    await notifySlackEdgeError("auto-create-invoice", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
