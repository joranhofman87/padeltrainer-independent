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

    // 1. Fetch all intake_requests for this cycle where status = 'proposed'
    const { data: intakeRequests, error: irError } = await supabaseAdmin
      .from("intake_requests")
      .select("id, guest_player_id, player_id, status")
      .eq("cycle_id", cycle_id)
      .eq("status", "proposed");

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
    let bookingsCreated = 0;

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

        const { error: bookingError } = await supabaseAdmin
          .from("bookings")
          .insert(bookingData);

        if (bookingError) {
          console.error(`Error creating booking for assignment ${assignment.id}:`, bookingError);
          errors.push(`Booking failed for assignment ${assignment.id}: ${bookingError.message}`);
          continue;
        }

        bookingsCreated++;

        // Update assignment status to confirmed
        await supabaseAdmin
          .from("proposed_assignments")
          .update({ status: "confirmed" })
          .eq("id", assignment.id);
      } catch (err: any) {
        errors.push(`Error processing assignment ${assignment.id}: ${err.message}`);
      }
    }

    // 4. Update intake_requests status to 'booked'
    const { error: updateError } = await supabaseAdmin
      .from("intake_requests")
      .update({ status: "booked" as any })
      .in("id", intakeIds);

    if (updateError) {
      console.error("Error updating intake requests:", updateError);
      errors.push(`Failed to update intake request statuses: ${updateError.message}`);
    }

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

      // Re-query confirmed bookings for this cycle's slots
      const { data: slots } = await supabaseAdmin
        .from("availability_slots")
        .select("id")
        .eq("cyclus_id", cycle_id);

      if (slots && slots.length > 0) {
        const slotIds = slots.map((s: any) => s.id);

        const { data: newBookings } = await supabaseAdmin
          .from("bookings")
          .select("id, player_id, guest_player_id")
          .in("slot_id", slotIds)
          .eq("status", "confirmed")
          .eq("payment_status", "pending");

        if (newBookings && newBookings.length > 0) {
          // Group by player
          const playerBookings = new Map<string, string[]>();
          for (const b of newBookings) {
            const key = b.player_id || b.guest_player_id;
            if (!key) continue;
            const existing = playerBookings.get(key) || [];
            existing.push(b.id);
            playerBookings.set(key, existing);
          }

          const totalUniquePlayers = playerBookings.size;

          for (const [playerId, bookingIds] of playerBookings) {
            try {
              const invoiceBody: Record<string, unknown> = { bookingIds };
              if (isSplitPayment && totalUniquePlayers > 1) {
                invoiceBody.splitAmongPlayers = totalUniquePlayers;
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
