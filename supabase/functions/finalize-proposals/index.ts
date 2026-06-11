import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { canManageCycle, isAdminUser } from "../_shared/cycle-access.ts";

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

    // 1. ATOMICALLY claim the proposed intake requests by flipping them to
    // 'booked' in a single UPDATE ... WHERE status='proposed' RETURNING. Postgres
    // row-locks each matched row, so when two admins finalize the same cycle at
    // once each call only receives the rows IT actually transitioned — neither
    // reprocesses the other's intake requests (was: both read status='proposed'
    // and both created bookings + invoices → duplicates).
    const { data: intakeRequests, error: irError } = await supabaseAdmin
      .from("intake_requests")
      .update({ status: "booked" as any })
      .eq("cycle_id", cycle_id)
      .eq("status", "proposed")
      .select("id, guest_player_id, player_id");

    if (irError) throw irError;

    if (!intakeRequests || intakeRequests.length === 0) {
      return new Response(JSON.stringify({ booked: 0, bookings_created: 0, errors: [], message: "No proposed intake requests found" }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const intakeIds = intakeRequests.map((ir: any) => ir.id);

    // 2. Fetch all proposed_assignments for these intake requests
    const { data: assignments, error: paError } = await supabaseAdmin
      .from("proposed_assignments")
      .select("id, intake_request_id, slot_id, trainer_id, status")
      .in("intake_request_id", intakeIds)
      .eq("status", "proposed");

    if (paError) throw paError;

    const errors: string[] = [];
    // Bookings THIS run actually created — the invoicing step bills only these,
    // never a blind re-query of every pending booking on the cycle's slots.
    const createdBookings: {
      id: string;
      player_id: string | null;
      guest_player_id: string | null;
      slot_id: string;
    }[] = [];

    // 3. For each assignment, create a booking and confirm the assignment
    for (const assignment of (assignments || [])) {
      try {
        const intakeRequest = intakeRequests.find((ir: any) => ir.id === assignment.intake_request_id);
        if (!intakeRequest) continue;

        // Create booking record
        const bookingData: any = {
          slot_id: assignment.slot_id,
          status: "confirmed",
          payment_status: "pending",
        };

        // Link to guest_player or registered player
        if (intakeRequest.guest_player_id) {
          bookingData.guest_player_id = intakeRequest.guest_player_id;
        }
        if (intakeRequest.player_id) {
          bookingData.player_id = intakeRequest.player_id;
        }

        const { data: createdBooking, error: bookingError } = await supabaseAdmin
          .from("bookings")
          .insert(bookingData)
          .select("id, player_id, guest_player_id, slot_id")
          .single();

        if (bookingError || !createdBooking) {
          console.error(`Error creating booking for assignment ${assignment.id}:`, bookingError);
          errors.push(`Booking failed for assignment ${assignment.id}: ${bookingError?.message ?? "unknown"}`);
          continue;
        }

        createdBookings.push(createdBooking);

        // Update assignment status to confirmed
        await supabaseAdmin
          .from("proposed_assignments")
          .update({ status: "confirmed" })
          .eq("id", assignment.id);
      } catch (err: any) {
        errors.push(`Error processing assignment ${assignment.id}: ${err.message}`);
      }
    }

    const bookingsCreated = createdBookings.length;
    // intake_requests are already 'booked' from the atomic claim in step 1.

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

          for (const [playerId, bookingIds] of playerBookings) {
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
                errors.push(`Invoice failed for player ${playerId}: ${String(invoiceRes.error)}`);
              } else {
                invoicesCreated++;
                console.log(`Invoice created for player ${playerId} (${bookingIds.length} bookings)`);
              }
            } catch (err: any) {
              console.error(`Invoice error for player ${playerId}:`, err.message);
              errors.push(`Invoice error for player ${playerId}: ${err.message}`);
            }
          }
        }
      }
    } else if (paymentTiming !== "upfront") {
      console.log(`Skipping invoice generation: payment_timing=${paymentTiming}`);
    }

    console.log(`Finalized: ${intakeRequests.length} intake requests, ${bookingsCreated} bookings created, ${invoicesCreated} invoices created`);

    return new Response(
      JSON.stringify({
        booked: intakeRequests.length,
        bookings_created: bookingsCreated,
        invoices_created: invoicesCreated,
        errors,
      }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  } catch (error: any) {
    console.error("Error in finalize-proposals:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
});
