import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { resolveRegistrationNameFields } from "../_shared/profileName.ts";
import { evaluateManualPlayerAccess } from "../_shared/manual-player-access.ts";

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

    const {
      email,
      firstName,
      lastName,
      fullName,
      phone,
      ratingSystem,
      rating,
      cycleName,
      academyProfileId,
      trainerProfileId,
    } = await req.json();

    // Non-string name/email fields would reach .trim()/.toLowerCase() and throw a raw 500.
    const stringFields: Record<string, unknown> = { email, firstName, lastName, fullName };
    for (const [field, value] of Object.entries(stringFields)) {
      if (value != null && typeof value !== "string") {
        return new Response(
          JSON.stringify({ error: `Field '${field}' must be a string` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    const nameFields = resolveRegistrationNameFields({ firstName, lastName, fullName });

    if (!email || !nameFields.full_name) {
      return new Response(
        JSON.stringify({ error: "Email and name are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Authorization: if the caller attaches the player to a specific academy or
    // trainer, verify they control that context. Without this, any trainer or
    // club manager could inject guest-player rows into academies/trainers they
    // do not own. (The normal intake flow passes neither id.)
    let managesAcademy = false;
    if (academyProfileId) {
      const { data } = await supabaseUser.rpc("is_academy_manager", {
        _user_id: userId,
        _academy_profile_id: academyProfileId,
      });
      managesAcademy = !!data;
    }

    let controlsTrainer = false;
    if (trainerProfileId) {
      const { data: ownTrainer } = await supabaseAdmin
        .from("trainer_profiles")
        .select("id")
        .eq("id", trainerProfileId)
        .eq("user_id", userId)
        .maybeSingle();
      if (ownTrainer) {
        controlsTrainer = true;
      } else {
        // Or the caller manages an academy this trainer belongs to.
        const { data: links } = await supabaseAdmin
          .from("academy_trainers")
          .select("academy_profile_id")
          .eq("trainer_profile_id", trainerProfileId);
        for (const link of links || []) {
          const { data: manages } = await supabaseUser.rpc("is_academy_manager", {
            _user_id: userId,
            _academy_profile_id: link.academy_profile_id,
          });
          if (manages) {
            controlsTrainer = true;
            break;
          }
        }
      }
    }

    const access = evaluateManualPlayerAccess({
      academyProfileId,
      trainerProfileId,
      managesAcademy,
      controlsTrainer,
    });
    if (!access.ok) {
      return new Response(
        JSON.stringify({ error: "You do not control the target academy or trainer" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // The family rule: an address can be shared — a parent registering a child uses their own.
    // Attributing this player to an existing account because the addresses match is an identity
    // decision made on an email alone, which U2 removed (owner, 2026-08-09). The name has to agree,
    // and a profile with NO name agrees with nothing: `profiles.full_name` is nullable, so treating
    // an absent name as a match would make the guard bypassable by a valid row.
    const normalizeName = (s: string | null | undefined) =>
      (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

    const { data: existingProfile } = await supabaseAdmin
      .from("profiles")
      .select("id, full_name")
      .eq("email", email.toLowerCase())
      .maybeSingle();

    const profileNameAgrees = Boolean(existingProfile) &&
      normalizeName(existingProfile?.full_name) !== "" &&
      normalizeName(existingProfile?.full_name) === normalizeName(nameFields.full_name);

    let profileId: string | null = null;
    let guestPlayerId: string | null = null;
    let isNewUser = false;

    if (existingProfile && profileNameAgrees) {
      // User already has an account, and it is the same human by name as well as address
      profileId = existingProfile.id;
    } else {
      // Create a guest player record instead of an auth user
      isNewUser = true;

      const guestData: Record<string, unknown> = {
        first_name: nameFields.first_name,
        last_name: nameFields.last_name,
        full_name: nameFields.full_name,
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

      // Same rule for the guest side, and the same reason. `.maybeSingle()` was also wrong here:
      // the email index is deliberately non-unique (households), so two matches made it throw
      // PGRST116, the error was discarded, and a THIRD duplicate was inserted. Select the
      // candidates and pick by name — or by nobody.
      let existingGuest: { id: string } | null = null;
      let guestQuery = supabaseAdmin
        .from("guest_players")
        .select("id, full_name")
        .eq("email", email.toLowerCase());
      if (academyProfileId) guestQuery = guestQuery.eq("academy_profile_id", academyProfileId);
      else if (trainerProfileId) guestQuery = guestQuery.eq("trainer_id", trainerProfileId);
      else guestQuery = null as never;

      if (guestQuery) {
        const { data: candidates } = await guestQuery;
        const named = (candidates ?? []).filter(
          (g: { full_name: string | null }) =>
            normalizeName(g.full_name) === normalizeName(nameFields.full_name),
        );
        // exactly one name match, or nobody: several same-name rows on one address give no signal
        // that distinguishes them, and picking the first is a guess
        existingGuest = named.length === 1 ? { id: (named[0] as { id: string }).id } : null;
      }

      if (existingGuest) {
        guestPlayerId = existingGuest.id;
        // Update with latest info
        await supabaseAdmin
          .from("guest_players")
          .update({
            first_name: nameFields.first_name,
            last_name: nameFields.last_name,
            full_name: nameFields.full_name,
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
