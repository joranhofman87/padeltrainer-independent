import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";
import {
  claimIntakeForNotification,
  releaseIntakeAfterFailedSend,
} from "../_shared/schedule-notification-claim.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface ScheduleEntry {
  day: string;
  time: string;
  trainerName: string;
  location: string;
}

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

    console.log(`Sending schedule notifications for cycle: ${cycle_id}`);

    // 1. Fetch cycle details
    const { data: cycle, error: cycleError } = await supabaseAdmin
      .from("cycles")
      .select("*, location:locations(id, name, city)")
      .eq("id", cycle_id)
      .single();

    if (cycleError || !cycle) {
      return new Response(JSON.stringify({ error: "Cycle not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Get owner name for email signoff
    let ownerName = "PadelTrainer.ai Team";
    if (cycle.owner_type === "academy") {
      const { data: academy } = await supabaseAdmin
        .from("academy_profiles")
        .select("name")
        .eq("id", cycle.owner_id)
        .single();
      if (academy) ownerName = academy.name;
    } else if (cycle.owner_type === "trainer") {
      const { data: trainer } = await supabaseAdmin
        .from("trainer_profiles")
        .select("id, user_id, business_name")
        .eq("id", cycle.owner_id)
        .single();
      if (trainer) {
        // business_name takes precedence (matches the in-app trainer name resolver).
        if (trainer.business_name?.trim()) {
          ownerName = trainer.business_name.trim();
        } else {
          const { data: profile } = await supabaseAdmin
            .from("profiles")
            .select("full_name")
            .eq("user_id", trainer.user_id)
            .single();
          if (profile) ownerName = profile.full_name || ownerName;
        }
      }
    }

    // 2. Fetch all booked intake requests with guest_player details
    const { data: intakeRequests, error: irError } = await supabaseAdmin
      .from("intake_requests")
      .select("id, guest_player_id, player_id, email, full_name")
      .eq("cycle_id", cycle_id)
      .eq("status", "booked");

    if (irError) throw irError;

    if (!intakeRequests || intakeRequests.length === 0) {
      return new Response(JSON.stringify({ sent: 0, errors: [], message: "No booked intake requests found" }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // 3. Fetch all confirmed assignments for these intake requests
    const intakeIds = intakeRequests.map((ir: any) => ir.id);
    const { data: assignments, error: paError } = await supabaseAdmin
      .from("proposed_assignments")
      .select("intake_request_id, slot_id, trainer_id")
      .in("intake_request_id", intakeIds)
      .eq("status", "confirmed");

    if (paError) throw paError;

    // 4. Fetch slot details and trainer names
    const slotIds = [...new Set((assignments || []).map((a: any) => a.slot_id))];
    const trainerIds = [...new Set((assignments || []).map((a: any) => a.trainer_id))];

    const { data: slots } = await supabaseAdmin
      .from("availability_slots")
      .select("id, start_time, end_time, location_id, location:locations(name, city)")
      .in("id", slotIds);

    const slotMap = new Map((slots || []).map((s: any) => [s.id, s]));

    // Fetch trainer profiles
    const { data: trainerProfiles } = await supabaseAdmin
      .from("trainer_profiles")
      .select("id, user_id")
      .in("id", trainerIds);

    const trainerUserIds = (trainerProfiles || []).map((tp: any) => tp.user_id);
    const { data: trainerProfileData } = await supabaseAdmin
      .from("profiles")
      .select("user_id, full_name")
      .in("user_id", trainerUserIds);

    const trainerNameMap = new Map<string, string>();
    for (const tp of (trainerProfiles || [])) {
      const profile = (trainerProfileData || []).find((p: any) => p.user_id === tp.user_id);
      trainerNameMap.set(tp.id, profile?.full_name || "Trainer");
    }

    // 5. Group assignments by intake request (player)
    const assignmentsByIntake = new Map<string, any[]>();
    for (const a of (assignments || [])) {
      const list = assignmentsByIntake.get(a.intake_request_id) || [];
      list.push(a);
      assignmentsByIntake.set(a.intake_request_id, list);
    }

    // 6. Send emails per player
    const errors: string[] = [];
    let sent = 0;
    const locationName = cycle.location?.name
      ? `${cycle.location.name}${cycle.location.city ? `, ${cycle.location.city}` : ""}`
      : "";

    for (const ir of intakeRequests) {
      try {
        // P2-11: atomic per-row claim BEFORE any work. Flip this intake 'booked'→'notified' and
        // only proceed if THIS call won the row. A concurrent invocation (double-click / retry /
        // manual re-run) that SELECTed the same booked set will find status no longer 'booked' and
        // claim nothing → it does not send. This is what stops the double email; the old post-loop
        // bulk status update is gone (rows are flipped here, at claim time).
        const claimed = await claimIntakeForNotification(supabaseAdmin, ir.id);
        if (!claimed) continue; // already claimed by another run, or claim errored → don't send.

        const playerAssignments = assignmentsByIntake.get(ir.id) || [];
        // No confirmed assignment → nothing to email. Row stays 'notified' (matches prior behavior,
        // where such rows were also flipped by the post-loop bulk update) and won't be re-picked.
        if (playerAssignments.length === 0) continue;

        // Build schedule entries
        const scheduleEntries: ScheduleEntry[] = playerAssignments.map((a: any) => {
          const slot = slotMap.get(a.slot_id);
          const startDate = slot ? new Date(slot.start_time) : new Date();
          const endDate = slot ? new Date(slot.end_time) : new Date();
          const slotLocation = slot?.location?.name
            ? `${slot.location.name}${slot.location.city ? `, ${slot.location.city}` : ""}`
            : locationName;

          return {
            day: startDate.toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long" }),
            time: `${startDate.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })} - ${endDate.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}`,
            trainerName: trainerNameMap.get(a.trainer_id) || "Trainer",
            location: slotLocation,
          };
        });

        // Sort by date
        scheduleEntries.sort((a, b) => a.day.localeCompare(b.day));

        // Call send-email function internally
        const { error: emailError } = await supabaseAdmin.functions.invoke("send-email", {
          body: {
            type: "schedule_notification",
            to: ir.email,
            language: "nl",
            data: {
              playerName: ir.full_name,
              playerEmail: ir.email,
              cycleName: cycle.name,
              startDate: cycle.start_date,
              endDate: cycle.end_date,
              ownerName,
              locationName,
              scheduleEntries,
            },
          },
          headers: {
            Authorization: `Bearer ${supabaseServiceKey}`,
          },
        });

        if (emailError) {
          console.error(`Error sending email for intake request ${ir.id}:`, emailError);
          errors.push(`Failed to send to ${ir.email}: ${emailError.message}`);
          // Send failed AFTER we claimed the row → release it back to 'booked' so a later run
          // retries. Otherwise the player would be stuck 'notified' with no email ever sent.
          await releaseIntakeAfterFailedSend(supabaseAdmin, ir.id);
          continue;
        }

        sent++;
      } catch (err: any) {
        errors.push(`Error sending to ${ir.email}: ${err.message}`);
        // Same as above: an exception after the claim must release the row for retry.
        await releaseIntakeAfterFailedSend(supabaseAdmin, ir.id);
      }
    }

    // 7. Status is now flipped to 'notified' atomically per-row at claim time (P2-11), and reverted
    //    to 'booked' on a failed send. No post-loop bulk update — that was the source of the
    //    select-then-flip-later race that let overlapping invocations double-email every player.

    console.log(`Sent ${sent} schedule notifications, ${errors.length} errors`);

    // Partial failure: per-recipient sends that failed otherwise only hit the log
    // above (HTTP is still 200). Surface them so a systemic outage is visible.
    if (errors.length > 0) {
      await notifySlackEdgeError(
        "send-schedule-notifications",
        `${errors.length} schedule notification(s) failed (sent ${sent})`,
        { sent, errors },
      );
    }

    return new Response(
      JSON.stringify({ sent, errors }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  } catch (error: any) {
    console.error("Error in send-schedule-notifications:", error);
    // A thrown failure here means NO notifications went out. Alert ops.
    await notifySlackEdgeError(
      "send-schedule-notifications",
      error?.message ?? String(error),
    );
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
});
