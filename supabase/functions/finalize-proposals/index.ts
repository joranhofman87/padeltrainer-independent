import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { canManageCycle, isAdminUser } from "../_shared/cycle-access.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Verify authentication
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Verify user
    const token = authHeader.replace("Bearer ", "");
    const isServiceRole = token === supabaseServiceKey;
    if (!isServiceRole) {
      const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
      if (authError || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    const { cycle_id } = await req.json();
    if (!cycle_id) {
      return new Response(JSON.stringify({ error: "cycle_id is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const { data: cycleRow, error: cycleError } = await supabaseAdmin
      .from("cycles")
      .select("id, owner_type, owner_id")
      .eq("id", cycle_id)
      .single();

    if (cycleError || !cycleRow) {
      return new Response(JSON.stringify({ error: "Cycle not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (!isServiceRole) {
      const { data: { user: caller } } = await supabaseAdmin.auth.getUser(token);
      if (!caller) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const isAdmin = await isAdminUser(supabaseAdmin, caller.id);
      const canManage = isAdmin || await canManageCycle(supabaseAdmin, caller.id, cycleRow);

      if (!canManage) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    console.log(`Finalizing proposals for cycle: ${cycle_id}`);

    const errors: string[] = [];

    // 1-3. ATOMIC: claim the proposed intakes (→'booked'), create one booking per proposed
    // assignment, and confirm those assignments — all in ONE transaction inside the
    // finalize_cycle_proposals RPC. All-or-nothing: a crash or a failing booking INSERT rolls the
    // whole thing back (intakes stay 'proposed', no bookings) so the caller can safely re-run. This
    // closes the previous orphan window where the claim flipped intakes to 'booked' first and a
    // mid-way failure left them booked with no bookings + no way to re-finalize. Concurrency is
    // unchanged: two finalizes of the same cycle contend on the claim UPDATE; the loser claims zero.
    // Invoicing (step 5) deliberately stays out here — it is an HTTP invoke and is re-runnable.
    const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc(
      "finalize_cycle_proposals" as any,
      { p_cycle_id: cycle_id } as any,
    );

    if (rpcError) throw rpcError;

    const finalizeResult = (rpcResult ?? {}) as {
      booked_intakes?: number;
      bookings?: { id: string; player_id: string | null; guest_player_id: string | null; slot_id: string }[];
    };
    const bookedIntakes = finalizeResult.booked_intakes ?? 0;
    // Bookings THIS run actually created — the invoicing step bills only these, never a blind
    // re-query of every pending booking on the cycle's slots.
    const createdBookings = finalizeResult.bookings ?? [];

    if (bookedIntakes === 0) {
      return new Response(JSON.stringify({ booked: 0, bookings_created: 0, errors: [], message: "No proposed intake requests found" }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const bookingsCreated = createdBookings.length;
    // intake_requests are already 'booked' from the atomic claim in the RPC.

    // 5. Auto-generate invoices for upfront payment cycles
    let invoicesCreated = 0;

    // Fetch cycle settings to determine payment timing
    const { data: cycle } = await supabaseAdmin
      .from("cycles")
      .select("settings")
      .eq("id", cycle_id)
      .single();

    const settings = (cycle?.settings as Record<string, unknown>) || {};
    const paymentTiming = settings.payment_timing || (settings.mark_as_paid ? "manual" : "upfront");
    const isSplitPayment = settings.split_payment === true;

    if (paymentTiming === "upfront" && bookingsCreated > 0) {
      console.log("Generating invoices for upfront cycle...");

      // Invoice ONLY the bookings this finalize run created — never a blanket
      // re-query of every confirmed+pending booking on the cycle's slots, which
      // swept in already-invoiced commitment bookings and manually-added players
      // and re-billed them.
      const newBookings = createdBookings;

      {
        if (newBookings.length > 0) {
          // Distinct players sharing each slot = the real "group" for splitting.
          const slotPlayers = new Map<string, Set<string>>();
          for (const b of newBookings) {
            const key = b.player_id || b.guest_player_id;
            if (!key) continue;
            const set = slotPlayers.get(b.slot_id) ?? new Set<string>();
            set.add(key);
            slotPlayers.set(b.slot_id, set);
          }

          // Group by player → their booking ids and the slots they're on.
          const playerBookings = new Map<string, string[]>();
          const playerSlots = new Map<string, Set<string>>();
          for (const b of newBookings) {
            const key = b.player_id || b.guest_player_id;
            if (!key) continue;
            const ids = playerBookings.get(key) || [];
            ids.push(b.id);
            playerBookings.set(key, ids);
            const slots = playerSlots.get(key) ?? new Set<string>();
            slots.add(b.slot_id);
            playerSlots.set(key, slots);
          }

          // A player's split divisor is the size of THEIR group (the distinct
          // players sharing their slots), not the whole-cycle headcount. With two
          // independent groups of 4 on different slots the old code divided by 8
          // and collected half — now each group correctly pays price/4.
          const groupSizeFor = (playerKey: string): number => {
            const coPlayers = new Set<string>();
            for (const slotId of playerSlots.get(playerKey) ?? []) {
              for (const p of slotPlayers.get(slotId) ?? []) coPlayers.add(p);
            }
            return coPlayers.size || 1;
          };

          // Players who paid (or were invoiced) at registration: their sign-up
          // invoice REPLACES the finalize invoice — never double-charge. Keyed
          // on the intake's invoice_id (unambiguous vs. finalize-made invoices).
          const regInvoiceIdByKey = new Map<string, string>();
          {
            const { data: regIntakes } = await supabaseAdmin
              .from("intake_requests")
              .select("player_id, guest_player_id, invoice_id")
              .eq("cycle_id", cycle_id)
              .not("invoice_id", "is", null);
            for (const r of regIntakes ?? []) {
              const key = (r as { player_id: string | null; guest_player_id: string | null }).player_id
                || (r as { guest_player_id: string | null }).guest_player_id;
              const invId = (r as { invoice_id: string | null }).invoice_id;
              if (key && invId) regInvoiceIdByKey.set(key, invId);
            }
          }

          for (const [playerId, bookingIds] of playerBookings) {
            // Sign-up invoice replaces the finalize invoice (unless it was cancelled).
            const regInvoiceId = regInvoiceIdByKey.get(playerId);
            if (regInvoiceId) {
              const { data: regInv } = await supabaseAdmin
                .from("invoices").select("status, booking_ids").eq("id", regInvoiceId).single();
              if (regInv && regInv.status !== "cancelled") {
                try {
                  const merged = Array.from(new Set([...((regInv.booking_ids as string[] | null) ?? []), ...bookingIds]));
                  await supabaseAdmin.from("invoices").update({ booking_ids: merged }).eq("id", regInvoiceId);
                  if (regInv.status === "paid") {
                    await supabaseAdmin.from("bookings").update({ payment_status: "paid" }).in("id", bookingIds);
                  }
                } catch (recErr) {
                  console.error(`Reconcile failed for player ${playerId}:`, recErr);
                  await notifySlackEdgeError("finalize-proposals", `sign-up invoice reconcile failed for player ${playerId}`, { playerId, error: String(recErr) });
                }
                console.log(`Skipped finalize invoice for player ${playerId} — sign-up invoice ${regInvoiceId}`);
                continue;
              }
              // cancelled sign-up invoice → fall through to normal finalize invoicing
            }
            try {
              const invoiceBody: Record<string, unknown> = { bookingIds };
              const groupSize = groupSizeFor(playerId);
              if (isSplitPayment && groupSize > 1) {
                invoiceBody.splitAmongPlayers = groupSize;
              }

              const invoiceRes = await supabaseAdmin.functions.invoke("auto-create-invoice", {
                body: invoiceBody,
              });

              if (invoiceRes.error) {
                console.error(`Invoice creation failed for player ${playerId}:`, String(invoiceRes.error));
                errors.push(`Invoice failed for player ${playerId}`);
              } else {
                invoicesCreated++;
                console.log(`Invoice created for player ${playerId} (${bookingIds.length} bookings)`);
              }
            } catch (err) {
              console.error(`Invoice error for player ${playerId}:`, err);
              errors.push(`Invoice error for player ${playerId}`);
            }
          }
        }
      }
    } else if (paymentTiming !== "upfront") {
      console.log(`Skipping invoice generation: payment_timing=${paymentTiming}`);
    }

    console.log(`Finalized: ${bookedIntakes} intake requests, ${bookingsCreated} bookings created, ${invoicesCreated} invoices created`);

    // One aggregate alert per run when any player was booked but their invoice
    // mint failed (booked-but-unbilled) — no per-player flood for large cohorts.
    if (errors.length > 0) {
      await notifySlackEdgeError("finalize-proposals", `${errors.length} player invoice failure(s) during finalize (booked but unbilled)`, {
        errors: errors.slice(0, 10),
        booked: bookedIntakes,
        invoices_created: invoicesCreated,
      });
    }

    return new Response(
      JSON.stringify({
        booked: bookedIntakes,
        bookings_created: bookingsCreated,
        invoices_created: invoicesCreated,
        errors,
      }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  } catch (error) {
    // Raw DB error text (column/constraint names) stays in logs only.
    console.error("Error in finalize-proposals:", error);
    // A throw here (e.g. the atomic finalize RPC failing) means the whole
    // cohort failed to book. The caller may be service-role/automation with no
    // human watching the 500, so alert it — this is the most consequential
    // silent money-path failure in this function.
    await notifySlackEdgeError("finalize-proposals", error instanceof Error ? error.message : String(error));
    return new Response(
      JSON.stringify({ error: "Failed to finalize proposals" }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
});
