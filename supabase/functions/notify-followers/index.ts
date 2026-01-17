import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface NotifyRequest {
  slot_count: number;
  date_range: string;
  single_slot?: {
    date: string;
    time: string;
  };
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    
    // Verify authentication
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      console.error("No authorization header provided");
      return new Response(
        JSON.stringify({ error: "Authentication required" }),
        { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Create client to verify user token
    const supabaseAuth = createClient(supabaseUrl, supabaseServiceKey);
    const token = authHeader.replace("Bearer ", "");
    
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(token);
    
    if (authError || !user) {
      console.error("Authentication failed:", authError?.message);
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Create service role client for database operations
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get trainer profile from authenticated user - DO NOT trust trainer_id from request body
    const { data: trainerProfile, error: trainerError } = await supabase
      .from("trainer_profiles")
      .select("id, user_id")
      .eq("user_id", user.id)
      .single();

    if (trainerError || !trainerProfile) {
      console.error("User is not a trainer:", trainerError?.message);
      return new Response(
        JSON.stringify({ error: "Only trainers can notify followers" }),
        { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const trainer_id = trainerProfile.id;
    const { slot_count, date_range, single_slot }: NotifyRequest = await req.json();

    if (!slot_count) {
      return new Response(
        JSON.stringify({ error: "Missing required field: slot_count" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const isReopenedSlot = !!single_slot;

    // Get trainer's name
    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("user_id", trainerProfile.user_id)
      .single();

    const trainerName = profile?.full_name || "Your trainer";

    // Get followers who want notifications
    const { data: followers } = await supabase
      .from("trainer_followers")
      .select(`
        player_id,
        notify_new_availability
      `)
      .eq("trainer_id", trainer_id)
      .eq("notify_new_availability", true);

    if (!followers || followers.length === 0) {
      return new Response(
        JSON.stringify({ message: "No followers to notify", sent: 0 }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Get player info and their notification preferences
    const playerIds = followers.map((f) => f.player_id);
    
    const { data: players } = await supabase
      .from("profiles")
      .select("id, user_id, email, full_name")
      .in("id", playerIds);

    if (!players || players.length === 0) {
      return new Response(
        JSON.stringify({ message: "No players found", sent: 0 }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Check global notification preferences
    const userIds = players.map((p) => p.user_id);
    const { data: preferences } = await supabase
      .from("notification_preferences")
      .select("user_id, email_new_availability")
      .in("user_id", userIds);

    const prefMap = new Map(preferences?.map((p) => [p.user_id, p.email_new_availability]) || []);

    // Filter players who have global notifications enabled (or no preference set = default true)
    const playersToNotify = players.filter((p) => {
      const pref = prefMap.get(p.user_id);
      return pref === undefined || pref === true;
    });

    if (playersToNotify.length === 0) {
      return new Response(
        JSON.stringify({ message: "All followers have disabled notifications", sent: 0 }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Send emails via the send-email function
    let sentCount = 0;
    const errors: string[] = [];

    // Determine email type based on whether it's a reopened slot
    const emailType = isReopenedSlot ? "slot_reopened" : "new_availability";

    for (const player of playersToNotify) {
      if (!player.email) continue;

      try {
        const emailRes = await fetch(`${supabaseUrl}/functions/v1/send-email`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({
            type: emailType,
            to: player.email,
            data: {
              playerName: player.full_name || "Player",
              trainerName,
              slotCount: slot_count,
              dateRange: date_range,
              ...(single_slot && {
                slotDate: single_slot.date,
                slotTime: single_slot.time,
              }),
            },
          }),
        });

        if (emailRes.ok) {
          sentCount++;
        } else {
          const errText = await emailRes.text();
          errors.push(`Failed to email ${player.email}: ${errText}`);
        }
      } catch (err: any) {
        errors.push(`Error emailing ${player.email}: ${err.message}`);
      }
    }

    console.log(`Notified ${sentCount} followers about ${isReopenedSlot ? 'reopened slot' : 'new availability'}`);
    if (errors.length > 0) {
      console.error("Email errors:", errors);
    }

    return new Response(
      JSON.stringify({ 
        message: `Notified ${sentCount} followers`, 
        sent: sentCount,
        type: isReopenedSlot ? 'reopened_slot' : 'new_availability',
        errors: errors.length > 0 ? errors : undefined 
      }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  } catch (error: any) {
    console.error("Error in notify-followers function:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
};

serve(handler);
