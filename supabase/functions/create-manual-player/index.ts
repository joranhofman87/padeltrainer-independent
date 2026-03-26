import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Verify caller is authenticated
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await supabaseUser.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userId = claimsData.claims.sub;

    // Verify caller is a club manager or trainer
    const { data: isClubManager } = await supabaseUser.rpc("is_any_club_manager", { _user_id: userId });
    const { data: isTrainer } = await supabaseUser.rpc("is_trainer", { _user_id: userId });

    if (!isClubManager && !isTrainer) {
      return new Response(
        JSON.stringify({ error: "Only club managers or trainers can create manual player registrations" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { email, fullName, phone, ratingSystem, rating, cycleName, academyProfileId, trainerProfileId } = await req.json();

    if (!email || !fullName) {
      return new Response(
        JSON.stringify({ error: "Email and full name are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Check if a profile already exists with this email
    const { data: existingProfile } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("email", email.toLowerCase())
      .maybeSingle();

    let profileId: string | null = null;
    let guestPlayerId: string | null = null;
    let isNewUser = false;

    if (existingProfile) {
      // User already has an account
      profileId = existingProfile.id;
    } else {
      // Create a guest player record instead of an auth user
      isNewUser = true;

      const guestData: Record<string, unknown> = {
        full_name: fullName,
        email: email.toLowerCase(),
        phone: phone || null,
        skill_rating: rating || null,
        rating_system: ratingSystem || "knltb",
        source: "manual_registration",
      };

      if (academyProfileId) {
        guestData.academy_profile_id = academyProfileId;
      }
      if (trainerProfileId) {
        guestData.trainer_id = trainerProfileId;
      }

      // Check for existing guest with same email + context
      let existingGuest = null;
      if (academyProfileId) {
        const { data } = await supabaseAdmin
          .from("guest_players")
          .select("id")
          .eq("email", email.toLowerCase())
          .eq("academy_profile_id", academyProfileId)
          .maybeSingle();
        existingGuest = data;
      } else if (trainerProfileId) {
        const { data } = await supabaseAdmin
          .from("guest_players")
          .select("id")
          .eq("email", email.toLowerCase())
          .eq("trainer_id", trainerProfileId)
          .maybeSingle();
        existingGuest = data;
      }

      if (existingGuest) {
        guestPlayerId = existingGuest.id;
        // Update with latest info
        await supabaseAdmin
          .from("guest_players")
          .update({
            full_name: fullName,
            phone: phone || null,
            skill_rating: rating || null,
            rating_system: ratingSystem || "knltb",
          })
          .eq("id", guestPlayerId);
      } else {
        const { data: newGuest, error: guestError } = await supabaseAdmin
          .from("guest_players")
          .insert(guestData)
          .select("id")
          .single();

        if (guestError) {
          return new Response(
            JSON.stringify({ error: `Failed to create guest player: ${guestError.message}` }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        guestPlayerId = newGuest.id;
      }
    }

    // Send confirmation email to the player
    try {
      await supabaseAdmin.functions.invoke('send-email', {
        body: {
          type: 'intake_registration_confirmation',
          to: email,
          data: {
            playerName: fullName,
            cycleName: cycleName || '',
            isNewUser,
          },
        },
      });
    } catch (emailError) {
      console.error("Failed to send confirmation email:", emailError);
    }

    return new Response(
      JSON.stringify({
        profileId,
        guestPlayerId,
        isNewUser,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Error in create-manual-player:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
