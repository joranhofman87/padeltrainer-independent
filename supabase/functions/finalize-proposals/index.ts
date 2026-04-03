import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

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

    console.log(`Finalized: ${intakeRequests.length} intake requests, ${bookingsCreated} bookings created`);

    return new Response(
      JSON.stringify({
        booked: intakeRequests.length,
        bookings_created: bookingsCreated,
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
