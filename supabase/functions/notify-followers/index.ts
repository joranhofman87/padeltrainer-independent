import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface NotifyRequest {
  trainer_id: string;
  slot_count: number;
  date_range: string;
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { trainer_id, slot_count, date_range }: NotifyRequest = await req.json();

    if (!trainer_id || !slot_count) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: trainer_id, slot_count" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get trainer info
    const { data: trainerProfile } = await supabase
      .from("trainer_profiles")
      .select("id, user_id")
      .eq("id", trainer_id)
      .single();

    if (!trainerProfile) {
      return new Response(
        JSON.stringify({ error: "Trainer not found" }),
        { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

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
            type: "new_availability",
            to: player.email,
            data: {
              playerName: player.full_name || "Player",
              trainerName,
              slotCount: slot_count,
              dateRange: date_range,
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

    console.log(`Notified ${sentCount} followers about new availability`);
    if (errors.length > 0) {
      console.error("Email errors:", errors);
    }

    return new Response(
      JSON.stringify({ 
        message: `Notified ${sentCount} followers`, 
        sent: sentCount,
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
